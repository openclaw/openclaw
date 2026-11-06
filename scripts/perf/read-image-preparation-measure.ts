// Embedded read-tool image preparation benchmark on generated photo, screenshot, and alpha images.
// node --import ./scripts/tsx.mjs scripts/perf/read-image-preparation-measure.ts [--owner saved-image-resize.ts]
// --reads defaults to 12 measured reads per fixture (the cheap controls read 20x as often), after
// --warmup 2; one process takes about 30-50 s. Reads use the default image sanitization limit (1200 px).
// --owner loads a saved src/agents/utils/image-resize.ts through this checkout's read tool. An owner that
// predates processImage's maxDimensionPx option ignores the value read.ts passes, so the run delivers that
// revision's image and hint; compare resultDigest with that revision's own checkout to confirm.
// Run base/candidate in counterbalanced fresh processes (ABBA). Acceptance: fewer encodes per read and
// less wall/process CPU for images over the limit, a hint that names the delivered size, and identical
// resultDigest for controls (within the limit and the inline byte budget).
// The JSON report is the last stdout line; image sanitization log lines can precede it. File logs go to
// the temporary workspace, not the shared default log.
// This measures createCoreCodingTools(...).read on a temporary workspace: file read, processImage, and the
// wrapper's image sanitization. Process CPU includes image-worker threads; encodes are calls to
// createImageProcessor().encode, one image-worker task each. It does not measure cold worker start,
// image quality, model upload or token cost, provider latency, sandboxed reads, or Gateway overhead.
// The workload uses no Gateway, model, credentials, or network.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg, tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  createRastermill,
  encodePngRgba as encodeRgbaPng,
  readImageProbeFromHeader,
  type EncodedImage,
  type EncodeOptions,
} from "rastermill";
import { applyLoggingConfig } from "../../src/logging/logger.js";
import { encodePngRgb, encodePngRgba } from "../../src/media/png-encode.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    reads: { type: "string", default: "12" },
    warmup: { type: "string", default: "2" },
    fixture: { type: "string", multiple: true },
    "tmp-dir": { type: "string" },
    "keep-fixtures": { type: "boolean", default: false },
  },
});
const reads = parseStrictIntegerOption({ raw: values.reads, fallback: 12, label: "reads", min: 1 });
const warmup = parseStrictIntegerOption({
  raw: values.warmup,
  fallback: 2,
  label: "warmup",
  min: 1,
});
const workspace = mkdtempSync(path.join(values["tmp-dir"] ?? tmpdir(), "read-image-measure-"));
if (!values["keep-fixtures"]) {
  process.once("exit", () => rmSync(workspace, { recursive: true, force: true }));
}
// Keep the sanitizer's file log in this run's workspace; its write cost stays in both arms.
applyLoggingConfig({ file: path.join(workspace, "openclaw.log") });

// Swap the processImage owner, and count image encodes at the processor that both
// processImage and the wrapper's resizeToJpeg reach. The real processor loads under a query URL.
const ownerUrl = new URL("../../src/agents/utils/image-resize.ts", import.meta.url);
const ownerSource = readFileSync(values.owner ?? ownerUrl, "utf8");
const processorUrl = new URL("../../src/media/image-processor.ts", import.meta.url);
const uncountedProcessorUrl = `${processorUrl.href}?read-image-measure=uncounted`;
const encodeObserverKey = "openclaw.perf.read-image-encode";
type EncodeRecord = { request: string; output?: string };
let encodes: EncodeRecord[] = [];
Object.defineProperty(globalThis, Symbol.for(encodeObserverKey), {
  value(options: EncodeOptions | undefined) {
    const side = options?.resize?.maxSide ?? options?.limits?.maxWidth ?? "source";
    const quality = options && "quality" in options ? ` q${options.quality}` : "";
    const record: EncodeRecord = { request: `${options?.format ?? "auto"}<=${side}${quality}` };
    encodes.push(record);
    return (output: EncodedImage) => {
      const chosen = output.chosen.quality === undefined ? "" : ` q${output.chosen.quality}`;
      record.output = `${output.format} ${output.width}x${output.height}${chosen}`;
    };
  },
});
const processorShim = `
import { createImageProcessor as createUncountedImageProcessor } from ${JSON.stringify(uncountedProcessorUrl)};
export * from ${JSON.stringify(uncountedProcessorUrl)};
const observeEncode = globalThis[Symbol.for(${JSON.stringify(encodeObserverKey)})];
export function createImageProcessor() {
  const processor = createUncountedImageProcessor();
  return {
    ...processor,
    async encode(input, options) {
      const settle = observeEncode(options);
      const output = await processor.encode(input, options);
      settle(output);
      return output;
    },
  };
}
`;
const loaded = { owner: false, shim: false, processor: false };
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url === ownerUrl.href) {
      loaded.owner = true;
      return { format: "module", source: stripTypeScriptTypes(ownerSource), shortCircuit: true };
    }
    if (url === processorUrl.href) {
      loaded.shim = true;
      return { format: "module", source: processorShim, shortCircuit: true };
    }
    if (url === uncountedProcessorUrl) {
      loaded.processor = true;
    }
    return nextLoad(url, context);
  },
});
const processStartedAt = performance.now();
const { createCoreCodingTools } = await import("../../src/agents/core-coding-tools.js");
const importMs = performance.now() - processStartedAt;

// Deterministic fixtures: seeded value noise for photos, drawn panels/glyphs for screenshots.
function createRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bilinear value noise over a width x height raster, interleaved by channel. */
function valueNoise(width: number, height: number, cell: number, channels: number, seed: number) {
  const random = createRandom(seed);
  const columns = Math.ceil(width / cell) + 2;
  const grid = Float32Array.from(
    { length: columns * (Math.ceil(height / cell) + 2) * channels },
    random,
  );
  const out = new Float32Array(width * height * channels);
  for (let y = 0, index = 0; y < height; y++) {
    const y0 = Math.floor(y / cell);
    const ty = y / cell - y0;
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x / cell);
      const tx = x / cell - x0;
      for (let channel = 0; channel < channels; channel++, index++) {
        const top = (y0 * columns + x0) * channels + channel;
        const bottom = top + columns * channels;
        const upper = grid[top]! + (grid[top + channels]! - grid[top]!) * tx;
        const lower = grid[bottom]! + (grid[bottom + channels]! - grid[bottom]!) * tx;
        out[index] = upper + (lower - upper) * ty;
      }
    }
  }
  return out;
}

/** Broad scene colors, mid-frequency texture, and per-pixel sensor noise as RGBA. */
function drawPhoto(width: number, height: number, seed: number): Uint8Array {
  const scene = valueNoise(width, height, Math.round(width / 24), 3, seed);
  const texture = valueNoise(width, height, 9, 1, seed + 1);
  const noise = createRandom(seed + 2);
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    const detail = (texture[pixel]! - 0.5) * 60 + (noise() - 0.5) * 18;
    for (let channel = 0; channel < 3; channel++) {
      pixels[pixel * 4 + channel] = 30 + scene[pixel * 3 + channel]! * 200 + detail;
    }
    pixels[pixel * 4 + 3] = 255;
  }
  return new Uint8Array(pixels.buffer);
}

/** Dark sidebar, header, glyph rows, buttons, and a photo card; RGBA with an optional alpha frame. */
function drawScreenshot(width: number, height: number, seed: number, alpha: boolean): Buffer {
  const random = createRandom(seed);
  const pixels = Buffer.alloc(width * height * 4);
  const sidebar = Math.round(width * 0.18);
  const card = {
    left: Math.round(width * 0.58),
    top: Math.round(height * 0.22),
    right: Math.round(width * 0.94),
    bottom: Math.round(height * 0.58),
  };
  const cardPhoto = drawPhoto(card.right - card.left, card.bottom - card.top, seed + 3);
  const glyphs = Array.from({ length: 64 }, () => Math.floor(random() * 0x7fff) | 0x2001);
  const lineGlyphs = Array.from({ length: Math.ceil(height / 26) }, () =>
    Array.from({ length: 160 }, () => (random() < 0.16 ? -1 : Math.floor(random() * 64))),
  );
  const inset = alpha ? 96 : 0;
  const radius = 28;
  for (let y = 0, offset = 0; y < height; y++) {
    for (let x = 0; x < width; x++, offset += 4) {
      let color: [number, number, number];
      if (x < sidebar) {
        color = [32, 36, 44];
      } else if (y < 56) {
        color = [50, 56, 66];
      } else if (x >= card.left && x < card.right && y >= card.top && y < card.bottom) {
        const index = ((y - card.top) * (card.right - card.left) + (x - card.left)) * 4;
        color = [cardPhoto[index]!, cardPhoto[index + 1]!, cardPhoto[index + 2]!];
      } else if (y > height - 120 && y < height - 80 && x > sidebar + 40 && x < sidebar + 220) {
        color = [59, 130, 246];
      } else {
        color = [246, 247, 249];
      }
      const line = Math.floor(y / 26);
      const row = y % 26;
      const column = Math.floor((x - (x < sidebar ? 16 : sidebar + 32)) / 8);
      if (row >= 8 && row < 18 && column >= 0 && column < 160 && y >= 80) {
        const glyph = lineGlyphs[line]![column]!;
        const bit = Math.floor((row - 8) / 2) * 3 + Math.floor((x % 8) / 2);
        if (glyph >= 0 && x % 8 < 6 && (glyphs[glyph]! >> bit) & 1) {
          color = x < sidebar ? [210, 214, 220] : [40, 44, 52];
        }
      }
      let opacity = 255;
      if (alpha) {
        // Rounded window over a transparent desktop, with a soft drop shadow.
        const dx = Math.max(inset + radius - x, 0, x - (width - inset - radius - 1));
        const dy = Math.max(inset + radius - y, 0, y - (height - inset - radius - 1));
        const outside = Math.hypot(dx, dy) - radius;
        if (outside > 0) {
          color = [0, 0, 0];
          opacity = Math.max(0, Math.round(96 * (1 - outside / 40)));
        }
      }
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = opacity;
    }
  }
  if (alpha) {
    return encodePngRgba(pixels, width, height);
  }
  const rgb = Buffer.alloc(width * height * 3);
  for (let source = 0, target = 0; source < pixels.length; source += 4, target += 3) {
    pixels.copy(rgb, target, source, source + 3);
  }
  return encodePngRgb(rgb, width, height);
}

const fixtureGenerator = createRastermill({ execution: "internal" });
async function encodePhoto(width: number, height: number, seed: number) {
  const source = encodeRgbaPng(drawPhoto(width, height, seed), width, height, 1);
  return (await fixtureGenerator.encode(source, { format: "jpeg", quality: 90 })).data;
}

// The default image sanitization side and processImage's inline payload budget.
const LIMIT_SIDE = 1200;
const MAX_INLINE_BASE64_BYTES = 4.5 * 1024 * 1024;
const fixtureSpecs = [
  {
    name: "photo-4032x3024.jpg",
    resized: true,
    repeat: 1,
    make: () => encodePhoto(4032, 3024, 11),
  },
  {
    name: "ui-2880x1800.png",
    resized: true,
    repeat: 1,
    make: async () => drawScreenshot(2880, 1800, 21, false),
  },
  {
    name: "alpha-2400x1600.png",
    resized: true,
    repeat: 1,
    make: async () => drawScreenshot(2400, 1600, 31, true),
  },
  {
    name: "ui-1920x1080.png",
    resized: true,
    repeat: 1,
    make: async () => drawScreenshot(1920, 1080, 41, false),
  },
  {
    name: "control-ui-1200x750.png",
    resized: false,
    repeat: 20,
    make: async () => drawScreenshot(1200, 750, 61, false),
  },
  {
    name: "control-photo-1100x800.jpg",
    resized: false,
    repeat: 20,
    make: () => encodePhoto(1100, 800, 51),
  },
];
const selected = values.fixture ?? fixtureSpecs.map((spec) => spec.name);
for (const name of selected) {
  assert(
    fixtureSpecs.some((spec) => spec.name === name),
    `unknown fixture ${name}`,
  );
}
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
type Fixture = (typeof fixtureSpecs)[number] & {
  width: number;
  height: number;
  format: string;
  bytes: number;
  sha256: string;
};
const fixtures: Fixture[] = [];
for (const spec of fixtureSpecs.filter((candidate) => selected.includes(candidate.name))) {
  const data = await spec.make();
  const probe = readImageProbeFromHeader(data);
  assert(probe, `${spec.name}: generated image must probe`);
  const base64Bytes = 4 * Math.ceil(data.byteLength / 3);
  const overLimits =
    Math.max(probe.width, probe.height) > LIMIT_SIDE || base64Bytes > MAX_INLINE_BASE64_BYTES;
  assert.equal(overLimits, spec.resized, `${spec.name}: fixture class`);
  writeFileSync(path.join(workspace, spec.name), data);
  fixtures.push({
    ...spec,
    width: probe.width,
    height: probe.height,
    format: probe.format,
    bytes: data.byteLength,
    sha256: sha256(data).slice(0, 16),
  });
}
const fixtureMs = performance.now() - processStartedAt - importMs;
for (const fixture of fixtures) {
  process.stderr.write(
    `[read-image-measure] fixture ${fixture.name} ${fixture.width}x${fixture.height} ${fixture.format} ${fixture.bytes} B sha256:${fixture.sha256}\n`,
  );
}

const read = createCoreCodingTools({
  codingRoot: workspace,
  containmentRoot: workspace,
  includeBaseCodingTools: true,
  shellTools: "disabled",
  readOnly: true,
  applyPatchEnabled: false,
  applyPatchWorkspaceOnly: true,
  workspaceOnly: true,
  execDefaults: {},
  processDefaults: {},
  modelHasVision: true,
}).find((tool) => tool.name === "read");
assert(read, "createCoreCodingTools must return the read tool");

type Sample = { wallMs: number; processCpuMs: number; mainThreadCpuMs: number };
type Observation = {
  digest: string;
  encodes: EncodeRecord[];
  texts: string[];
  image?: { mimeType: string; data: string };
};
async function readOnce(name: string, toolCallId: string): Promise<Sample & Observation> {
  encodes = [];
  const cpu = process.cpuUsage();
  const thread = process.threadCpuUsage();
  const startedAt = performance.now();
  const result = await read!.execute(toolCallId, { path: name });
  const wallMs = performance.now() - startedAt;
  const threadUsed = process.threadCpuUsage(thread);
  const cpuUsed = process.cpuUsage(cpu);
  const texts = result.content.flatMap((block) => (block.type === "text" ? [block.text] : []));
  const image = result.content.find((block) => block.type === "image");
  return {
    wallMs,
    processCpuMs: (cpuUsed.user + cpuUsed.system) / 1000,
    mainThreadCpuMs: (threadUsed.user + threadUsed.system) / 1000,
    digest: sha256(JSON.stringify(result.content)),
    encodes,
    texts,
    image: image && { mimeType: image.mimeType, data: image.data },
  };
}

const hostLoadBefore = loadavg();
const startedAt = performance.now();
const first = new Map<string, Observation>();
for (const fixture of fixtures) {
  for (let index = 0; index < warmup; index++) {
    const observation = await readOnce(fixture.name, `warmup-${index}`);
    first.set(fixture.name, first.get(fixture.name) ?? observation);
  }
}
hooks.deregister();
assert.deepEqual(loaded, { owner: true, shim: true, processor: true }, "hooked modules loaded");

const samples = new Map(fixtures.map((fixture) => [fixture.name, [] as Sample[]]));
for (let round = 0; round < reads; round++) {
  // Rotate the fixture order each round so drift does not favor one fixture.
  for (let offset = 0; offset < fixtures.length; offset++) {
    const fixture = fixtures[(round + offset) % fixtures.length]!;
    for (let repeat = 0; repeat < fixture.repeat; repeat++) {
      const sample = await readOnce(fixture.name, `read-${round}-${repeat}`);
      const expected = first.get(fixture.name)!;
      assert.equal(sample.digest, expected.digest, `${fixture.name}: deterministic result`);
      assert.deepEqual(sample.encodes, expected.encodes, `${fixture.name}: same encodes`);
      samples.get(fixture.name)!.push(sample);
    }
  }
}
const measuredWallMs = performance.now() - startedAt;
const hostLoadAfter = loadavg();

const round1 = (value: number) => Math.round(value * 10) / 10;
function summarize(measurements: number[]) {
  const sorted = measurements.toSorted((left, right) => left - right);
  return {
    median: round1(sorted[Math.ceil(sorted.length * 0.5) - 1]!),
    p95: round1(sorted[Math.ceil(sorted.length * 0.95) - 1]!),
    min: round1(sorted[0]!),
    max: round1(sorted.at(-1)!),
  };
}
const HINT =
  /\[Image: original (\d+)x(\d+), displayed at (\d+)x(\d+)\. Multiply coordinates by ([\d.]+) to map to original image\.\]/;
const results = fixtures.map((fixture) => {
  const observation = first.get(fixture.name)!;
  const fixtureSamples = samples.get(fixture.name)!;
  const image = observation.image;
  const probe = image ? readImageProbeFromHeader(Buffer.from(image.data, "base64")) : null;
  assert(!image || probe, `${fixture.name}: delivered image must probe`);
  const hint = observation.texts.join("\n").match(HINT);
  return {
    name: fixture.name,
    source: {
      width: fixture.width,
      height: fixture.height,
      format: fixture.format,
      bytes: fixture.bytes,
      sha256: fixture.sha256,
    },
    reads: fixtureSamples.length,
    wallMs: summarize(fixtureSamples.map((sample) => sample.wallMs)),
    processCpuMs: summarize(fixtureSamples.map((sample) => sample.processCpuMs)),
    mainThreadCpuMs: summarize(fixtureSamples.map((sample) => sample.mainThreadCpuMs)),
    encodesPerRead: observation.encodes.length,
    encodes: observation.encodes.map((record) => `${record.request} -> ${record.output}`),
    delivered:
      image && probe
        ? {
            mimeType: image.mimeType,
            width: probe.width,
            height: probe.height,
            base64Length: image.data.length,
            sha256: sha256(image.data).slice(0, 16),
          }
        : null,
    texts: observation.texts,
    hint: hint?.[0] ?? null,
    // A hint is correct when it names the delivered size and original/delivered width.
    hintMatchesDelivered:
      probe !== null &&
      (hint
        ? Number(hint[3]) === probe.width &&
          Number(hint[4]) === probe.height &&
          hint[5] === (fixture.width / probe.width).toFixed(2)
        : fixture.width === probe.width),
    resultDigest: observation.digest,
  };
});
console.log(
  JSON.stringify({
    scope: "embedded read tool image preparation; no Gateway, model, or provider",
    owner: values.owner ?? "checkout",
    ownerSha256: sha256(ownerSource),
    reads,
    warmup,
    node: process.version,
    workspace: values["keep-fixtures"] ? workspace : undefined,
    importMs: round1(importMs),
    fixtureMs: round1(fixtureMs),
    measuredWallMs: round1(measuredWallMs),
    rssMiB: round1(process.memoryUsage().rss / 1024 / 1024),
    hostLoadBefore,
    hostLoadAfter,
    fixtures: results,
  }),
);
