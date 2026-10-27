/**
 * Attachment header owner benchmark; no Gateway, filesystem staging, or worker queue.
 * node --import ./scripts/tsx.mjs scripts/perf/attachment-header-measure.ts \
 *   --iterations 1000 --output "$PWD/.local/header-base.json"
 * Repeat with --allocations for a separate main-thread sampled-JS-allocation pass.
 * --owner-dir reads captured src/media/attachment-processor.runtime.ts, preserving
 * its original import URL. This direct-owner benchmark does not start workers.
 * Each message contains three deterministic 700x700 noise PNGs below the offload
 * threshold. Warm-up, fixture generation, and a separate exact base64 decode-byte
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
  },
});
assert(values.output, "--output is required");
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0, "--iterations must be positive");
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
const pixels = Buffer.alloc(700 * 700 * 3);
let seed = 547;
for (let index = 0; index < pixels.length; index++) {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  pixels[index] = seed & 255;
}
const png = encodePngRgb(pixels, 700, 700);
assert(png.byteLength < 2_000_000, "fixture must remain inline");
const files = Array.from({ length: 3 }, (_, index) => ({
  base64: png.toString("base64"),
  label: `synthetic-${index}.png`,
  mime: "image/png",
}));
const run = async () => {
  for (const file of files) {
    const prepared = await prepareAttachment(file);
    assert.equal(prepared.mime, "image/png");
    assert.equal(prepared.width, 700);
    assert.equal(prepared.height, 700);
    assert.equal(prepared.sizeBytes, png.byteLength);
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
  fixture: { filesPerMessage: files.length, bytesPerMessage: png.byteLength * files.length },
  decodedBytesPerMessage: decodedBytes,
  decodeCallsPerMessage: decodeCalls,
  mainThreadCpuMsPerMessage: (cpu.user + cpu.system) / 1000 / iterations,
  processCpuMsPerMessage: (processCpu.user + processCpu.system) / 1000 / iterations,
  sampledJsBytesPerMessage: sampledJsBytes === undefined ? undefined : sampledJsBytes / iterations,
  latencyMs: {
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
