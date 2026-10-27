import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import photon from "@silvia-odwyer/photon-node";

export type ReloadFrame = { file: string; atMs: number };
export type ReloadRegion = {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
};
export type ReloadMask = ReloadRegion & { reason: string };
type Pixels = { width: number; height: number; data: Uint8Array };
type Threshold = { channelThreshold: number; minChangedPixels: number; minChangedRatio: number };
type Difference = { changedPixels: number; comparedPixels: number; significant: boolean };
type State = ReloadFrame & { id: number; pixels: Pixels };
type Transition = {
  atMs: number;
  frame: string;
  stateId: number;
  changedPixels: number;
  comparedPixels: number;
  regions: string[];
};
type Tracker = { states: State[]; timeline: Transition[]; last?: State };

function clipped(region: ReloadRegion, width: number, height: number): ReloadRegion {
  const left = Math.max(0, Math.min(width, Math.floor(region.x)));
  const top = Math.max(0, Math.min(height, Math.floor(region.y)));
  return {
    name: region.name,
    x: left,
    y: top,
    width: Math.max(0, Math.min(width, Math.ceil(region.x + region.width)) - left),
    height: Math.max(0, Math.min(height, Math.ceil(region.y + region.height)) - top),
  };
}

function compare(
  a: Pixels,
  b: Pixels,
  region: ReloadRegion,
  mask: Uint8Array,
  threshold: Threshold,
  early = false,
): Difference {
  let changedPixels = 0;
  let comparedPixels = 0;
  // Count against the unmasked area, so a mask cannot dilute a region's threshold.
  for (let y = region.y; y < region.y + region.height; y++) {
    for (let x = region.x; x < region.x + region.width; x++) {
      if (!mask[y * a.width + x]) {
        comparedPixels++;
      }
    }
  }
  const required = Math.max(
    threshold.minChangedPixels,
    Math.ceil(comparedPixels * threshold.minChangedRatio),
  );
  for (let y = region.y; y < region.y + region.height; y++) {
    for (let x = region.x; x < region.x + region.width; x++) {
      const pixel = y * a.width + x;
      if (mask[pixel]) {
        continue;
      }
      const offset = pixel * 4;
      if (
        Math.abs(a.data[offset]! - b.data[offset]!) > threshold.channelThreshold ||
        Math.abs(a.data[offset + 1]! - b.data[offset + 1]!) > threshold.channelThreshold ||
        Math.abs(a.data[offset + 2]! - b.data[offset + 2]!) > threshold.channelThreshold ||
        Math.abs(a.data[offset + 3]! - b.data[offset + 3]!) > threshold.channelThreshold
      ) {
        changedPixels++;
        if (early && changedPixels >= required) {
          return { changedPixels, comparedPixels, significant: true };
        }
      }
    }
  }
  return { changedPixels, comparedPixels, significant: changedPixels >= required };
}

function summarize(tracker: Tracker) {
  return {
    distinctStates: tracker.states.length,
    transitionCount: Math.max(0, tracker.timeline.length - 1),
    lastVisualChangeMs: tracker.timeline.at(-1)?.atMs ?? null,
    states: tracker.states.map(({ id, atMs, file }) => ({ id, atMs, frame: path.basename(file) })),
    timeline: tracker.timeline,
  };
}

function classifier(
  viewport: ReloadRegion,
  regions: ReloadRegion[],
  mask: Uint8Array,
  threshold: Threshold,
) {
  const whole: Tracker = { states: [], timeline: [] };
  const byRegion = new Map(
    regions.map((region) => [region.name, { states: [], timeline: [] } as Tracker]),
  );
  const same = (a: Pixels, b: Pixels, box: ReloadRegion) =>
    !compare(a, b, box, mask, threshold, true).significant;
  function accept(
    tracker: Tracker,
    frame: ReloadFrame,
    pixels: Pixels,
    difference: Difference,
    changedRegions: string[],
    matches: (old: Pixels) => boolean,
  ) {
    let state = tracker.states.find((candidate) => matches(candidate.pixels));
    if (!state) {
      state = { ...frame, id: tracker.states.length, pixels };
      tracker.states.push(state);
    }
    tracker.last = state;
    tracker.timeline.push({
      atMs: frame.atMs,
      frame: path.basename(frame.file),
      stateId: state.id,
      changedPixels: difference.changedPixels,
      comparedPixels: difference.comparedPixels,
      regions: changedRegions,
    });
  }
  return {
    whole,
    consume(frame: ReloadFrame, pixels: Pixels) {
      const changedRegions: string[] = [];
      for (const region of regions) {
        const tracker = byRegion.get(region.name)!;
        const difference = tracker.last
          ? compare(tracker.last.pixels, pixels, region, mask, threshold)
          : { changedPixels: 0, comparedPixels: 0, significant: true };
        if (difference.significant) {
          changedRegions.push(region.name);
          accept(tracker, frame, pixels, difference, [region.name], (old) =>
            same(old, pixels, region),
          );
        }
      }
      const difference = whole.last
        ? compare(whole.last.pixels, pixels, viewport, mask, threshold)
        : { changedPixels: 0, comparedPixels: 0, significant: true };
      if (difference.significant || changedRegions.length) {
        accept(
          whole,
          frame,
          pixels,
          difference,
          changedRegions,
          (old) =>
            same(old, pixels, viewport) && regions.every((region) => same(old, pixels, region)),
        );
      }
    },
    report() {
      return {
        ...summarize(whole),
        regions: Object.fromEntries(
          [...byRegion].map(([name, tracker]) => [name, summarize(tracker)]),
        ),
      };
    },
  };
}

async function contactSheets(states: State[], directory: string) {
  const files: string[] = [];
  const { width, height } = states[0]!.pixels;
  const labelHeight = 44;
  // Native-size tiles preserve tiny shifts; pages bound the raster allocation.
  for (let start = 0; start < states.length; start += 6) {
    const page = states.slice(start, start + 6);
    const columns = Math.min(2, page.length);
    const sheetWidth = width * columns;
    const sheetHeight = (height + labelHeight) * Math.ceil(page.length / columns);
    const pixels = new Uint8Array(sheetWidth * sheetHeight * 4);
    for (let offset = 0; offset < pixels.length; offset += 4) {
      pixels.set([35, 38, 43, 255], offset);
    }
    for (const [index, state] of page.entries()) {
      const tileX = (index % columns) * width;
      const tileY = Math.floor(index / columns) * (height + labelHeight);
      for (let y = 0; y < height; y++) {
        pixels.set(
          state.pixels.data.subarray(y * width * 4, (y + 1) * width * 4),
          ((tileY + labelHeight + y) * sheetWidth + tileX) * 4,
        );
      }
    }
    const image = new photon.PhotonImage(pixels, sheetWidth, sheetHeight);
    try {
      for (const [index, state] of page.entries()) {
        photon.draw_text(
          image,
          `State ${state.id} | ${state.atMs.toFixed(1)} ms`,
          (index % columns) * width + 8,
          Math.floor(index / columns) * (height + labelHeight) + 8,
          22,
        );
      }
      const name = `contact-sheet-${String(files.length + 1).padStart(2, "0")}.png`;
      await writeFile(path.join(directory, name), image.get_bytes());
      files.push(name);
    } finally {
      image.free();
    }
  }
  return files;
}

export async function analyzeReloadFrames(options: {
  frames: ReloadFrame[];
  regions: ReloadRegion[];
  masks: ReloadMask[];
  outputDir: string;
  channelThreshold?: number;
  minChangedPixels?: number;
  minChangedRatio?: number;
}) {
  const threshold = {
    channelThreshold: options.channelThreshold ?? 12,
    minChangedPixels: options.minChangedPixels ?? 32,
    minChangedRatio: options.minChangedRatio ?? 0.00005,
  };
  if (
    !options.frames.length ||
    !Number.isFinite(threshold.channelThreshold) ||
    threshold.channelThreshold < 0 ||
    threshold.channelThreshold > 255 ||
    !Number.isInteger(threshold.minChangedPixels) ||
    threshold.minChangedPixels < 1 ||
    !Number.isFinite(threshold.minChangedRatio) ||
    threshold.minChangedRatio < 0 ||
    threshold.minChangedRatio > 1
  ) {
    throw new Error("Frames and valid pixel thresholds are required");
  }
  if (new Set(options.regions.map((region) => region.name)).size !== options.regions.length) {
    throw new Error("Region names must be unique");
  }
  for (const box of [...options.regions, ...options.masks]) {
    if (
      ![box.x, box.y, box.width, box.height].every(Number.isFinite) ||
      box.width < 0 ||
      box.height < 0
    ) {
      throw new Error(`Invalid rectangle: ${box.name}`);
    }
  }
  let width = 0;
  let height = 0;
  let regions: ReloadRegion[] = [];
  let mask = new Uint8Array();
  let masked: ReturnType<typeof classifier> | undefined;
  let unmasked: ReturnType<typeof classifier> | undefined;
  let lastTime = -Infinity;
  for (const frame of options.frames) {
    if (!Number.isFinite(frame.atMs) || frame.atMs < lastTime) {
      throw new Error("Frames must have finite, navigation-relative times in capture order");
    }
    lastTime = frame.atMs;
    const image = photon.PhotonImage.new_from_byteslice(await readFile(frame.file));
    try {
      const pixels = {
        width: image.get_width(),
        height: image.get_height(),
        data: image.get_raw_pixels(),
      };
      if (!masked) {
        width = pixels.width;
        height = pixels.height;
        regions = options.regions.map((region) => clipped(region, width, height));
        const viewport = { name: "viewport", x: 0, y: 0, width, height };
        mask = new Uint8Array(width * height);
        for (const value of options.masks) {
          const box = clipped(value, width, height);
          for (let y = box.y; y < box.y + box.height; y++) {
            mask.fill(1, y * width + box.x, y * width + box.x + box.width);
          }
        }
        masked = classifier(viewport, regions, mask, threshold);
        unmasked = classifier(viewport, regions, new Uint8Array(width * height), threshold);
      } else if (pixels.width !== width || pixels.height !== height) {
        throw new Error(`Frame dimensions changed: ${frame.file}`);
      }
      masked.consume(frame, pixels);
      unmasked!.consume(frame, pixels);
    } finally {
      image.free();
    }
  }
  await mkdir(options.outputDir, { recursive: true });
  return {
    width,
    height,
    capturedFrames: options.frames.length,
    thresholds: threshold,
    comparison:
      "RGBA channel delta, against last accepted representative; unique states match any prior representative",
    regionBounds: regions,
    masks: options.masks.map((box) => ({ ...clipped(box, width, height), reason: box.reason })),
    maskedPixels: mask.reduce((sum, value) => sum + value, 0),
    ...masked!.report(),
    unmasked: unmasked!.report(),
    contactSheets: await contactSheets(masked!.whole.states, options.outputDir),
  };
}
