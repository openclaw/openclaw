/**
 * Warm history-image sanitation: real owner, synthetic PNGs, no Gateway or provider.
 * Run from the checkout: node --expose-gc --import ./scripts/tsx.mjs \
 *   scripts/perf/prompt-image-sanitation-measure.ts cpu [owner-path]
 * Repeat with allocation for a separate 4 KiB allocation sampling pass (including
 * collected objects). Optional owner-path is a pristine baseline module beside
 * tool-images.ts so its relative imports resolve against the same dependencies.
 * Compare five alternating base/candidate runs per mode. Each run prepares twelve
 * distinct 96x96 PNGs, warms 50 turns, then sanitizes 2,000 turns. Canonical and
 * whitespace-bearing history are separate cases. Output bytes are checked before
 * timing. Accept reduced CPU/allocation with identical outputs and changed-input
 * regression proof; report host load and absolute GC deltas, not tiny percentages.
 * Add --responses after owner-path to include Responses request construction and
 * sanitation over 48 user messages and twelve retained images. Compare wireSha256
 * between revisions; this exercises source identity across the sanitation boundary.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { buildOpenAIResponsesParams } from "../../packages/ai/src/transports/openai-responses-params-internal.js";
import { sanitizeResponsesImagePayload } from "../../packages/ai/src/transports/responses-image-payload-sanitizer.js";
import type { Context, ImageContent, Model } from "../../packages/llm-core/src/types.js";
import { createNoisyPngBuffer } from "../../test/helpers/image-fixtures.js";

const mode = process.argv[2];
assert(mode === "cpu" || mode === "allocation", "mode must be cpu or allocation");
assert(globalThis.gc, "--expose-gc required");
const owner = resolve(process.argv[3] ?? "src/agents/tool-images.ts");
const { sanitizeContentBlocksImages } = (await import(
  pathToFileURL(owner).href
)) as typeof import("../../src/agents/tool-images.js");
const iterations = 2_000;
const responses = process.argv.includes("--responses");
const model: Model = {
  id: "fixture-model",
  name: "Synthetic",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text", "image"],
  contextWindow: 200000,
  maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const images = Array.from({ length: 12 }, (_, index) => ({
  type: "image" as const,
  data: createNoisyPngBuffer(96, 96 + index).toString("base64"),
  mimeType: "image/png",
}));
const inspector = new Session();
inspector.connect();
function allocated(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
}
for (const dialect of ["canonical", "whitespace"] as const) {
  const blocks = images.map((image) =>
    Object.freeze({
      ...image,
      data:
        dialect === "canonical"
          ? image.data
          : `${image.data.slice(0, 128)}\n${image.data.slice(128)}`,
    }),
  );
  const turn = async () => {
    const sanitized = await sanitizeContentBlocksImages(blocks, "bench:history", {
      verifyDecodability: true,
    });
    if (!responses) {
      return sanitized;
    }
    const preparedImages = sanitized.filter(
      (block): block is ImageContent => block.type === "image",
    );
    const context: Context = {
      messages: Array.from({ length: 48 }, (_, index) => ({
        role: "user",
        timestamp: index,
        content: [
          { type: "text", text: `Question ${index}: `.padEnd(1024, "x") },
          ...(index % 4 === 0 ? preparedImages.slice(index / 4, index / 4 + 1) : []),
        ],
      })),
    };
    return sanitizeResponsesImagePayload(buildOpenAIResponsesParams(model, context, undefined));
  };
  assert.deepEqual(
    await sanitizeContentBlocksImages(blocks, "bench:history", { verifyDecodability: true }),
    images,
  );
  const first = await turn();
  const wire = JSON.stringify(first);
  assert.equal(JSON.stringify(await turn()), wire);
  const wireSha256 = createHash("sha256").update(wire).digest("hex");
  for (let i = 0; i < 50; i++) {
    await turn();
  }
  globalThis.gc();
  await setImmediate();
  let gcMs = 0;
  let gcCount = 0;
  let gcMaxMs = 0;
  const gcByKind = new Map<number, { count: number; ms: number }>();
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gcMs += entry.duration;
      gcCount++;
      gcMaxMs = Math.max(gcMaxMs, entry.duration);
      const kind = (entry as PerformanceEntry & { detail: { kind: number } }).detail.kind;
      const totals = gcByKind.get(kind) ?? { count: 0, ms: 0 };
      totals.count++;
      totals.ms += entry.duration;
      gcByKind.set(kind, totals);
    }
  });
  observer.observe({ entryTypes: ["gc"] });
  if (mode === "allocation") {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const cpuStart = process.cpuUsage();
  const started = performance.now();
  for (let i = 0; i < iterations; i++) {
    await turn();
  }
  const elapsedMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuStart);
  const sampledBytes =
    mode === "allocation"
      ? allocated((await inspector.post("HeapProfiler.stopSampling")).profile.head)
      : undefined;
  await setImmediate();
  await setImmediate();
  observer.disconnect();
  console.log(
    JSON.stringify({
      owner,
      mode,
      dialect,
      responses,
      wireSha256,
      iterations,
      images: images.length,
      base64BytesPerTurn: images.reduce((sum, image) => sum + image.data.length, 0),
      cpuUsPerTurn: (cpu.user + cpu.system) / iterations,
      elapsedMs,
      sampledBytesPerTurn: sampledBytes === undefined ? undefined : sampledBytes / iterations,
      gcMs,
      gcCount,
      gcMaxMs,
      gcByKind: [...gcByKind].map(([kind, totals]) => ({
        kind,
        count: totals.count,
        ms: totals.ms,
      })),
      load: loadavg(),
      memory: process.memoryUsage(),
    }),
  );
}
inspector.disconnect();
