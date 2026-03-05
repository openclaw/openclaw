import {
  AmbientLight,
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Scene,
  SRGBColorSpace,
  Texture,
  WebGLRenderer,
} from "three";
import {
  createSeededRandom,
  type SeedLike,
  type SeededRandom,
} from "../utils/random";

enum GeometryAttributeName {
  Position = "position",
  Color = "color",
  SeedA = "seedA",
  SeedB = "seedB",
}

const DEFAULT_COMPOSITION_ID = "LinkedParticles";
const DEFAULT_SEED = "default";
const RANDOM_NAMESPACE = "LinkedParticlesScene";

type LinkedParticlesManagerOptions = {
  compositionId?: string;
  seed?: string | number;
};

const createGalaxyTexture = (
  w: number,
  h: number,
  random: SeededRandom,
): Texture => {
  const cw = Math.max(1024, Math.floor(w));
  const ch = Math.max(1024, Math.floor(h));
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");

  if (!ctx) {
    const tex = new CanvasTexture(document.createElement("canvas"));
    tex.needsUpdate = true;
    return tex;
  }

  ctx.fillStyle = "#05070a";
  ctx.fillRect(0, 0, cw, ch);

  const cx = cw * 0.5;
  const cy = ch * 0.5;
  const radius = Math.max(cw, ch) * 0.7;
  const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
  gradient.addColorStop(0.0, "#0d1630");
  gradient.addColorStop(0.35, "#1a0f2b");
  gradient.addColorStop(0.7, "#081426");
  gradient.addColorStop(1.0, "#05070a");
  ctx.globalAlpha = 1;
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, cw, ch);

  const blob = (
    x: number,
    y: number,
    r: number,
    color: string,
    alpha: number,
  ) => {
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, color);
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.globalAlpha = alpha;
    ctx.fillStyle = grad;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  };

  const palette = ["#5e2d79", "#1c6ea4", "#2b7a78", "#7f1d8d"];
  const blobRandom = random.fork("nebula-blobs");
  for (let i = 0; i < 9; i++) {
    const rx = cx + (blobRandom.next() - 0.5) * cw * 0.35;
    const ry = cy + (blobRandom.next() - 0.5) * ch * 0.35;
    const rr =
      blobRandom.nextRange(0, Math.max(cw, ch) * 0.18) +
      Math.max(cw, ch) * 0.08;
    const color = palette[blobRandom.nextInt(0, palette.length - 1)];
    const alpha = 0.12 + blobRandom.next() * 0.12;
    blob(rx, ry, rr, color, alpha);
  }

  const starCount = Math.floor((cw * ch) / 4000);
  ctx.globalAlpha = 1;
  const starRandom = random.fork("galaxy-stars");
  for (let i = 0; i < starCount; i++) {
    const x = starRandom.next() * cw;
    const y = starRandom.next() * ch;
    const alpha = 0.35 + starRandom.next() * 0.65;
    const size = starRandom.next() * 1.0 + 0.2;
    ctx.fillStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.shadowColor = "rgba(255,255,255,0.8)";
  ctx.shadowBlur = 8;
  for (let i = 0; i < Math.floor(starCount * 0.05); i++) {
    const x = starRandom.next() * cw;
    const y = starRandom.next() * ch;
    const size = starRandom.next() * 1.2 + 0.6;
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.shadowBlur = 0;

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
};

const FALLBACK_STYLES = {
  position: "absolute",
  inset: "0",
  background:
    "radial-gradient(150% 100% at 50% 50%, #0d1630 0%, #1a0f2b 40%, #05070a 100%)",
} as const;

export class LinkedParticlesSceneManager {
  private readonly scene: Scene;
  private readonly camera: PerspectiveCamera;
  private readonly renderer: WebGLRenderer;
  private readonly points: Points<BufferGeometry, PointsMaterial>;
  private readonly positionAttr: BufferAttribute;
  private readonly colorAttr: BufferAttribute;
  private readonly seedAAttr: BufferAttribute;
  private readonly seedBAttr: BufferAttribute;
  private readonly seedArgs: SeedLike[];
  private mountTarget: HTMLElement | null = null;
  private fallbackEl: HTMLDivElement | null = null;

  constructor(
    width: number,
    height: number,
    options?: LinkedParticlesManagerOptions,
  ) {
    const compositionId = options?.compositionId ?? DEFAULT_COMPOSITION_ID;
    const userSeed = options?.seed ?? DEFAULT_SEED;
    this.seedArgs = [RANDOM_NAMESPACE, compositionId, userSeed];

    const baseRandom = this.createBaseRandom();
    const galaxyRandom = baseRandom.fork("galaxy");
    const starRandom = baseRandom.fork("starfield");

    this.scene = new Scene();
    this.scene.background = createGalaxyTexture(width, height, galaxyRandom);

    this.camera = new PerspectiveCamera(60, width / height, 0.1, 200);
    this.camera.position.set(0, 0, 14);

    const canvas = document.createElement("canvas");
    const gl2 = canvas.getContext("webgl2", {
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
      failIfMajorPerformanceCaveat: false,
      powerPreference: "high-performance",
    }) as WebGL2RenderingContext | null;

    if (!gl2) {
      throw new Error("WebGL2 context creation failed");
    }

    const rendererOptions: ConstructorParameters<typeof WebGLRenderer>[0] = {
      canvas,
      context: gl2 as unknown as WebGLRenderingContext,
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    };
    this.renderer = new WebGLRenderer(rendererOptions);

    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);

    this.scene.add(new AmbientLight(0xffffff, 0.2));

    const starCount = 6000;
    const positions = new Float32Array(starCount * 3);
    const colors = new Float32Array(starCount * 3);
    const seedsA = new Float32Array(starCount);
    const seedsB = new Float32Array(starCount);

    for (let i = 0; i < starCount; i++) {
      const angle = starRandom.nextRange(0, Math.PI * 2);
      const radius = 6 + starRandom.next() * 5;
      const y = (starRandom.next() - 0.5) * 2.0;
      positions[i * 3 + 0] = Math.cos(angle) * radius;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = Math.sin(angle) * radius;
      seedsA[i] = starRandom.next();
      seedsB[i] = starRandom.next();
      colors[i * 3 + 0] = 0.62;
      colors[i * 3 + 1] = 0.8;
      colors[i * 3 + 2] = 1.0;
    }

    const geometry = new BufferGeometry();
    this.positionAttr = new BufferAttribute(positions, 3);
    geometry.setAttribute(GeometryAttributeName.Position, this.positionAttr);
    this.colorAttr = new BufferAttribute(colors, 3);
    geometry.setAttribute(GeometryAttributeName.Color, this.colorAttr);
    this.seedAAttr = new BufferAttribute(seedsA, 1);
    geometry.setAttribute(GeometryAttributeName.SeedA, this.seedAAttr);
    this.seedBAttr = new BufferAttribute(seedsB, 1);
    geometry.setAttribute(GeometryAttributeName.SeedB, this.seedBAttr);

    const material = new PointsMaterial({
      color: 0xffffff,
      vertexColors: true,
      size: 0.06,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: AdditiveBlending,
    });

    this.points = new Points(geometry, material);
    this.points.frustumCulled = false;
    this.scene.add(this.points);
  }

  mount(element: HTMLDivElement) {
    this.mountTarget = element;
    this.disposeFallback();
    try {
      element.appendChild(this.renderer.domElement);
    } catch {
      const fallback = document.createElement("div");
      fallback.style.position = FALLBACK_STYLES.position;
      fallback.style.inset = FALLBACK_STYLES.inset;
      fallback.style.background = FALLBACK_STYLES.background;
      element.appendChild(fallback);
      this.fallbackEl = fallback;
    }
  }

  resize(width: number, height: number) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    const background = this.scene.background as Texture | null;
    if (background) {
      background.dispose();
    }
    const galaxyRandom = this.createBaseRandom().fork("galaxy");
    this.scene.background = createGalaxyTexture(width, height, galaxyRandom);
  }

  update(frame: number, fps: number) {
    const positions = this.positionAttr.array as Float32Array;
    const colors = this.colorAttr.array as Float32Array;
    const seedsA = this.seedAAttr.array as Float32Array;
    const seedsB = this.seedBAttr.array as Float32Array;
    const t = frame / fps;
    const count = positions.length / 3;
    const baseRadius = 10.5;
    const spin = 0.38;
    const cx = Math.sin(t * 0.25) * 4.5;
    const cy = Math.cos(t * 0.18) * 2.4;

    for (let i = 0; i < count; i++) {
      const sa = seedsA[i];
      const sb = seedsB[i];
      const angle = sa * Math.PI * 2 + t * spin;
      const radius =
        baseRadius + Math.sin(t * 0.7 + sb * 12.0) * 2.5 + sb * 2.2;
      const y = Math.sin(t * 0.9 + sb * 6.283) * 1.6;
      positions[i * 3 + 0] = Math.cos(angle) * radius + cx;
      positions[i * 3 + 1] = y + cy;
      positions[i * 3 + 2] = Math.sin(angle) * radius;

      const flicker =
        Math.sin(t * 5.2 + sa * 14.0) * Math.cos(t * 3.7 + sb * 11.0);
      const twinkle = Math.max(0, flicker);
      const boost = twinkle > 0.85 ? 1.0 : twinkle * 0.6;
      const baseR = 0.62;
      const baseG = 0.8;
      const baseB = 1.0;
      const factor = 1.0 + boost * 1.6;
      colors[i * 3 + 0] = Math.min(1, baseR * factor);
      colors[i * 3 + 1] = Math.min(1, baseG * factor);
      colors[i * 3 + 2] = Math.min(1, baseB * factor);
    }

    this.positionAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;

    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    if (this.mountTarget) {
      try {
        this.mountTarget.removeChild(this.renderer.domElement);
      } catch {
        // ignore missing DOM element
      }
    }

    this.disposeFallback();

    this.scene.remove(this.points);
    this.points.geometry.dispose();
    // BufferAttribute には dispose() がないため、geometry.dispose() で解放される
    (this.points.material as PointsMaterial).dispose();
    this.renderer.dispose();

    const background = this.scene.background as Texture | null;
    if (background) {
      background.dispose();
    }
    this.scene.background = null;

    this.mountTarget = null;
  }

  private disposeFallback() {
    if (this.fallbackEl && this.fallbackEl.parentElement) {
      this.fallbackEl.parentElement.removeChild(this.fallbackEl);
    }
    this.fallbackEl = null;
  }

  private createBaseRandom(): SeededRandom {
    return createSeededRandom(...this.seedArgs);
  }
}
