import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { GeneratedImageAsset } from "openclaw/plugin-sdk/image-generation";

type PixelArtStyle = "stardew-placeholder";
type PixelArtBiome = "farm" | "forest" | "coast" | "mine";
type PixelArtSubject = "crop" | "tree" | "house" | "pond" | "rock";

type Rgba = {
  r: number;
  g: number;
  b: number;
  /** Alpha channel in normalized range [0, 1]. */
  a?: number;
};

export type PixelArtPlaceholderParams = {
  prompt: string;
  seed?: string | number;
  width?: number;
  height?: number;
  pixelScale?: number;
  style?: PixelArtStyle;
};

export type PixelArtPlaceholderFileParams = PixelArtPlaceholderParams & {
  outputPath: string;
};

export type PixelArtPlaceholderMetadata = {
  style: PixelArtStyle;
  biome: PixelArtBiome;
  subject: PixelArtSubject;
  seed: string;
  width: number;
  height: number;
  pixelScale: number;
};

const DEFAULT_WIDTH = 16;
const DEFAULT_HEIGHT = 16;
const DEFAULT_PIXEL_SCALE = 12;
const DEFAULT_STYLE: PixelArtStyle = "stardew-placeholder";

const BIOME_KEYWORDS: Record<PixelArtBiome, string[]> = {
  farm: ["farm", "field", "barn", "crop", "garden", "cottage"],
  forest: ["forest", "woods", "tree", "grove", "nature", "leaf"],
  coast: ["water", "pond", "river", "coast", "beach", "fish"],
  mine: ["mine", "rock", "ore", "cave", "stone", "crystal"],
};

const SUBJECT_KEYWORDS: Record<PixelArtSubject, string[]> = {
  crop: ["crop", "turnip", "pumpkin", "parsnip", "plant", "field"],
  tree: ["tree", "oak", "pine", "forest", "wood"],
  house: ["house", "barn", "home", "cottage", "hut"],
  pond: ["pond", "water", "river", "lake", "fish"],
  rock: ["rock", "ore", "stone", "mine", "crystal"],
};

const BIOME_PALETTES: Record<PixelArtBiome, {
  sky: Rgba;
  horizon: Rgba;
  ground: Rgba;
  accent: Rgba;
  detail: Rgba;
  shadow: Rgba;
}> = {
  farm: {
    sky: { r: 166, g: 214, b: 255 },
    horizon: { r: 255, g: 224, b: 154 },
    ground: { r: 111, g: 168, b: 72 },
    accent: { r: 201, g: 109, b: 62 },
    detail: { r: 249, g: 225, b: 122 },
    shadow: { r: 71, g: 103, b: 51 },
  },
  forest: {
    sky: { r: 145, g: 201, b: 255 },
    horizon: { r: 189, g: 228, b: 174 },
    ground: { r: 68, g: 126, b: 74 },
    accent: { r: 120, g: 79, b: 48 },
    detail: { r: 92, g: 176, b: 90 },
    shadow: { r: 40, g: 76, b: 44 },
  },
  coast: {
    sky: { r: 152, g: 219, b: 255 },
    horizon: { r: 247, g: 232, b: 170 },
    ground: { r: 90, g: 169, b: 197 },
    accent: { r: 58, g: 124, b: 165 },
    detail: { r: 235, g: 223, b: 152 },
    shadow: { r: 39, g: 77, b: 103 },
  },
  mine: {
    sky: { r: 79, g: 92, b: 122 },
    horizon: { r: 125, g: 141, b: 178 },
    ground: { r: 88, g: 96, b: 111 },
    accent: { r: 167, g: 124, b: 77 },
    detail: { r: 122, g: 209, b: 214 },
    shadow: { r: 44, g: 49, b: 60 },
  },
};

function clampColor(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function varyColor(color: Rgba, delta: number): Rgba {
  return {
    r: clampColor(color.r + delta),
    g: clampColor(color.g + delta),
    b: clampColor(color.b + delta),
    a: color.a,
  };
}

function hashString(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickHighestScore<T extends string>(text: string, candidates: Record<T, string[]>): T {
  let bestKey = Object.keys(candidates)[0] as T;
  let bestScore = -1;
  for (const [key, words] of Object.entries(candidates) as Array<[T, string[]]>) {
    const score = words.reduce((total, word) => total + (text.includes(word) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      bestKey = key;
    }
  }
  return bestKey;
}

function slugifyFilePart(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return normalized || "placeholder";
}

function createImage(width: number, height: number): Uint8Array {
  return new Uint8Array(width * height * 4);
}

function setPixel(image: Uint8Array, width: number, x: number, y: number, color: Rgba) {
  const height = Math.floor(image.length / (width * 4));
  if (x < 0 || y < 0 || x >= width || y >= height) {
    return;
  }
  const offset = (y * width + x) * 4;
  if (offset < 0 || offset + 3 >= image.length) {
    return;
  }
  image[offset] = clampColor(color.r);
  image[offset + 1] = clampColor(color.g);
  image[offset + 2] = clampColor(color.b);
  const alphaNormalized = Math.max(0, Math.min(1, color.a ?? 1));
  image[offset + 3] = clampColor(alphaNormalized * 255);
}

function ensurePositiveInt(name: string, value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function fillRect(image: Uint8Array, width: number, x: number, y: number, rectWidth: number, rectHeight: number, color: Rgba) {
  for (let yOffset = 0; yOffset < rectHeight; yOffset += 1) {
    for (let xOffset = 0; xOffset < rectWidth; xOffset += 1) {
      setPixel(image, width, x + xOffset, y + yOffset, color);
    }
  }
}

function drawBackground(
  image: Uint8Array,
  width: number,
  height: number,
  palette: (typeof BIOME_PALETTES)[PixelArtBiome],
  rng: () => number,
) {
  const horizonY = Math.floor(height * 0.45);
  fillRect(image, width, 0, 0, width, horizonY, palette.sky);
  fillRect(image, width, 0, horizonY - 1, width, 2, palette.horizon);
  fillRect(image, width, 0, horizonY + 1, width, height - horizonY - 1, palette.ground);

  for (let x = 0; x < width; x += 1) {
    if (rng() > 0.7) {
      setPixel(image, width, x, horizonY - 2, varyColor(palette.horizon, rng() > 0.5 ? 12 : -12));
    }
    if (rng() > 0.68) {
      setPixel(image, width, x, height - 1, varyColor(palette.shadow, -8));
    }
  }
}

function drawTree(
  image: Uint8Array,
  width: number,
  height: number,
  palette: (typeof BIOME_PALETTES)[PixelArtBiome],
) {
  const trunkX = Math.floor(width / 2) - 1;
  fillRect(image, width, trunkX, height - 5, 2, 4, palette.accent);
  fillRect(image, width, trunkX - 2, height - 10, 6, 3, palette.detail);
  fillRect(image, width, trunkX - 3, height - 8, 8, 2, varyColor(palette.detail, -12));
  setPixel(image, width, trunkX - 1, height - 11, palette.detail);
  setPixel(image, width, trunkX + 2, height - 11, palette.detail);
}

function drawCrop(
  image: Uint8Array,
  width: number,
  height: number,
  palette: (typeof BIOME_PALETTES)[PixelArtBiome],
) {
  const baseY = height - 4;
  for (let column = 2; column < width - 2; column += 3) {
    setPixel(image, width, column, baseY, palette.detail);
    setPixel(image, width, column, baseY - 1, varyColor(palette.detail, 16));
    setPixel(image, width, column - 1, baseY - 1, varyColor(palette.shadow, 8));
    setPixel(image, width, column + 1, baseY - 1, varyColor(palette.shadow, 8));
  }
  fillRect(image, width, 0, height - 2, width, 1, varyColor(palette.accent, -18));
}

function drawHouse(
  image: Uint8Array,
  width: number,
  height: number,
  palette: (typeof BIOME_PALETTES)[PixelArtBiome],
) {
  const houseWidth = 8;
  const left = Math.floor((width - houseWidth) / 2);
  const roofY = height - 9;
  fillRect(image, width, left, roofY + 2, houseWidth, 5, varyColor(palette.horizon, 18));
  fillRect(image, width, left + 2, roofY + 4, 2, 3, palette.shadow);
  fillRect(image, width, left + 5, roofY + 4, 2, 2, palette.sky);
  for (let offset = 0; offset < houseWidth; offset += 1) {
    setPixel(image, width, left + offset, roofY + Math.abs(3 - offset), palette.accent);
  }
}

function drawPond(
  image: Uint8Array,
  width: number,
  height: number,
  palette: (typeof BIOME_PALETTES)[PixelArtBiome],
) {
  fillRect(image, width, 3, height - 6, width - 6, 4, palette.accent);
  fillRect(image, width, 4, height - 5, width - 8, 2, varyColor(palette.sky, 12));
  setPixel(image, width, Math.floor(width / 2), height - 4, palette.detail);
}

function drawRock(
  image: Uint8Array,
  width: number,
  height: number,
  palette: (typeof BIOME_PALETTES)[PixelArtBiome],
) {
  fillRect(image, width, 5, height - 6, 6, 4, varyColor(palette.ground, 12));
  fillRect(image, width, 6, height - 7, 4, 1, varyColor(palette.detail, 10));
  setPixel(image, width, 7, height - 5, palette.shadow);
  setPixel(image, width, 9, height - 4, palette.shadow);
}

function renderSubject(
  subject: PixelArtSubject,
  image: Uint8Array,
  width: number,
  height: number,
  palette: (typeof BIOME_PALETTES)[PixelArtBiome],
) {
  switch (subject) {
    case "tree":
      drawTree(image, width, height, palette);
      return;
    case "house":
      drawHouse(image, width, height, palette);
      return;
    case "pond":
      drawPond(image, width, height, palette);
      return;
    case "rock":
      drawRock(image, width, height, palette);
      return;
    case "crop":
    default:
      drawCrop(image, width, height, palette);
  }
}

function scaleImage(image: Uint8Array, width: number, height: number, scale: number): Uint8Array {
  const scaledWidth = width * scale;
  const scaledHeight = height * scale;
  const scaled = new Uint8Array(scaledWidth * scaledHeight * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceOffset = (y * width + x) * 4;
      for (let yScale = 0; yScale < scale; yScale += 1) {
        for (let xScale = 0; xScale < scale; xScale += 1) {
          const targetX = x * scale + xScale;
          const targetY = y * scale + yScale;
          const targetOffset = (targetY * scaledWidth + targetX) * 4;
          scaled[targetOffset] = image[sourceOffset];
          scaled[targetOffset + 1] = image[sourceOffset + 1];
          scaled[targetOffset + 2] = image[sourceOffset + 2];
          scaled[targetOffset + 3] = image[sourceOffset + 3];
        }
      }
    }
  }
  return scaled;
}

function makeCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let crc = index;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    table[index] = crc >>> 0;
  }
  return table;
}

const CRC_TABLE = makeCrcTable();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(data.length, 0);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([lengthBuffer, typeBuffer, data, crcBuffer]);
}

function encodePng(rgba: Uint8Array, width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    Buffer.from(rgba.subarray(y * stride, (y + 1) * stride)).copy(raw, rowStart + 1);
  }

  const idat = deflateSync(raw);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export async function generatePixelArtPlaceholder(
  params: PixelArtPlaceholderParams,
): Promise<GeneratedImageAsset> {
  const prompt = params.prompt.trim();
  if (!prompt) {
    throw new Error("Pixel placeholder prompt is required");
  }

  const width = ensurePositiveInt("width", params.width ?? DEFAULT_WIDTH);
  const height = ensurePositiveInt("height", params.height ?? DEFAULT_HEIGHT);
  const pixelScale = ensurePositiveInt("pixelScale", params.pixelScale ?? DEFAULT_PIXEL_SCALE);
  const style = params.style ?? DEFAULT_STYLE;
  const seed = String(params.seed ?? prompt);
  const normalizedPrompt = prompt.toLowerCase();
  const biome = pickHighestScore(normalizedPrompt, BIOME_KEYWORDS);
  const subject = pickHighestScore(normalizedPrompt, SUBJECT_KEYWORDS);
  const seedHash = hashString(`${style}:${seed}:${prompt}`);
  const rng = createRng(seedHash);
  const palette = BIOME_PALETTES[biome];
  const image = createImage(width, height);

  drawBackground(image, width, height, palette, rng);
  renderSubject(subject, image, width, height, palette);

  for (let sparkleIndex = 0; sparkleIndex < 5; sparkleIndex += 1) {
    const x = Math.floor(rng() * width);
    const y = Math.floor(rng() * Math.max(3, height - 6));
    if (rng() > 0.45) {
      setPixel(image, width, x, y, varyColor(palette.detail, 22));
    }
  }

  const scaled = scaleImage(image, width, height, pixelScale);
  return {
    buffer: encodePng(scaled, width * pixelScale, height * pixelScale),
    mimeType: "image/png",
    fileName: `${slugifyFilePart(subject)}-${slugifyFilePart(seed)}.png`,
    metadata: {
      style,
      biome,
      subject,
      seed,
      width,
      height,
      pixelScale,
    } satisfies PixelArtPlaceholderMetadata,
  };
}

export async function writePixelArtPlaceholder(
  params: PixelArtPlaceholderFileParams,
): Promise<{ outputPath: string; asset: GeneratedImageAsset }> {
  const asset = await generatePixelArtPlaceholder(params);
  const outputPath = resolve(params.outputPath);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, asset.buffer);
  return {
    outputPath,
    asset,
  };
}
