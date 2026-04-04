import path from "node:path";
import sharp from "sharp";
import { canonicalizeBase64, estimateBase64DecodedBytes } from "../../../src/media/base64.js";
import { detectMime, extensionForMime } from "../../../src/media/mime.js";
import type { WigForgeResolvedConfig } from "./config.js";
import { clamp01, hashHex, pickFromSeed, seededUnitInterval } from "./random.js";
import type { WigForgeStore } from "./store.js";
import {
  type WigForgeAsset,
  type WigForgeAssetAssemblyProfile,
  type WigForgeRarity,
  type WigForgeSlot,
  type WigForgeVisualVariant,
} from "./types.js";

export type WigForgeMintInput = {
  sourceDataUrl?: string;
  sourceBase64?: string;
  mimeType?: string;
  originUrl?: string;
  slotHint?: WigForgeSlot | "auto";
  nameHint?: string;
  styleTags?: string[];
  taskQuality?: number;
  maskQuality?: number;
  novelty?: number;
  styleFit?: number;
  luck?: number;
};

type PreparedSource = {
  buffer: Buffer;
  mimeType: string;
  extension: string;
  width: number;
  height: number;
  sourceFingerprint: string;
};

type RawRgbaImage = {
  data: Buffer;
  width: number;
  height: number;
};

type AlphaBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
  area: number;
};

type RefinedSource = {
  buffer: Buffer;
  raw: Buffer;
  width: number;
  height: number;
  alphaMap: Float32Array;
};

const SLOT_KEYWORDS: Record<WigForgeSlot, string[]> = {
  head: ["hat", "cap", "crown", "hair", "helm", "head", "hood"],
  face: ["glasses", "mask", "visor", "monocle", "face"],
  body: ["shirt", "jacket", "coat", "hoodie", "body", "armor", "robe"],
  neck: ["tie", "ribbon", "bow", "scarf", "collar", "neck"],
  companion: ["companion", "pet", "buddy", "sprite", "familiar"],
  aura: ["aura", "glow", "halo", "trail", "spark", "flare"],
};

const SLOT_BASE_NAMES: Record<WigForgeSlot, string[]> = {
  head: ["Cap", "Crownlet", "Headpiece"],
  face: ["Mask", "Visor", "Spectacles"],
  body: ["Coat", "Vestment", "Outerwear"],
  neck: ["Tie", "Ribbon", "Scarf"],
  companion: ["Companion", "Sprite", "Buddy"],
  aura: ["Aura", "Halo", "Trail"],
};

const MATERIAL_BY_RARITY: Record<WigForgeRarity, string[]> = {
  common: ["cotton", "simple", "plain"],
  uncommon: ["polished", "stitched", "lacquered"],
  rare: ["metallic", "silk", "prismatic"],
  epic: ["holo", "velvet", "starwoven"],
  mythic: ["celestial", "mythic", "radiant"],
};

const TRIM_BY_RARITY: Record<WigForgeRarity, string[]> = {
  common: ["clean"],
  uncommon: ["edged", "banded"],
  rare: ["filigree", "silverline", "trimmed"],
  epic: ["glint", "sparkline", "runed"],
  mythic: ["crowned", "nimbus", "starlit"],
};

const FX_BY_RARITY: Record<WigForgeRarity, string[]> = {
  common: ["none"],
  uncommon: ["soft-sheen"],
  rare: ["pulse"],
  epic: ["soft-sparkle", "neon-halo"],
  mythic: ["starfall", "mythic-bloom"],
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundTo(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function inferSlot(params: {
  slotHint?: WigForgeSlot | "auto";
  nameHint?: string;
  styleTags?: string[];
  width: number;
  height: number;
}): WigForgeSlot {
  if (params.slotHint && params.slotHint !== "auto") {
    return params.slotHint;
  }

  const haystack = [params.nameHint ?? "", ...(params.styleTags ?? [])].join(" ").toLowerCase();

  for (const [slot, words] of Object.entries(SLOT_KEYWORDS) as Array<[WigForgeSlot, string[]]>) {
    if (words.some((word) => haystack.includes(word))) {
      return slot;
    }
  }

  const aspect = params.width / Math.max(1, params.height);
  if (aspect <= 0.7) {
    return "neck";
  }
  if (aspect >= 1.25) {
    return "head";
  }
  return "body";
}

function sanitizeStyleTags(styleTags?: string[]): string[] {
  if (!Array.isArray(styleTags)) {
    return [];
  }
  return Array.from(
    new Set(
      styleTags
        .map((tag) => String(tag).trim().toLowerCase())
        .filter((tag) => tag.length > 0)
        .slice(0, 12),
    ),
  );
}

function parseDataUrl(input: string): { mimeType?: string; base64: string } | null {
  const match = /^data:([^;,]+)?;base64,(.+)$/s.exec(input);
  if (!match) {
    return null;
  }
  return {
    mimeType: match[1]?.trim(),
    base64: match[2] ?? "",
  };
}

async function prepareSourceImage(
  input: WigForgeMintInput,
  config: WigForgeResolvedConfig,
): Promise<PreparedSource> {
  let headerMime: string | undefined;
  let rawBase64 = "";

  if (typeof input.sourceDataUrl === "string" && input.sourceDataUrl.trim()) {
    const parsed = parseDataUrl(input.sourceDataUrl.trim());
    if (!parsed) {
      throw new Error("sourceDataUrl must be a base64 data URL");
    }
    headerMime = parsed.mimeType;
    rawBase64 = parsed.base64;
  } else if (typeof input.sourceBase64 === "string" && input.sourceBase64.trim()) {
    rawBase64 = input.sourceBase64.trim();
    headerMime = typeof input.mimeType === "string" ? input.mimeType : undefined;
  } else {
    throw new Error("sourceDataUrl or sourceBase64 is required");
  }

  const estimatedBytes = estimateBase64DecodedBytes(rawBase64);
  if (estimatedBytes <= 0) {
    throw new Error("source image payload is empty");
  }
  if (estimatedBytes > config.maxSourceBytes) {
    throw new Error(`source image too large (${estimatedBytes} bytes > ${config.maxSourceBytes})`);
  }

  const canonical = canonicalizeBase64(rawBase64);
  if (!canonical) {
    throw new Error("invalid base64 image payload");
  }

  const buffer = Buffer.from(canonical, "base64");
  const mimeType =
    (await detectMime({ buffer, headerMime: headerMime ?? input.mimeType })) ?? "image/png";
  if (!mimeType.startsWith("image/")) {
    throw new Error(`unsupported source mime type: ${mimeType}`);
  }

  const metadata = await sharp(buffer, { failOnError: false }).ensureAlpha().metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width <= 0 || height <= 0) {
    throw new Error("could not read source image dimensions");
  }

  return {
    buffer,
    mimeType,
    extension: extensionForMime(mimeType) || ".png",
    width,
    height,
    sourceFingerprint: hashHex(buffer),
  };
}

function normalizeRgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b]
    .map((value) =>
      Math.max(0, Math.min(255, Math.round(value)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace("#", "");
  const value = Number.parseInt(clean, 16);
  return {
    r: (value >> 16) & 0xff,
    g: (value >> 8) & 0xff,
    b: value & 0xff,
  };
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const nr = r / 255;
  const ng = g / 255;
  const nb = b / 255;
  const max = Math.max(nr, ng, nb);
  const min = Math.min(nr, ng, nb);
  const l = (max + min) / 2;
  if (max === min) {
    return { h: 0, s: 0, l };
  }
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  switch (max) {
    case nr:
      h = (ng - nb) / d + (ng < nb ? 6 : 0);
      break;
    case ng:
      h = (nb - nr) / d + 2;
      break;
    default:
      h = (nr - ng) / d + 4;
      break;
  }
  return { h: h / 6, s, l };
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  if (s === 0) {
    const gray = Math.round(l * 255);
    return { r: gray, g: gray, b: gray };
  }
  const hue2rgb = (p: number, q: number, t: number): number => {
    let next = t;
    if (next < 0) next += 1;
    if (next > 1) next -= 1;
    if (next < 1 / 6) return p + (q - p) * 6 * next;
    if (next < 1 / 2) return q;
    if (next < 2 / 3) return p + (q - p) * (2 / 3 - next) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, h) * 255),
    b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  };
}

async function derivePalette(sourceBuffer: Buffer, seed: string): Promise<string[]> {
  const stats = await sharp(sourceBuffer, { failOnError: false }).ensureAlpha().stats();
  const base = {
    r: Math.round(stats.channels[0]?.mean ?? 180),
    g: Math.round(stats.channels[1]?.mean ?? 180),
    b: Math.round(stats.channels[2]?.mean ?? 180),
  };
  const hsl = rgbToHsl(base.r, base.g, base.b);
  const hueShift = seededUnitInterval(seed, 1) * 0.35;
  const accent = hslToRgb(
    (hsl.h + hueShift) % 1,
    Math.min(1, hsl.s + 0.16),
    Math.min(0.78, hsl.l + 0.1),
  );
  const shadow = hslToRgb(hsl.h, Math.max(0.15, hsl.s - 0.08), Math.max(0.14, hsl.l - 0.18));
  return [
    normalizeRgbToHex(base.r, base.g, base.b),
    normalizeRgbToHex(accent.r, accent.g, accent.b),
    normalizeRgbToHex(shadow.r, shadow.g, shadow.b),
  ];
}

export function rollRarity(input: {
  novelty: number;
  duplicateCount: number;
  maskQuality: number;
  taskQuality: number;
  styleFit: number;
  luck: number;
}): { rarity: WigForgeRarity; score: number; duplicatePenalty: number; effectiveNovelty: number } {
  const novelty = clamp01(input.novelty);
  const duplicatePenalty = Math.pow(0.55, Math.max(0, input.duplicateCount));
  const effectiveNovelty = clamp01(novelty * duplicatePenalty);
  const score = clamp01(
    effectiveNovelty * 0.32 +
      clamp01(input.maskQuality) * 0.2 +
      clamp01(input.taskQuality) * 0.22 +
      clamp01(input.styleFit) * 0.16 +
      clamp01(input.luck) * 0.1,
  );

  if (score >= 0.9) {
    return { rarity: "mythic", score, duplicatePenalty, effectiveNovelty };
  }
  if (score >= 0.75) {
    return { rarity: "epic", score, duplicatePenalty, effectiveNovelty };
  }
  if (score >= 0.55) {
    return { rarity: "rare", score, duplicatePenalty, effectiveNovelty };
  }
  if (score >= 0.35) {
    return { rarity: "uncommon", score, duplicatePenalty, effectiveNovelty };
  }
  return { rarity: "common", score, duplicatePenalty, effectiveNovelty };
}

function createVisualVariant(params: {
  slot: WigForgeSlot;
  rarity: WigForgeRarity;
  palette: string[];
  seed: string;
}): WigForgeVisualVariant {
  const accentColor = params.palette[1] ?? "#ffffff";
  return {
    material: pickFromSeed(MATERIAL_BY_RARITY[params.rarity], params.seed, 2),
    trim: pickFromSeed(TRIM_BY_RARITY[params.rarity], params.seed, 3),
    fxPreset: pickFromSeed(FX_BY_RARITY[params.rarity], params.seed, 4),
    hueShift: Math.round(seededUnitInterval(params.seed, 5) * 16 - 8),
    saturationBoost: 0.99 + seededUnitInterval(params.seed, 6) * 0.06,
    brightnessBoost: 0.99 + seededUnitInterval(params.seed, 7) * 0.05,
    accentColor,
  };
}

function buildAssetName(params: {
  slot: WigForgeSlot;
  rarity: WigForgeRarity;
  visuals: WigForgeVisualVariant;
  nameHint?: string;
}): string {
  const hinted = params.nameHint?.trim();
  if (hinted) {
    return hinted.slice(0, 60);
  }
  const slotName = SLOT_BASE_NAMES[params.slot][0];
  const prefix =
    params.visuals.trim === "clean"
      ? params.visuals.material
      : `${params.visuals.trim} ${params.visuals.material}`;
  const rarityLabel = params.rarity === "common" ? "" : `${params.rarity} `;
  return `${toTitleCase(rarityLabel)}${toTitleCase(prefix)} ${slotName}`.trim();
}

function toTitleCase(input: string): string {
  return input
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

async function decodeRawRgba(buffer: Buffer): Promise<RawRgbaImage> {
  const { data, info } = await sharp(buffer, { failOnError: false })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    data,
    width: info.width,
    height: info.height,
  };
}

function maxFilterFloatMap(
  source: Float32Array,
  width: number,
  height: number,
  radius = 1,
): Float32Array {
  const output = new Float32Array(source.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let value = 0;
      for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
        const sampleY = clamp(y + offsetY, 0, height - 1);
        for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
          const sampleX = clamp(x + offsetX, 0, width - 1);
          value = Math.max(value, source[sampleY * width + sampleX] ?? 0);
        }
      }
      output[y * width + x] = value;
    }
  }
  return output;
}

function minFilterFloatMap(
  source: Float32Array,
  width: number,
  height: number,
  radius = 1,
): Float32Array {
  const output = new Float32Array(source.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let value = 1;
      for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
        const sampleY = clamp(y + offsetY, 0, height - 1);
        for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
          const sampleX = clamp(x + offsetX, 0, width - 1);
          value = Math.min(value, source[sampleY * width + sampleX] ?? 0);
        }
      }
      output[y * width + x] = value;
    }
  }
  return output;
}

function blurFloatMap(
  source: Float32Array,
  width: number,
  height: number,
  radius = 1,
): Float32Array {
  const horizontal = new Float32Array(source.length);
  const output = new Float32Array(source.length);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let total = 0;
      let count = 0;
      for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
        const sampleX = clamp(x + offsetX, 0, width - 1);
        total += source[y * width + sampleX] ?? 0;
        count += 1;
      }
      horizontal[y * width + x] = total / Math.max(1, count);
    }
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let total = 0;
      let count = 0;
      for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
        const sampleY = clamp(y + offsetY, 0, height - 1);
        total += horizontal[sampleY * width + x] ?? 0;
        count += 1;
      }
      output[y * width + x] = total / Math.max(1, count);
    }
  }

  return output;
}

function refineAlphaMap(alphaMap: Float32Array, width: number, height: number): Float32Array {
  const closed = minFilterFloatMap(maxFilterFloatMap(alphaMap, width, height, 1), width, height, 1);
  const opened = maxFilterFloatMap(minFilterFloatMap(closed, width, height, 1), width, height, 1);
  const blurred = blurFloatMap(opened, width, height, 1);
  const output = new Float32Array(alphaMap.length);

  for (let index = 0; index < alphaMap.length; index += 1) {
    const base = Math.max(alphaMap[index] ?? 0, (opened[index] ?? 0) * 0.92);
    let refined = clamp(blurred[index] * 0.72 + base * 0.48, 0, 1);
    if (base >= 0.96) {
      refined = Math.max(refined, base);
    }
    if (refined <= 0.03) {
      refined = 0;
    } else if (refined >= 0.985) {
      refined = 1;
    } else {
      refined = Math.pow(refined, 0.92);
    }
    output[index] = clamp(refined, 0, 1);
  }

  return output;
}

function computeAlphaBounds(
  alphaMap: Float32Array,
  width: number,
  height: number,
  threshold = 0.035,
): AlphaBounds | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let area = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if ((alphaMap[index] ?? 0) < threshold) {
        continue;
      }
      area += 1;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < minX || maxY < minY) {
    return null;
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    area,
  };
}

function expandBounds(
  bounds: AlphaBounds,
  width: number,
  height: number,
  padding = 2,
): AlphaBounds {
  const minX = clamp(bounds.minX - padding, 0, width - 1);
  const minY = clamp(bounds.minY - padding, 0, height - 1);
  const maxX = clamp(bounds.maxX + padding, 0, width - 1);
  const maxY = clamp(bounds.maxY + padding, 0, height - 1);
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    area: bounds.area,
  };
}

function cropRawRgba(source: Buffer, sourceWidth: number, bounds: AlphaBounds): Buffer {
  const output = Buffer.alloc(bounds.width * bounds.height * 4);
  for (let y = 0; y < bounds.height; y += 1) {
    for (let x = 0; x < bounds.width; x += 1) {
      const sourceIndex = ((bounds.minY + y) * sourceWidth + (bounds.minX + x)) * 4;
      const targetIndex = (y * bounds.width + x) * 4;
      output[targetIndex] = source[sourceIndex];
      output[targetIndex + 1] = source[sourceIndex + 1];
      output[targetIndex + 2] = source[sourceIndex + 2];
      output[targetIndex + 3] = source[sourceIndex + 3];
    }
  }
  return output;
}

function cropAlphaMap(
  source: Float32Array,
  sourceWidth: number,
  bounds: AlphaBounds,
): Float32Array {
  const output = new Float32Array(bounds.width * bounds.height);
  for (let y = 0; y < bounds.height; y += 1) {
    for (let x = 0; x < bounds.width; x += 1) {
      output[y * bounds.width + x] =
        source[(bounds.minY + y) * sourceWidth + (bounds.minX + x)] ?? 0;
    }
  }
  return output;
}

function decontaminateEdgePixels(data: Buffer, width: number, height: number): void {
  const original = Buffer.from(data);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const alpha = original[index + 3];
      if (alpha <= 0 || alpha >= 252) {
        continue;
      }

      let totalR = 0;
      let totalG = 0;
      let totalB = 0;
      let totalWeight = 0;

      for (let offsetY = -2; offsetY <= 2; offsetY += 1) {
        const sampleY = clamp(y + offsetY, 0, height - 1);
        for (let offsetX = -2; offsetX <= 2; offsetX += 1) {
          const sampleX = clamp(x + offsetX, 0, width - 1);
          const sampleIndex = (sampleY * width + sampleX) * 4;
          const sampleAlpha = original[sampleIndex + 3];
          if (sampleAlpha < 220) {
            continue;
          }
          const distance = Math.max(1, Math.abs(offsetX) + Math.abs(offsetY));
          const weight = (sampleAlpha / 255) * (1 / distance);
          totalR += original[sampleIndex] * weight;
          totalG += original[sampleIndex + 1] * weight;
          totalB += original[sampleIndex + 2] * weight;
          totalWeight += weight;
        }
      }

      if (totalWeight <= 0) {
        continue;
      }

      const blend = Math.pow(1 - alpha / 255, 0.72) * 0.82;
      data[index] = Math.round(original[index] * (1 - blend) + (totalR / totalWeight) * blend);
      data[index + 1] = Math.round(
        original[index + 1] * (1 - blend) + (totalG / totalWeight) * blend,
      );
      data[index + 2] = Math.round(
        original[index + 2] * (1 - blend) + (totalB / totalWeight) * blend,
      );
    }
  }
}

async function refinePreparedSource(prepared: PreparedSource): Promise<RefinedSource> {
  const decoded = await decodeRawRgba(prepared.buffer);
  const alphaSource = new Float32Array(decoded.width * decoded.height);
  for (let index = 0; index < alphaSource.length; index += 1) {
    alphaSource[index] = (decoded.data[index * 4 + 3] ?? 0) / 255;
  }

  const refinedAlpha = refineAlphaMap(alphaSource, decoded.width, decoded.height);
  const repaired = Buffer.from(decoded.data);
  for (let index = 0; index < refinedAlpha.length; index += 1) {
    const alpha = refinedAlpha[index] ?? 0;
    const rgbaIndex = index * 4;
    if (alpha <= 0.001) {
      repaired[rgbaIndex] = 0;
      repaired[rgbaIndex + 1] = 0;
      repaired[rgbaIndex + 2] = 0;
      repaired[rgbaIndex + 3] = 0;
      continue;
    }
    repaired[rgbaIndex + 3] = Math.round(alpha * 255);
  }

  decontaminateEdgePixels(repaired, decoded.width, decoded.height);

  const contentBounds = expandBounds(
    computeAlphaBounds(refinedAlpha, decoded.width, decoded.height, 0.035) || {
      minX: 0,
      minY: 0,
      maxX: decoded.width - 1,
      maxY: decoded.height - 1,
      width: decoded.width,
      height: decoded.height,
      area: decoded.width * decoded.height,
    },
    decoded.width,
    decoded.height,
    2,
  );

  const croppedRaw = cropRawRgba(repaired, decoded.width, contentBounds);
  const croppedAlpha = cropAlphaMap(refinedAlpha, decoded.width, contentBounds);
  const buffer = await sharp(croppedRaw, {
    raw: {
      width: contentBounds.width,
      height: contentBounds.height,
      channels: 4,
    },
  })
    .png()
    .toBuffer();

  return {
    buffer,
    raw: croppedRaw,
    width: contentBounds.width,
    height: contentBounds.height,
    alphaMap: croppedAlpha,
  };
}

async function createSoftUnderlayBuffer(params: {
  raw: Buffer;
  width: number;
  height: number;
  color: { r: number; g: number; b: number };
  opacity: number;
  blurRadius: number;
}): Promise<Buffer> {
  const tinted = Buffer.from(params.raw);
  for (let index = 0; index < tinted.length; index += 4) {
    const alpha = tinted[index + 3];
    if (alpha <= 0) {
      continue;
    }
    tinted[index] = params.color.r;
    tinted[index + 1] = params.color.g;
    tinted[index + 2] = params.color.b;
    tinted[index + 3] = Math.round(alpha * params.opacity);
  }

  return await sharp(tinted, {
    raw: {
      width: params.width,
      height: params.height,
      channels: 4,
    },
  })
    .blur(params.blurRadius)
    .png()
    .toBuffer();
}

function computeWeightedCentroid(alphaMap: Float32Array, width: number, height: number) {
  let total = 0;
  let totalX = 0;
  let totalY = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = alphaMap[y * width + x] ?? 0;
      if (alpha <= 0.035) {
        continue;
      }
      total += alpha;
      totalX += (x + 0.5) * alpha;
      totalY += (y + 0.5) * alpha;
    }
  }

  if (total <= 0) {
    return {
      x: 0.5,
      y: 0.5,
    };
  }

  return {
    x: totalX / total / width,
    y: totalY / total / height,
  };
}

function sampleContour(
  alphaMap: Float32Array,
  width: number,
  height: number,
  centroid: { x: number; y: number },
) {
  const points = [];
  const originX = centroid.x * width;
  const originY = centroid.y * height;
  const maxRadius = Math.max(width, height);

  for (let index = 0; index < 12; index += 1) {
    const angle = (Math.PI * 2 * index) / 12;
    let lastX = originX;
    let lastY = originY;
    for (let radius = 0; radius <= maxRadius; radius += 1) {
      const sampleX = Math.round(originX + Math.cos(angle) * radius);
      const sampleY = Math.round(originY + Math.sin(angle) * radius);
      if (sampleX < 0 || sampleY < 0 || sampleX >= width || sampleY >= height) {
        break;
      }
      if ((alphaMap[sampleY * width + sampleX] ?? 0) >= 0.12) {
        lastX = sampleX;
        lastY = sampleY;
      }
    }
    points.push({
      x: roundTo((lastX + 0.5) / width),
      y: roundTo((lastY + 0.5) / height),
    });
  }

  return points;
}

function deriveAssemblyProfile(params: {
  slot: WigForgeSlot;
  width: number;
  height: number;
  alphaMap: Float32Array;
}): WigForgeAssetAssemblyProfile {
  const bounds = computeAlphaBounds(params.alphaMap, params.width, params.height, 0.035) || {
    minX: 0,
    minY: 0,
    maxX: params.width - 1,
    maxY: params.height - 1,
    width: params.width,
    height: params.height,
    area: params.width * params.height,
  };
  const centroid = computeWeightedCentroid(params.alphaMap, params.width, params.height);
  const contentBounds = {
    x: roundTo(bounds.minX / params.width),
    y: roundTo(bounds.minY / params.height),
    width: roundTo(bounds.width / params.width),
    height: roundTo(bounds.height / params.height),
  };

  const centerX = roundTo((bounds.minX + bounds.maxX + 1) / 2 / params.width);
  const topY = roundTo((bounds.minY + 0.5) / params.height);
  const bottomY = roundTo((bounds.maxY + 0.5) / params.height);
  const pivotBySlot: Record<WigForgeSlot, { x: number; y: number; confidence: number }> = {
    head: { x: centerX, y: bottomY, confidence: 0.94 },
    face: { x: roundTo(centroid.x), y: roundTo(centroid.y), confidence: 0.88 },
    body: { x: centerX, y: topY, confidence: 0.9 },
    neck: { x: centerX, y: topY, confidence: 0.92 },
    companion: { x: roundTo(centroid.x), y: bottomY, confidence: 0.74 },
    aura: { x: roundTo(centroid.x), y: roundTo(centroid.y), confidence: 0.68 },
  };
  const desiredBySlot: Record<WigForgeSlot, { x: number; y: number; scale: number }> = {
    head: { x: 0.5, y: 0.88, scale: 1.08 },
    face: { x: 0.5, y: 0.5, scale: 1.02 },
    body: { x: 0.5, y: 0.18, scale: 1.04 },
    neck: { x: 0.5, y: 0.14, scale: 1.02 },
    companion: { x: 0.48, y: 0.78, scale: 0.94 },
    aura: { x: 0.5, y: 0.5, scale: 1.18 },
  };
  const pivot = pivotBySlot[params.slot];
  const desired = desiredBySlot[params.slot];
  const dominantDimension = Math.max(contentBounds.width, contentBounds.height);
  const scaleBoost = clamp(1 + (0.82 - dominantDimension) * 0.32, 0.88, 1.18);

  return {
    contentBounds,
    centroid: {
      x: roundTo(centroid.x),
      y: roundTo(centroid.y),
    },
    pivot,
    contour: sampleContour(params.alphaMap, params.width, params.height, centroid),
    mount: {
      translateX: roundTo((desired.x - pivot.x) * 100 * 0.9, 3),
      translateY: roundTo((desired.y - pivot.y) * 100 * 0.9, 3),
      scale: roundTo(desired.scale * scaleBoost, 3),
      rotate: 0,
      originX: roundTo(pivot.x * 100, 3),
      originY: roundTo(pivot.y * 100, 3),
    },
  };
}

function buildBinaryMask(alphaMap: Float32Array, threshold = 0.1): Uint8Array {
  const mask = new Uint8Array(alphaMap.length);
  for (let index = 0; index < alphaMap.length; index += 1) {
    mask[index] = (alphaMap[index] ?? 0) >= threshold ? 1 : 0;
  }
  return mask;
}

function pushEdge(
  startMap: Map<string, Array<{ sx: number; sy: number; ex: number; ey: number; used: boolean }>>,
  edge: { sx: number; sy: number; ex: number; ey: number; used: boolean },
) {
  const key = `${edge.sx},${edge.sy}`;
  const bucket = startMap.get(key);
  if (bucket) {
    bucket.push(edge);
    return;
  }
  startMap.set(key, [edge]);
}

function traceMaskLoops(
  mask: Uint8Array,
  width: number,
  height: number,
): Array<Array<{ x: number; y: number }>> {
  const edges: Array<{ sx: number; sy: number; ex: number; ey: number; used: boolean }> = [];
  const startMap = new Map<
    string,
    Array<{ sx: number; sy: number; ex: number; ey: number; used: boolean }>
  >();

  const filledAt = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) {
      return 0;
    }
    return mask[y * width + x] ?? 0;
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!filledAt(x, y)) {
        continue;
      }
      if (!filledAt(x, y - 1)) {
        const edge = { sx: x, sy: y, ex: x + 1, ey: y, used: false };
        edges.push(edge);
        pushEdge(startMap, edge);
      }
      if (!filledAt(x + 1, y)) {
        const edge = { sx: x + 1, sy: y, ex: x + 1, ey: y + 1, used: false };
        edges.push(edge);
        pushEdge(startMap, edge);
      }
      if (!filledAt(x, y + 1)) {
        const edge = { sx: x + 1, sy: y + 1, ex: x, ey: y + 1, used: false };
        edges.push(edge);
        pushEdge(startMap, edge);
      }
      if (!filledAt(x - 1, y)) {
        const edge = { sx: x, sy: y + 1, ex: x, ey: y, used: false };
        edges.push(edge);
        pushEdge(startMap, edge);
      }
    }
  }

  const loops: Array<Array<{ x: number; y: number }>> = [];
  for (const edge of edges) {
    if (edge.used) {
      continue;
    }
    edge.used = true;
    const loop: Array<{ x: number; y: number }> = [
      { x: edge.sx, y: edge.sy },
      { x: edge.ex, y: edge.ey },
    ];
    let current = edge;

    while (current.ex !== edge.sx || current.ey !== edge.sy) {
      const nextKey = `${current.ex},${current.ey}`;
      const candidates = startMap.get(nextKey) || [];
      const next = candidates.find((candidate) => !candidate.used);
      if (!next) {
        break;
      }
      next.used = true;
      current = next;
      loop.push({ x: current.ex, y: current.ey });
    }

    if (loop.length >= 4) {
      loops.push(simplifyLoop(loop));
    }
  }

  return loops;
}

function simplifyLoop(points: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  if (points.length <= 3) {
    return points;
  }

  const deduped: Array<{ x: number; y: number }> = [];
  for (const point of points) {
    const last = deduped[deduped.length - 1];
    if (!last || last.x !== point.x || last.y !== point.y) {
      deduped.push(point);
    }
  }

  const simplified: Array<{ x: number; y: number }> = [];
  for (let index = 0; index < deduped.length; index += 1) {
    const prev = deduped[(index - 1 + deduped.length) % deduped.length];
    const current = deduped[index];
    const next = deduped[(index + 1) % deduped.length];
    const isCollinear =
      (prev.x === current.x && current.x === next.x) ||
      (prev.y === current.y && current.y === next.y);
    if (!isCollinear) {
      simplified.push(current);
    }
  }

  return simplified.length >= 3 ? simplified : deduped;
}

function loopsToSvgPath(loops: Array<Array<{ x: number; y: number }>>): string {
  return loops
    .filter((loop) => loop.length >= 3)
    .map((loop) => {
      const [first, ...rest] = loop;
      const commands = [`M ${first.x} ${first.y}`];
      for (const point of rest) {
        commands.push(`L ${point.x} ${point.y}`);
      }
      commands.push("Z");
      return commands.join(" ");
    })
    .join(" ");
}

function formatSvgNumber(value: number): string {
  return Number.parseFloat(value.toFixed(2)).toString();
}

function midpoint(a: { x: number; y: number }, b: { x: number; y: number }) {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  };
}

function loopsToSmoothSvgPath(loops: Array<Array<{ x: number; y: number }>>): string {
  return loops
    .filter((loop) => loop.length >= 3)
    .map((loop) => {
      const normalized = simplifyLoop(loop);
      if (normalized.length < 3) {
        return "";
      }
      const start = midpoint(normalized[normalized.length - 1], normalized[0]);
      const commands = [`M ${formatSvgNumber(start.x)} ${formatSvgNumber(start.y)}`];
      for (let index = 0; index < normalized.length; index += 1) {
        const current = normalized[index];
        const next = normalized[(index + 1) % normalized.length];
        const mid = midpoint(current, next);
        commands.push(
          `Q ${formatSvgNumber(current.x)} ${formatSvgNumber(current.y)} ${formatSvgNumber(mid.x)} ${formatSvgNumber(mid.y)}`,
        );
      }
      commands.push("Z");
      return commands.join(" ");
    })
    .filter(Boolean)
    .join(" ");
}

function quantile(values: number[], ratio: number): number {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * ratio)));
  return sorted[index] ?? 0;
}

function luminanceForRgb(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function saturationForRgb(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max <= 0) {
    return 0;
  }
  return (max - min) / max;
}

function colorDistanceSquared(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return dr * dr + dg * dg + db * db;
}

function initializeRgbCentroids(
  samples: Array<{ r: number; g: number; b: number }>,
  targetCount: number,
): Array<{ r: number; g: number; b: number }> {
  if (!samples.length) {
    return [];
  }

  const centroids: Array<{ r: number; g: number; b: number }> = [samples[0]];
  while (centroids.length < targetCount) {
    let bestSample = samples[0];
    let bestDistance = -1;
    for (const sample of samples) {
      let nearest = Number.POSITIVE_INFINITY;
      for (const centroid of centroids) {
        nearest = Math.min(nearest, colorDistanceSquared(sample, centroid));
      }
      if (nearest > bestDistance) {
        bestDistance = nearest;
        bestSample = sample;
      }
    }
    centroids.push(bestSample);
  }

  return centroids;
}

function assignNearestCentroid(
  pixel: { r: number; g: number; b: number },
  centroids: Array<{ r: number; g: number; b: number }>,
): number {
  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < centroids.length; index += 1) {
    const distance = colorDistanceSquared(pixel, centroids[index]);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  }
  return nearestIndex;
}

function smoothRegionLabels(
  labels: Int16Array,
  alphaMap: Float32Array,
  width: number,
  height: number,
): Int16Array {
  const output = new Int16Array(labels);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      if ((alphaMap[index] ?? 0) < 0.18 || labels[index] < 0) {
        continue;
      }
      const counts = new Map<number, number>();
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (offsetX === 0 && offsetY === 0) {
            continue;
          }
          const neighbor = labels[(y + offsetY) * width + (x + offsetX)];
          if (neighbor < 0) {
            continue;
          }
          counts.set(neighbor, (counts.get(neighbor) || 0) + 1);
        }
      }
      let bestLabel = labels[index];
      let bestCount = 0;
      for (const [label, count] of counts.entries()) {
        if (count > bestCount) {
          bestCount = count;
          bestLabel = label;
        }
      }
      if (bestLabel !== labels[index] && bestCount >= 5) {
        output[index] = bestLabel;
      }
    }
  }
  return output;
}

function deriveColorRegionMasks(params: {
  raw: Buffer;
  alphaMap: Float32Array;
  width: number;
  height: number;
}) {
  const samples: Array<{ r: number; g: number; b: number }> = [];
  const significantIndices: number[] = [];
  let opaqueCount = 0;

  for (let index = 0; index < params.alphaMap.length; index += 1) {
    const alpha = params.alphaMap[index] ?? 0;
    if (alpha < 0.16) {
      continue;
    }
    opaqueCount += 1;
    if (samples.length >= 1200 && index % 3 !== 0) {
      continue;
    }
    const rgbaIndex = index * 4;
    samples.push({
      r: params.raw[rgbaIndex] ?? 0,
      g: params.raw[rgbaIndex + 1] ?? 0,
      b: params.raw[rgbaIndex + 2] ?? 0,
    });
  }

  if (!samples.length) {
    return [];
  }

  const clusterCount = Math.max(2, Math.min(4, Math.round(Math.sqrt(samples.length / 80)) + 1));
  let centroids = initializeRgbCentroids(samples, clusterCount);

  for (let iteration = 0; iteration < 5; iteration += 1) {
    const accumulators = centroids.map(() => ({ r: 0, g: 0, b: 0, count: 0 }));
    for (const sample of samples) {
      const index = assignNearestCentroid(sample, centroids);
      accumulators[index].r += sample.r;
      accumulators[index].g += sample.g;
      accumulators[index].b += sample.b;
      accumulators[index].count += 1;
    }
    centroids = centroids.map((centroid, index) => {
      const bucket = accumulators[index];
      if (!bucket.count) {
        return centroid;
      }
      return {
        r: bucket.r / bucket.count,
        g: bucket.g / bucket.count,
        b: bucket.b / bucket.count,
      };
    });
  }

  const labels = new Int16Array(params.width * params.height).fill(-1);
  for (let index = 0; index < params.alphaMap.length; index += 1) {
    const alpha = params.alphaMap[index] ?? 0;
    if (alpha < 0.16) {
      continue;
    }
    const rgbaIndex = index * 4;
    labels[index] = assignNearestCentroid(
      {
        r: params.raw[rgbaIndex] ?? 0,
        g: params.raw[rgbaIndex + 1] ?? 0,
        b: params.raw[rgbaIndex + 2] ?? 0,
      },
      centroids,
    );
    significantIndices.push(index);
  }

  const smoothedLabels = smoothRegionLabels(labels, params.alphaMap, params.width, params.height);
  const minArea = Math.max(12, Math.round(opaqueCount * 0.028));

  return centroids
    .map((_, clusterIndex) => {
      const mask = new Uint8Array(params.width * params.height);
      let totalR = 0;
      let totalG = 0;
      let totalB = 0;
      let weightedArea = 0;
      let area = 0;
      for (const pixelIndex of significantIndices) {
        if (smoothedLabels[pixelIndex] !== clusterIndex) {
          continue;
        }
        const alpha = params.alphaMap[pixelIndex] ?? 0;
        const rgbaIndex = pixelIndex * 4;
        mask[pixelIndex] = 1;
        totalR += (params.raw[rgbaIndex] ?? 0) * alpha;
        totalG += (params.raw[rgbaIndex + 1] ?? 0) * alpha;
        totalB += (params.raw[rgbaIndex + 2] ?? 0) * alpha;
        weightedArea += alpha;
        area += 1;
      }

      if (area < minArea || weightedArea <= 0) {
        return null;
      }

      const color = {
        r: totalR / weightedArea,
        g: totalG / weightedArea,
        b: totalB / weightedArea,
      };

      return {
        mask,
        area,
        color,
        luminance: luminanceForRgb(color.r, color.g, color.b),
        saturation: saturationForRgb(color.r, color.g, color.b),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .sort((left, right) => left.luminance - right.luminance);
}

function buildLuminanceMask(params: {
  raw: Buffer;
  alphaMap: Float32Array;
  width: number;
  height: number;
  predicate: (
    luminance: number,
    alpha: number,
    thresholds: { low: number; high: number },
  ) => boolean;
}): Uint8Array {
  const luminances: number[] = [];
  for (let index = 0; index < params.alphaMap.length; index += 1) {
    const alpha = params.alphaMap[index] ?? 0;
    if (alpha < 0.16) {
      continue;
    }
    const rgbaIndex = index * 4;
    luminances.push(
      luminanceForRgb(
        params.raw[rgbaIndex] ?? 0,
        params.raw[rgbaIndex + 1] ?? 0,
        params.raw[rgbaIndex + 2] ?? 0,
      ),
    );
  }

  const thresholds = {
    low: quantile(luminances, 0.28),
    high: quantile(luminances, 0.74),
  };

  const mask = new Uint8Array(params.width * params.height);
  for (let index = 0; index < mask.length; index += 1) {
    const alpha = params.alphaMap[index] ?? 0;
    if (alpha < 0.16) {
      continue;
    }
    const rgbaIndex = index * 4;
    const luminance = luminanceForRgb(
      params.raw[rgbaIndex] ?? 0,
      params.raw[rgbaIndex + 1] ?? 0,
      params.raw[rgbaIndex + 2] ?? 0,
    );
    mask[index] = params.predicate(luminance, alpha, thresholds) ? 1 : 0;
  }
  return mask;
}

function deriveVectorSvg(params: {
  raw: Buffer;
  width: number;
  height: number;
  alphaMap: Float32Array;
  palette: string[];
  accentColor: string;
}): string {
  const silhouetteLoops = traceMaskLoops(
    buildBinaryMask(params.alphaMap, 0.1),
    params.width,
    params.height,
  );
  const silhouettePath = loopsToSmoothSvgPath(silhouetteLoops);
  if (!silhouettePath) {
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${params.width} ${params.height}" width="${params.width}" height="${params.height}">`,
      `<rect width="${params.width}" height="${params.height}" rx="8" fill="${params.palette[0] || "#d7d1ca"}"/>`,
      `</svg>`,
    ].join("");
  }

  const colorRegions = deriveColorRegionMasks({
    raw: params.raw,
    alphaMap: params.alphaMap,
    width: params.width,
    height: params.height,
  });

  const shadowPath = loopsToSmoothSvgPath(
    traceMaskLoops(
      buildLuminanceMask({
        raw: params.raw,
        alphaMap: params.alphaMap,
        width: params.width,
        height: params.height,
        predicate(luminance, alpha, thresholds) {
          return alpha >= 0.22 && luminance <= thresholds.low;
        },
      }),
      params.width,
      params.height,
    ),
  );
  const highlightPath = loopsToSmoothSvgPath(
    traceMaskLoops(
      buildLuminanceMask({
        raw: params.raw,
        alphaMap: params.alphaMap,
        width: params.width,
        height: params.height,
        predicate(luminance, alpha, thresholds) {
          return alpha >= 0.18 && luminance >= thresholds.high;
        },
      }),
      params.width,
      params.height,
    ),
  );

  const baseColor = params.palette[0] || "#d7d1ca";
  const accent = params.palette[1] || params.accentColor || "#f6c983";
  const shadow = params.palette[2] || "#372b26";
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${params.width} ${params.height}" width="${params.width}" height="${params.height}" fill="none">`,
    `<defs>`,
    `<filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">`,
    `<feGaussianBlur in="SourceAlpha" stdDeviation="1.75" result="blur"/>`,
    `<feOffset dx="0" dy="1" result="offset"/>`,
    `<feComponentTransfer><feFuncA type="linear" slope="0.2"/></feComponentTransfer>`,
    `</filter>`,
    `</defs>`,
    `<path d="${silhouettePath}" fill="${baseColor}" fill-rule="evenodd" clip-rule="evenodd" filter="url(#softShadow)"/>`,
  ];
  for (const region of colorRegions) {
    const regionPath = loopsToSmoothSvgPath(
      traceMaskLoops(region.mask, params.width, params.height),
    );
    if (!regionPath) {
      continue;
    }
    const fill = normalizeRgbToHex(region.color.r, region.color.g, region.color.b);
    const opacity = clamp(0.82 + region.saturation * 0.22, 0.82, 0.98);
    parts.push(
      `<path d="${regionPath}" fill="${fill}" opacity="${formatSvgNumber(opacity)}" fill-rule="evenodd" clip-rule="evenodd"/>`,
    );
  }
  if (shadowPath) {
    parts.push(
      `<path d="${shadowPath}" fill="${shadow}" opacity="0.32" fill-rule="evenodd" clip-rule="evenodd"/>`,
    );
  }
  if (highlightPath) {
    parts.push(
      `<path d="${highlightPath}" fill="${accent}" opacity="0.24" fill-rule="evenodd" clip-rule="evenodd"/>`,
    );
  }
  parts.push(
    `<path d="${silhouettePath}" stroke="${params.accentColor || accent}" stroke-opacity="0.32" stroke-width="1.1" fill="none" vector-effect="non-scaling-stroke"/>`,
  );
  parts.push(`</svg>`);
  return parts.join("");
}

async function renderVariantSprite(params: {
  sourceBuffer: Buffer;
  sourceRaw: Buffer;
  width: number;
  height: number;
  visuals: WigForgeVisualVariant;
}): Promise<Buffer> {
  const base = await sharp(params.sourceBuffer, { failOnError: false })
    .ensureAlpha()
    .sharpen({ sigma: 1.05, m1: 0.4, m2: 1.1, x1: 2, y2: 10, y3: 20 })
    .png()
    .toBuffer();

  if (params.visuals.fxPreset === "none") {
    return base;
  }

  const { r, g, b } = hexToRgb(params.visuals.accentColor);
  const underlay = await createSoftUnderlayBuffer({
    raw: params.sourceRaw,
    width: params.width,
    height: params.height,
    color: { r, g, b },
    opacity:
      params.visuals.fxPreset === "soft-sheen"
        ? 0.08
        : params.visuals.fxPreset === "pulse"
          ? 0.12
          : params.visuals.fxPreset === "soft-sparkle"
            ? 0.15
            : params.visuals.fxPreset === "neon-halo"
              ? 0.18
              : params.visuals.fxPreset === "starfall"
                ? 0.2
                : 0.16,
    blurRadius:
      params.visuals.fxPreset === "soft-sheen"
        ? 3
        : params.visuals.fxPreset === "pulse"
          ? 5
          : params.visuals.fxPreset === "soft-sparkle"
            ? 7
            : params.visuals.fxPreset === "neon-halo"
              ? 9
              : params.visuals.fxPreset === "starfall"
                ? 11
                : 8,
  });

  return await sharp({
    create: {
      width: params.width,
      height: params.height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      { input: underlay, blend: "over" },
      { input: base, blend: "over" },
    ])
    .png()
    .toBuffer();
}

export async function mintForgeAsset(params: {
  toolCallId: string;
  input: WigForgeMintInput;
  config: WigForgeResolvedConfig;
  store: WigForgeStore;
  agentId?: string;
}): Promise<WigForgeAsset> {
  const prepared = await prepareSourceImage(params.input, params.config);
  const refinedSource = await refinePreparedSource(prepared);
  const duplicateCount = await params.store.countByFingerprint(prepared.sourceFingerprint);
  const styleTags = sanitizeStyleTags(params.input.styleTags);
  const slot = inferSlot({
    slotHint: params.input.slotHint,
    nameHint: params.input.nameHint,
    styleTags,
    width: refinedSource.width,
    height: refinedSource.height,
  });

  const variantSeed = hashHex(
    `${params.toolCallId}:${prepared.sourceFingerprint}:${params.agentId ?? "unknown-agent"}:${styleTags.join("|")}`,
  ).slice(0, 20);
  const palette = await derivePalette(refinedSource.buffer, variantSeed);
  const luck = clamp01(
    typeof params.input.luck === "number" ? params.input.luck : seededUnitInterval(variantSeed, 0),
  );
  const rolled = rollRarity({
    novelty:
      typeof params.input.novelty === "number"
        ? params.input.novelty
        : params.config.defaultNovelty,
    duplicateCount,
    maskQuality:
      typeof params.input.maskQuality === "number"
        ? params.input.maskQuality
        : params.config.defaultMaskQuality,
    taskQuality:
      typeof params.input.taskQuality === "number"
        ? params.input.taskQuality
        : params.config.defaultTaskQuality,
    styleFit:
      typeof params.input.styleFit === "number"
        ? params.input.styleFit
        : clamp01(0.42 + Math.min(styleTags.length, 4) * 0.12),
    luck,
  });
  const visuals = createVisualVariant({
    slot,
    rarity: rolled.rarity,
    palette,
    seed: variantSeed,
  });
  const spriteBuffer = await renderVariantSprite({
    sourceBuffer: refinedSource.buffer,
    sourceRaw: refinedSource.raw,
    width: refinedSource.width,
    height: refinedSource.height,
    visuals,
  });
  const previewBuffer = await sharp(spriteBuffer)
    .resize({ width: 512, height: 512, fit: "inside" })
    .png()
    .toBuffer();
  const vectorSvg = deriveVectorSvg({
    raw: refinedSource.raw,
    width: refinedSource.width,
    height: refinedSource.height,
    alphaMap: refinedSource.alphaMap,
    palette,
    accentColor: visuals.accentColor,
  });
  const assetId = `wig_asset_${hashHex(`${variantSeed}:${Date.now()}`).slice(0, 12)}`;
  const filePaths = await params.store.saveAssetFiles({
    assetId,
    sourceBuffer: refinedSource.buffer,
    sourceExt: path.extname(`x${prepared.extension}`),
    spriteBuffer,
    previewBuffer,
    svgText: vectorSvg,
  });
  const assembly = deriveAssemblyProfile({
    slot,
    width: refinedSource.width,
    height: refinedSource.height,
    alphaMap: refinedSource.alphaMap,
  });

  return {
    id: assetId,
    ownerAgentId: params.agentId,
    name: buildAssetName({
      slot,
      rarity: rolled.rarity,
      visuals,
      nameHint: params.input.nameHint,
    }),
    slot,
    rarity: rolled.rarity,
    originUrl: typeof params.input.originUrl === "string" ? params.input.originUrl : undefined,
    sourceFingerprint: prepared.sourceFingerprint,
    variantSeed,
    styleTags,
    palette,
    files: {
      ...filePaths,
      mimeType: prepared.mimeType,
      width: refinedSource.width,
      height: refinedSource.height,
    },
    visuals,
    assembly,
    score: {
      novelty:
        typeof params.input.novelty === "number"
          ? clamp01(params.input.novelty)
          : params.config.defaultNovelty,
      duplicatePenalty: rolled.duplicatePenalty,
      effectiveNovelty: rolled.effectiveNovelty,
      maskQuality:
        typeof params.input.maskQuality === "number"
          ? clamp01(params.input.maskQuality)
          : params.config.defaultMaskQuality,
      taskQuality:
        typeof params.input.taskQuality === "number"
          ? clamp01(params.input.taskQuality)
          : params.config.defaultTaskQuality,
      styleFit:
        typeof params.input.styleFit === "number"
          ? clamp01(params.input.styleFit)
          : clamp01(0.42 + Math.min(styleTags.length, 4) * 0.12),
      luck,
      finalScore: rolled.score,
    },
    createdAt: new Date().toISOString(),
  };
}
