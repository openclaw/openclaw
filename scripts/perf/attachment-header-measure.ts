/**
 * Attachment header owner benchmark; no Gateway, filesystem staging, or worker queue.
 * node --import ./scripts/tsx.mjs scripts/perf/attachment-header-measure.ts \
 *   --format jpeg --iterations 1000 --output "$PWD/.local/header-base.json"
 * Repeat with --allocations for a separate main-thread sampled-JS-allocation pass.
 * --owner-dir reads captured src/media/attachment-processor.runtime.ts, preserving
 * its original import URL. This direct-owner benchmark does not start workers.
 * --format png (default) preserves three 700x700 noise PNGs below the offload
 * threshold. jpeg/webp use 1600x1200 noise encoded by Rastermill; gif uses a
 * 1000x700 three-frame indexed animation. These formats use explicit inline
 * storage, exercising metadata-only decoding even for multi-MB payloads.
 * Warm-up, fixture generation, and a separate exact base64 decode-byte
 * count pass are excluded from timing and sampling. Buffer backing stores are not
 * represented by the sampled JS allocation count; report exact decoded bytes too.
 * --expose-gc adds an untimed post-GC memory snapshot after measurement.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "1000" },
    output: { type: "string" },
    allocations: { type: "boolean", default: false },
    "owner-dir": { type: "string" },
    format: { type: "string", default: "png" },
  },
});
assert(values.output, "--output is required");
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0, "--iterations must be positive");
const format = values.format;
assert(["png", "jpeg", "gif", "webp"].includes(format), "--format must be png, jpeg, gif, or webp");
const ownerPath = "src/media/attachment-processor.runtime.ts";
const ownerUrl = new URL(`../../${ownerPath}`, import.meta.url);
const source = await fs.readFile(
  values["owner-dir"] ? path.resolve(values["owner-dir"], ownerPath) : ownerUrl,
  "utf8",
);
const ownerReceipt = {
  path: ownerPath,
  sha256: createHash("sha256").update(source).digest("hex"),
  overlayLoads: 0,
};
if (values["owner-dir"]) {
  const { transformSync } = await import("esbuild");
  const { code } = transformSync(source, {
    loader: "ts",
    format: "esm",
    target: "esnext",
    sourcefile: ownerPath,
  });
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (url === ownerUrl.href) {
        loaded.source = code;
        ownerReceipt.overlayLoads++;
      }
      return loaded;
    },
  });
}
const { prepareAttachment } = await import("../../src/media/attachment-processor.runtime.js");
if (values["owner-dir"]) {
  assert.equal(ownerReceipt.overlayLoads, 1, "captured owner must replace exactly one module");
}
const { encodePngRgb } = await import("../../src/media/png-encode.js");
let seed = 547;
function nextByte(): number {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return seed & 255;
}
function animatedGif(width: number, height: number): Buffer {
  const header = Buffer.from("47494638396100000000f70000", "hex");
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  const palette = Buffer.from(Array.from({ length: 768 }, nextByte));
  const chunks = [header, palette];
  for (let frame = 0; frame < 3; frame++) {
    const descriptor = Buffer.from("2c000000000000000000", "hex");
    descriptor.writeUInt16LE(width, 5);
    descriptor.writeUInt16LE(height, 7);
    chunks.push(Buffer.from("21f904000a000000", "hex"), descriptor, Buffer.from([8]));
    // Reset before the dictionary reaches 512 entries, keeping every code 9 bits.
    const pixels = width * height;
    const codes = pixels + Math.ceil(pixels / 200) + 1;
    const data = Buffer.alloc(Math.ceil((codes * 9) / 8));
    let bits = 0;
    let pending = 0;
    let offset = 0;
    const writeCode = (code: number) => {
      pending |= code << bits;
      bits += 9;
      while (bits >= 8) {
        data[offset++] = pending & 255;
        pending >>>= 8;
        bits -= 8;
      }
    };
    for (let pixel = 0; pixel < pixels; pixel++) {
      if (pixel % 200 === 0) {
        writeCode(256);
      }
      writeCode(nextByte());
    }
    writeCode(257);
    if (bits > 0) {
      data[offset++] = pending & 255;
    }
    for (let start = 0; start < offset; start += 255) {
      const block = data.subarray(start, Math.min(start + 255, offset));
      chunks.push(Buffer.from([block.length]), block);
    }
    chunks.push(Buffer.from([0]));
  }
  return Buffer.concat([...chunks, Buffer.from([0x3b])]);
}
const width = format === "png" ? 700 : format === "gif" ? 1000 : 1600;
const height = format === "png" || format === "gif" ? 700 : 1200;
let bytes: Buffer;
if (format === "gif") {
  bytes = animatedGif(width, height);
} else {
  const pixels = Buffer.alloc(width * height * 3);
  for (let index = 0; index < pixels.length; index++) {
    pixels[index] = nextByte();
  }
  const png = encodePngRgb(pixels, width, height);
  if (format === "png") {
    bytes = png;
  } else {
    const { createRastermill } = await import("rastermill");
    bytes = (
      await createRastermill({ execution: "internal" }).encode(
        png,
        format === "jpeg" ? { format: "jpeg", quality: 95 } : { format: "webp" },
      )
    ).data;
  }
}
assert(bytes.byteLength <= 6 * 1024 * 1024, "fixture must remain under the image limit");
assert(
  format !== "png" || bytes.byteLength < 2_000_000,
  "PNG fixture must remain below offload threshold",
);
const files = Array.from({ length: 3 }, (_, index) => ({
  base64: bytes.toString("base64"),
  label: `synthetic-${index}.${format}`,
  mime: `image/${format}`,
  ...(format === "png" ? {} : { imageStorage: "inline" as const }),
}));
const run = async () => {
  for (const file of files) {
    const prepared = await prepareAttachment(file);
    assert.equal(prepared.mime, `image/${format}`);
    assert.equal(prepared.width, width);
    assert.equal(prepared.height, height);
    assert.equal(prepared.sizeBytes, bytes.byteLength);
    assert.equal(prepared.buffer, undefined);
  }
};
for (let index = 0; index < 10; index++) {
  await run();
}
let decodedBytes = 0;
let decodeCalls = 0;
const originalFrom = Object.getOwnPropertyDescriptor(Buffer, "from");
assert.ok(originalFrom);
try {
  Buffer.from = new Proxy(Buffer.from.bind(Buffer), {
    apply(target, receiver, args: unknown[]) {
      const result: unknown = Reflect.apply(target, receiver, args);
      if (typeof args[0] === "string" && args[1] === "base64" && Buffer.isBuffer(result)) {
        decodedBytes += result.byteLength;
        decodeCalls++;
      }
      return result;
    },
  });
  await run();
} finally {
  Object.defineProperty(Buffer, "from", originalFrom);
}
const inspector = values.allocations ? new Session() : undefined;
inspector?.connect();
await inspector?.post("HeapProfiler.startSampling", {
  samplingInterval: 32768,
  includeObjectsCollectedByMajorGC: true,
  includeObjectsCollectedByMinorGC: true,
});
const before = process.memoryUsage();
const loadBefore = loadavg();
const cpuBefore = process.threadCpuUsage();
const processBefore = process.cpuUsage();
const timings: number[] = [];
for (let index = 0; index < iterations; index++) {
  const started = performance.now();
  await run();
  timings.push(performance.now() - started);
}
const cpu = process.threadCpuUsage(cpuBefore);
const processCpu = process.cpuUsage(processBefore);
const after = process.memoryUsage();
let sampledJsBytes: number | undefined;
if (inspector) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  sampledJsBytes = 0;
  const pending = [profile.head];
  for (const node of pending) {
    sampledJsBytes += node.selfSize;
    pending.push(...node.children);
  }
  inspector.disconnect();
}
timings.sort((left, right) => left - right);
let afterGc: ReturnType<typeof process.memoryUsage> | undefined;
if (globalThis.gc) {
  globalThis.gc();
  afterGc = process.memoryUsage();
}
const result = {
  kind: "attachment-header-owner",
  iterations,
  allocations: values.allocations,
  ownerReceipt,
  fixture: {
    format,
    ...(format === "gif" ? { frames: 3 } : {}),
    ...(format === "webp" ? { firstChunk: bytes.toString("ascii", 12, 16) } : {}),
    width,
    height,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    filesPerMessage: files.length,
    bytesPerAttachment: bytes.byteLength,
    bytesPerMessage: bytes.byteLength * files.length,
  },
  attachments: iterations * files.length,
  decodedBytesPerMessage: decodedBytes,
  decodedBytesPerAttachment: decodedBytes / files.length,
  decodeCallsPerMessage: decodeCalls,
  mainThreadCpuMsPerMessage: (cpu.user + cpu.system) / 1000 / iterations,
  processCpuMsPerMessage: (processCpu.user + processCpu.system) / 1000 / iterations,
  sampledJsBytesPerMessage: sampledJsBytes === undefined ? undefined : sampledJsBytes / iterations,
  mainThreadCpuMsPerAttachment: (cpu.user + cpu.system) / 1000 / iterations / files.length,
  sampledJsBytesPerAttachment:
    sampledJsBytes === undefined ? undefined : sampledJsBytes / iterations / files.length,
  latencyMs: {
    unit: "three-attachment-message",
    count: timings.length,
    p50: timings[Math.ceil(iterations * 0.5) - 1],
    p99: timings[Math.ceil(iterations * 0.99) - 1],
    max: timings.at(-1),
  },
  memory: { before, after, afterGc },
  hostLoad: { before: loadBefore, after: loadavg() },
};
await fs.mkdir(path.dirname(path.resolve(values.output)), { recursive: true });
await fs.writeFile(values.output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
