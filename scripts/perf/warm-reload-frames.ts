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
export type ReloadAnimationSample = {
  atMs: number;
  animations: Array<
    ReloadRegion & {
      key: string;
      signature: string;
      kind: "shimmer" | "fade";
      active: boolean;
    }
  >;
};
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
type Tracker = { states: State[]; timeline: Transition[]; last?: State; comparisonPixels?: Pixels };

function matchingFadePixels(a: Pixels, b: Pixels, region: ReloadRegion) {
  let count = 0,
    sumA = 0,
    sumB = 0,
    squareA = 0,
    squareB = 0,
    product = 0;
  for (let y = region.y; y < region.y + region.height; y++) {
    for (let x = region.x; x < region.x + region.width; x++) {
      const offset = (y * a.width + x) * 4;
      const left =
        a.data[offset]! * 0.2126 + a.data[offset + 1]! * 0.7152 + a.data[offset + 2]! * 0.0722;
      const right =
        b.data[offset]! * 0.2126 + b.data[offset + 1]! * 0.7152 + b.data[offset + 2]! * 0.0722;
      count++;
      sumA += left;
      sumB += right;
      squareA += left * left;
      squareB += right * right;
      product += left * right;
    }
  }
  if (!count) {
    return false;
  }
  const varianceA = squareA - (sumA * sumA) / count;
  const varianceB = squareB - (sumB * sumB) / count;
  // Blank/faint pixels cannot establish that content already painted, even when DOM matches.
  return (
    Math.min(varianceA, varianceB) / count >= 16 &&
    (product - (sumA * sumB) / count) / Math.sqrt(varianceA * varianceB) >= 0.999
  );
}

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
  adjacent = false,
) {
  const whole: Tracker = { states: [], timeline: [] };
  const byRegion = new Map(
    regions.map((region) => [region.name, { states: [], timeline: [] } as Tracker]),
  );
  function baseline(
    tracker: Tracker,
    pixels: Pixels,
    region: ReloadRegion,
    comparisonMask: Uint8Array,
  ) {
    if (!adjacent) {
      return tracker.last?.pixels;
    }
    const previous = tracker.comparisonPixels;
    if (!previous || comparisonMask === mask) {
      return previous;
    }
    let normalized: Uint8Array | undefined;
    // Normalize this region's animation pixels without advancing its unexplained changes.
    for (let y = region.y; y < region.y + region.height; y++) {
      for (let x = region.x; x < region.x + region.width; x++) {
        const index = y * pixels.width + x;
        if (comparisonMask[index] && !mask[index]) {
          normalized ??= previous.data.slice();
          normalized.set(pixels.data.subarray(index * 4, index * 4 + 4), index * 4);
        }
      }
    }
    if (normalized) {
      tracker.comparisonPixels = { ...previous, data: normalized };
    }
    return tracker.comparisonPixels;
  }
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
    if (adjacent) {
      tracker.comparisonPixels = pixels;
    }
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
    consume(frame: ReloadFrame, pixels: Pixels, comparisonMask = mask) {
      const same = (a: Pixels, b: Pixels, box: ReloadRegion) =>
        !compare(a, b, box, mask, threshold, true).significant;
      const changedRegions: string[] = [];
      for (const region of regions) {
        const tracker = byRegion.get(region.name)!;
        const previous = baseline(tracker, pixels, region, comparisonMask);
        const difference = previous
          ? compare(previous, pixels, region, comparisonMask, threshold)
          : { changedPixels: 0, comparedPixels: 0, significant: true };
        if (difference.significant) {
          changedRegions.push(region.name);
          accept(tracker, frame, pixels, difference, [region.name], (old) =>
            same(old, pixels, region),
          );
        }
      }
      const previous = baseline(whole, pixels, viewport, comparisonMask);
      const difference = previous
        ? compare(previous, pixels, viewport, comparisonMask, threshold)
        : { changedPixels: 0, comparedPixels: 0, significant: true };
      const accepted = difference.significant || changedRegions.length > 0;
      if (accepted) {
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

async function contactSheets(states: State[], directory: string, prefix = "contact-sheet") {
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
      const name = `${prefix}-${String(files.length + 1).padStart(2, "0")}.png`;
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
  animationSamples?: ReloadAnimationSample[];
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
  let visible: ReturnType<typeof classifier> | undefined;
  let sampleIndex = -1;
  let previousAnimations: ReloadAnimationSample["animations"] = [];
  let previousCapturedPixels: Pixels | undefined;
  const animationSamples = options.animationSamples ?? [];
  if (
    animationSamples.some(
      (sample, index) =>
        !Number.isFinite(sample.atMs) ||
        (index > 0 && sample.atMs < animationSamples[index - 1]!.atMs),
    )
  ) {
    throw new Error("Animation samples must have finite times in capture order");
  }
  const suppressedAnimationPairs: Array<{ atMs: number; rectangles: ReloadMask[] }> = [];
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
        visible = classifier(viewport, regions, mask, threshold, true);
      } else if (pixels.width !== width || pixels.height !== height) {
        throw new Error(`Frame dimensions changed: ${frame.file}`);
      }
      masked.consume(frame, pixels);
      unmasked!.consume(frame, pixels);
      while (
        animationSamples[sampleIndex + 1]?.atMs !== undefined &&
        animationSamples[sampleIndex + 1]!.atMs <= frame.atMs
      ) {
        sampleIndex++;
      }
      const currentAnimations = animationSamples[sampleIndex]?.animations ?? [];
      const rectangles = currentAnimations.flatMap((animation) => {
        const previous = previousAnimations.find((candidate) => candidate.key === animation.key);
        if (
          !previous ||
          !(previous.active || animation.active) ||
          previous.signature !== animation.signature ||
          previous.kind !== animation.kind ||
          ["x", "y", "width", "height"].some(
            (key) => Reflect.get(previous, key) !== Reflect.get(animation, key),
          )
        ) {
          return [];
        }
        const rectangle = clipped(animation, width, height);
        if (
          animation.kind === "fade" &&
          (!previousCapturedPixels ||
            !matchingFadePixels(previousCapturedPixels, pixels, rectangle))
        ) {
          return [];
        }
        return [
          {
            ...rectangle,
            reason: `${animation.kind}: same element, content, appearance and geometry`,
          },
        ];
      });
      const comparisonMask = rectangles.length ? mask.slice() : mask;
      for (const box of rectangles) {
        for (let y = box.y; y < box.y + box.height; y++) {
          comparisonMask.fill(1, y * width + box.x, y * width + box.x + box.width);
        }
      }
      if (rectangles.length) {
        suppressedAnimationPairs.push({ atMs: frame.atMs, rectangles });
      }
      visible!.consume(frame, pixels, comparisonMask);
      previousAnimations = currentAnimations;
      previousCapturedPixels = pixels;
    } finally {
      image.free();
    }
  }
  await mkdir(options.outputDir, { recursive: true });
  const visibleResult = suppressedAnimationPairs.length ? visible! : masked!;
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
    visibleChangeCensus: {
      ...visibleResult.report(),
      method:
        "Captured-frame pixel changes with attributed animation pixels normalized between adjacent captures; unexplained changes accumulate. This is a heuristic, not semantic or compositor-paint proof; inspect original pixels.",
      animationPolicy:
        "Only the same animation target with unchanged content, appearance and geometry on both samples qualifies. Fades additionally require actual pixel luminance standard deviation >=4 on both captures and Pearson correlation >=0.999. Blank/faint or changed spatial patterns remain changes. Shimmer phase may be grouped for explicit skeleton targets. DOM/frame correlation may be stale; original pixels and inspection remain authoritative.",
      animationSamples: animationSamples.length,
      suppressedAnimationPairs,
      contactSheets: await contactSheets(
        visibleResult.whole.states,
        options.outputDir,
        "visible-contact-sheet",
      ),
    },
    contactSheets: await contactSheets(masked!.whole.states, options.outputDir),
  };
}
