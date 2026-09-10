// <cup-viewer> — a rotatable 3D cup.
//
//   <script type="module" src="cup-viewer.js"></script>
//   <cup-viewer cup="woodgrain-16oz-hot"
//               texture="textures/16oz-hot-abstract.png"
//               lid="black" rim-color="#FE5000" fill="dark" autorotate></cup-viewer>
//
// Only dependency is three.js core from a pinned CDN URL — no import map, no
// addons, no build step. Drop these two files plus textures/ into any page.
//
// fill takes "dark", "light", "none" or any CSS colour; fill-level is 0-1 of the
// cup's height and defaults to 0.88.
//
// cup / texture / lid / material / rim-color / fill are all live: setting one swaps the
// model or the artwork in place without tearing down the WebGL context, which is
// what makes tabbed switching cheap.

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
// Carry this module's cache-busting version through to its data, or a stale
// cup-specs.js silently costs you every cup added since it was cached.
const _V = new URL(import.meta.url).searchParams.get('v');
const { CUPS } = await import('./cup-specs.js' + (_V ? `?v=${_V}` : ''));

const S = 0.1;                       // mm -> scene units

// Sip lid profile for a 45 mm rim, [radius, height] in mm, revolved.
const LID_PROFILE = [
  // raised drinking dome
  [0, 13.6], [5, 13.5], [10, 13.1], [15, 12.4], [19, 11.6],
  // step down to the shoulder
  [22, 10.6], [24.5, 9.2], [26, 7.8],
  // shoulder sloping out to the skirt
  [29, 7.0], [33, 6.2], [37, 5.2], [40.5, 4.0],
  [43.5, 2.6], [45.8, 1.2], [47.4, -0.3], [48.1, -1.9],
  // outer skirt — must clear the rolled rim, which reaches 46.8 mm
  [48.4, -3.6], [48.5, -5.4], [48.2, -7.0], [47.8, -8.2], [47.2, -8.4],
  // under the skirt and back up inside, past the bead that grips the rim
  [47.0, -7.6], [47.0, -5.5], [47.0, -3.5], [47.15, -2.0], [47.4, -0.9],
  // back across the underside
  [47.0, 0.3], [45.2, 1.6], [42, 3.2], [37, 4.6], [32, 5.8], [27.5, 6.8],
  [25, 8.2], [22.5, 9.8], [19, 11.0], [14, 11.9], [7, 12.4], [0, 12.6],
];

function envMap(renderer) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0.00, '#ffffff');
  g.addColorStop(0.36, '#eae7e2');
  g.addColorStop(0.56, '#9b9995');
  g.addColorStop(1.00, '#3b3a37');
  x.fillStyle = g; x.fillRect(0, 0, 512, 256);
  for (const [cxp, cyp, r, a] of [[140, 66, 92, 1], [386, 104, 74, 0.5]]) {
    const s = x.createRadialGradient(cxp, cyp, 4, cxp, cyp, r);
    s.addColorStop(0, `rgba(255,255,255,${a})`);
    s.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = s; x.fillRect(0, 0, 256 * 2, 256);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  const pm = new THREE.PMREMGenerator(renderer);
  const rt = pm.fromEquirectangular(tex);
  tex.dispose(); pm.dispose();
  return rt.texture;
}

function shadowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(128, 128, 6, 128, 128, 122);
  g.addColorStop(0.00, 'rgba(0,0,0,0.46)');
  g.addColorStop(0.45, 'rgba(0,0,0,0.20)');
  g.addColorStop(1.00, 'rgba(0,0,0,0)');
  x.fillStyle = g; x.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

class CupViewer extends HTMLElement {
  static observedAttributes = ['cup', 'texture', 'transmission-texture', 'lid',
                               'material', 'rim-color', 'fill', 'fill-level'];

  connectedCallback() {
    if (this._built) return;
    this._built = true;

    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      :host { display:block; position:relative; width:100%; aspect-ratio:4/5;
              touch-action:none; contain:layout paint; }
      canvas { display:block; width:100%; height:100%; outline:none; }
      .hint { position:absolute; left:50%; bottom:10px; transform:translateX(-50%);
              font:500 11px/1 ui-sans-serif,system-ui,sans-serif; letter-spacing:.09em;
              text-transform:uppercase; color:currentColor; opacity:.42;
              pointer-events:none; transition:opacity .5s; }
      .hint[hidden] { display:block; opacity:0; }
    </style><div class="hint">Drag to rotate</div>`;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.02;
    root.appendChild(renderer.domElement);
    this._renderer = renderer;
    this._render = () => { this._dirty = true; };

    const scene = new THREE.Scene();
    scene.environment = envMap(renderer);
    const bg = this.getAttribute('bg');
    if (bg) scene.background = new THREE.Color(bg);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x6b6560, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(-6, 14, 11); scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(9, 5, -7); scene.add(fill);

    const cup = new THREE.Group();
    cup.rotation.y = Math.PI;          // put the blank seam at the back
    scene.add(cup);

    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true,
        depthWrite: false, opacity: 0.85 }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.002;
    scene.add(shadow);

    const camera = new THREE.PerspectiveCamera(30, 1, 0.5, 400);
    const target = new THREE.Vector3(0, 7, 0);

    Object.assign(this, { _scene: scene, _camera: camera, _target: target,
                          _cupGroup: cup, _shadow: shadow });

    const num = (name, dflt) => {
      const v = parseFloat(this.getAttribute(name));
      return Number.isFinite(v) ? v : dflt;
    };
    this._distFactor = num('distance', 2.5);
    let az = num('azimuth', 0) * Math.PI / 180,
        pol = num('polar', 74) * Math.PI / 180,
        dist = 34;
    let vaz = 0, vpol = 0, dragging = false, px = 0, py = 0, idle = 0;
    const spin = this.hasAttribute('autorotate');
    const hint = root.querySelector('.hint');

    const place = () => {
      camera.position.set(
        target.x + dist * Math.sin(pol) * Math.sin(az),
        target.y + dist * Math.cos(pol),
        target.z + dist * Math.sin(pol) * Math.cos(az));
      camera.lookAt(target);
    };
    this._reframe = (h) => {
      target.set(0, h * 0.52, 0);
      dist = h * this._distFactor;
      this._minD = h * 1.7; this._maxD = h * 4.2;
      place(); this._render();
    };

    const el = renderer.domElement;
    el.addEventListener('pointerdown', (e) => {
      dragging = true; idle = 0; px = e.clientX; py = e.clientY;
      el.setPointerCapture(e.pointerId); hint.hidden = true;
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      vaz = -(e.clientX - px) * 0.0072;
      vpol = -(e.clientY - py) * 0.0050;
      px = e.clientX; py = e.clientY;
      az += vaz; pol = Math.min(1.86, Math.max(0.92, pol + vpol));
      this._render();
    });
    const stop = (e) => {
      if (!dragging) return;
      dragging = false;
      try { el.releasePointerCapture(e.pointerId); } catch {}
    };
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointercancel', stop);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      dist = Math.min(this._maxD, Math.max(this._minD,
        dist * (1 + Math.sign(e.deltaY) * 0.09)));
      this._render();
    }, { passive: false });

    this._tick = (dt) => {
      let moved = false;
      if (!dragging) {
        if (Math.abs(vaz) > 1e-5 || Math.abs(vpol) > 1e-5) {
          az += vaz; pol = Math.min(1.86, Math.max(0.92, pol + vpol));
          vaz *= 0.90; vpol *= 0.90; moved = true;
        } else { vaz = vpol = 0; idle += dt; }
        if (spin && idle > 2.2) { az += dt * 0.36; moved = true; }
      }
      if (moved || this._dirty) { place(); renderer.render(scene, camera); this._dirty = false; }
    };

    this._buildCup();
    this._loadTexture();

    const ro = new ResizeObserver(() => {
      const w = this.clientWidth, ht = this.clientHeight;
      if (!w || !ht) return;                       // hidden tab: skip
      renderer.setSize(w, ht, false);
      camera.aspect = w / ht; camera.updateProjectionMatrix();
      this._render();
    });
    ro.observe(this); this._ro = ro;

    let last = performance.now(), raf = 0;
    const loop = (t) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (t - last) / 1000); last = t;
      this._tick(dt);
    };
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !raf) { last = performance.now(); raf = requestAnimationFrame(loop); }
      else if (!e.isIntersecting && raf) { cancelAnimationFrame(raf); raf = 0; }
    }, { rootMargin: '120px' });
    io.observe(this); this._io = io;
    this._stop = () => { if (raf) cancelAnimationFrame(raf); raf = 0; };
  }

  attributeChangedCallback(name, oldV, newV) {
    if (!this._built || oldV === newV) return;
    if (name === 'texture' || name === 'transmission-texture') {
      this._loadTexture(); return;
    }
    // switching tabs changes several attributes at once — coalesce the rebuild
    if (this._pendingBuild) return;
    this._pendingBuild = true;
    queueMicrotask(() => { this._pendingBuild = false; this._buildCup(); });
  }

  _loadTexture() {
    const load = (url, srgb, key) => {
      if (!url) {
        if (this[key]) { this[key].dispose(); this[key] = null; this._applyTexture(); }
        return;
      }
      new THREE.TextureLoader().load(url, (t) => {
        // a transmission map is data, not colour, so it stays linear
        if (srgb) t.colorSpace = THREE.SRGBColorSpace;
        t.wrapS = THREE.RepeatWrapping;
        t.anisotropy = this._renderer.capabilities.getMaxAnisotropy();
        this[key]?.dispose();
        this[key] = t;
        this._applyTexture();
      });
    };
    load(this.getAttribute('texture'), true, '_tex');
    load(this.getAttribute('transmission-texture'), false, '_transTex');
  }

  _applyTexture() {
    if (!this._body) return;
    const m = this._body.material;
    m.map = this._tex || null;
    if (m.isMeshPhysicalMaterial) m.transmissionMap = this._transTex || null;
    m.needsUpdate = true;
    this._render();
  }

  _buildCup() {
    const slug = this.getAttribute('cup') || 'woodgrain-16oz-hot';
    const cup = this._cupGroup;
    for (const child of [...cup.children]) {
      cup.remove(child);
      child.geometry?.dispose();
      child.material?.dispose();
    }

    const spec = CUPS[slug];
    if (!spec) {
      // clear first, then bail — leaving the previous cup standing would show
      // the wrong model wearing the new artwork, which reads as correct
      console.error(`cup-viewer: unknown cup "${slug}" — known: ${Object.keys(CUPS).join(', ')}`);
      this._body = null; this._render();
      return;
    }

    const rTop = spec.topDia / 2 * S;
    const rBot = spec.bottomDia / 2 * S;
    const h = spec.height * S;
    const clear = this.getAttribute('material') === 'clear';

    // built fresh each time rather than cloned from the body: the body picks up
    // the artwork map, and a clone made after that would carry it onto the rim
    const clearMat = () => new THREE.MeshPhysicalMaterial({
      color: 0xffffff, transmission: 0.99, thickness: 0.12, roughness: 0.025,
      ior: 1.54, metalness: 0, transparent: true, side: THREE.DoubleSide });

    const bodyMat = clear ? clearMat()
      : new THREE.MeshStandardMaterial({ roughness: 0.78, metalness: 0 });

    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(rTop, rBot, h, 192, 1, true), bodyMat);
    body.position.y = h / 2;
    cup.add(body);
    this._body = body;
    this._applyTexture();

    if (clear) {
      const base = new THREE.Mesh(new THREE.CircleGeometry(rBot * 0.99, 64),
        clearMat());
      base.rotation.x = -Math.PI / 2;
      base.position.y = h * 0.012;
      cup.add(base);
    } else {
      const liner = new THREE.Mesh(
        new THREE.CylinderGeometry(rTop * 0.995, rBot * 0.99, h, 96, 1, true),
        new THREE.MeshStandardMaterial({ color: 0xf3efe8, roughness: 0.92,
          metalness: 0, side: THREE.BackSide }));
      liner.position.y = h / 2;
      cup.add(liner);

      const base = new THREE.Mesh(new THREE.CircleGeometry(rBot * 0.99, 64),
        new THREE.MeshStandardMaterial({ color: 0xece7df, roughness: 0.95 }));
      base.rotation.x = -Math.PI / 2;
      base.position.y = h * 0.012;
      cup.add(base);
    }

    // liquid: a plain solid following the cup's inner cone. No refraction or
    // surface simulation — it is there to judge how the artwork reads against a
    // filled cup, which matters most on the clear one.
    const fill = this.getAttribute('fill');
    if (fill && fill !== 'none') {
      const raw = parseFloat(this.getAttribute('fill-level'));
      const lvl = Number.isFinite(raw) ? Math.min(0.97, Math.max(0.05, raw)) : 0.88;
      const rl = (rBot + (rTop - rBot) * lvl) * 0.985;
      const preset = { dark: 0x30200f, light: 0xdcc7a2 };
      const liquid = new THREE.Mesh(
        new THREE.CylinderGeometry(rl, rBot * 0.985, h * lvl, 128, 1, false),
        new THREE.MeshStandardMaterial({
          color: new THREE.Color(fill in preset ? preset[fill] : fill),
          roughness: 0.24, metalness: 0 }));
      liquid.position.y = h * lvl / 2;
      cup.add(liquid);
    }

    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(rTop, 1.8 * S, 16, 160),
      clear ? clearMat() : new THREE.MeshStandardMaterial({
        color: new THREE.Color(this.getAttribute('rim-color') || '#FE5000'),
        roughness: 0.7, metalness: 0 }));
    rim.rotation.x = -Math.PI / 2;
    rim.position.y = h;
    cup.add(rim);

    if ((this.getAttribute('lid') || 'black') !== 'none') {
      const k = rTop / (45 * S);       // profile authored for a 45 mm rim
      const pts = LID_PROFILE.map(([r, y]) => new THREE.Vector2(r * S * k, y * S));
      const lid = new THREE.Mesh(new THREE.LatheGeometry(pts, 128),
        new THREE.MeshStandardMaterial({ color: 0x0e0e0e, roughness: 0.44, metalness: 0 }));
      lid.position.y = h + 1.0 * S;
      cup.add(lid);

      // sip opening: a matte void sitting just proud of the dome, which reads
      // as a hole against the satin lid without needing a real boolean cut
      const holeGeo = new THREE.CircleGeometry(1, 48);
      holeGeo.scale(7.5 * S * k, 6.0 * S, 1);
      const hole = new THREE.Mesh(holeGeo,
        new THREE.MeshBasicMaterial({ color: 0x060606 }));
      // -z because the cup group is turned 180 deg to hide the seam; this puts
      // the opening on the viewer's side. Tilt matches the dome slope at r=14.
      hole.rotation.x = -Math.PI / 2 - 0.157;
      hole.position.set(0, h + (1.0 + 12.65) * S, -14 * S * k);
      cup.add(hole);
    }

    this._shadow.scale.set(rBot * 7, rBot * 7, 1);
    this._reframe(h);
  }

  disconnectedCallback() {
    this._stop?.(); this._ro?.disconnect(); this._io?.disconnect();
    this._tex?.dispose(); this._transTex?.dispose(); this._renderer?.dispose();
  }
}

customElements.define('cup-viewer', CupViewer);
