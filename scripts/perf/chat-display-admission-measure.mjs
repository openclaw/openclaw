/**
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/chat-display-admission-measure.mjs
 * Add --allocation for a separate sampled-allocation pass (including collected objects).
 * Add --owner-source <saved-core.ts> to load a baseline at the canonical owner URL.
 * Run baseline/candidate in alternating order with identical --operations (default 3000).
 * Acceptance: identical output hash, lower allocation or thread CPU, no material timing harm.
 * Measures the real display owner on a synthetic 200-row Team-shaped history page, not RPC
 * latency: user/assistant/tool output, attachments, compaction, commentary, and display content.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { performance, PerformanceObserver } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "owner-source": { type: "string" },
    operations: { type: "string", default: "3000" },
    allocation: { type: "boolean", default: false },
  },
});
assert(global.gc, "Run with --expose-gc");
const operations = Number(values.operations);
assert(Number.isSafeInteger(operations) && operations > 0, "Invalid --operations");
const ownerUrl = new URL("../../src/gateway/chat-display-projection.core.ts", import.meta.url);
const source = readFileSync(
  values["owner-source"] ? resolve(values["owner-source"]) : ownerUrl,
  "utf8",
);
if (values["owner-source"]) {
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      return url === ownerUrl.href ? { ...loaded, format: "module-typescript", source } : loaded;
    },
  });
}
const { projectChatDisplayMessagesWithState: project } = await import(ownerUrl.href);
const text = (value) => ({ type: "text", text: value });
const messages = Array.from({ length: 200 }, (_, index) => {
  const metadata = {
    id: `message-${index}`,
    seq: index + 1,
    transcriptPosition: { source: "synthetic-history", rawSeq: index + 1 },
  };
  const fields = { timestamp: 1_700_000_000_000 + index, __openclaw: metadata };
  switch (index % 10) {
    case 0:
    case 5:
      return {
        ...fields,
        role: "user",
        content: [text(`Request ${index}: ${"context ".repeat(80)}`)],
      };
    case 1:
      return {
        ...fields,
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: `call-${index}`,
            name: "read",
            arguments: { path: "report.txt" },
          },
        ],
      };
    case 2:
      return {
        ...fields,
        role: "toolResult",
        toolCallId: `call-${index - 1}`,
        toolName: "read",
        content: [text("tool output ".repeat(200))],
      };
    case 3:
      return {
        ...fields,
        role: "assistant",
        content: [text("Report ".repeat(100))],
        usage: { input: 1000, output: 400, totalTokens: 1400 },
      };
    case 4:
      return {
        ...fields,
        role: "system",
        content: [text("Compaction")],
        __openclaw: { ...metadata, kind: "compaction", tokensBefore: 20000, tokensAfter: 5000 },
      };
    case 6:
      return {
        ...fields,
        role: "assistant",
        content: [
          {
            ...text("Checking the report"),
            textSignature: JSON.stringify({ v: 1, id: `commentary-${index}`, phase: "commentary" }),
          },
          {
            ...text("Finished checking ".repeat(80)),
            textSignature: JSON.stringify({ v: 1, id: `final-${index}`, phase: "final_answer" }),
          },
        ],
      };
    case 7:
      return {
        ...fields,
        role: "user",
        content: [
          text("Read this attachment"),
          {
            type: "attachment",
            attachment: { url: "https://example.invalid/report.txt", name: "report.txt" },
          },
        ],
      };
    case 8:
      return {
        ...fields,
        role: "assistant",
        content: [text("model representation")],
        openclawDisplayContent: [
          text("Presented result"),
          { type: "image", source: { type: "url", url: "https://example.invalid/chart.png" } },
        ],
      };
    default:
      return {
        ...fields,
        role: "toolResult",
        toolCallId: `call-${index}`,
        toolName: "search",
        content: [
          text(
            JSON.stringify({
              results: Array.from({ length: 12 }, (_entry, result) => ({
                title: `Result ${result}`,
                excerpt: "synthetic excerpt ".repeat(20),
              })),
            }),
          ),
        ],
      };
  }
});
const options = {
  includeCommentaryFallbacks: true,
  maxChars: 8000,
  toolResultMaxChars: 2000,
  resolveCronJobName: () => undefined,
};
const hash = (value) => createHash("sha256").update(value).digest("hex");
const inputHash = hash(JSON.stringify(messages));
const output = JSON.stringify(project(messages, options));
for (let index = 0; index < 100; index++) {
  project(messages, options);
}
global.gc();
await setImmediate();
let inspector;
if (values.allocation) {
  inspector = new Session();
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 16384,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const collections = [];
const observer = new PerformanceObserver((list) => collections.push(...list.getEntries()));
observer.observe({ entryTypes: ["gc"] });
const samples = new Float64Array(operations);
const hostLoad = loadavg();
const memoryBefore = process.memoryUsage();
const cpuStart = process.threadCpuUsage();
const started = performance.now();
let last;
for (let index = 0; index < operations; index++) {
  const before = performance.now();
  last = project(messages, options);
  samples[index] = performance.now() - before;
}
const elapsedMs = performance.now() - started;
const cpu = process.threadCpuUsage(cpuStart);
const memoryAfter = process.memoryUsage();
let sampledBytes;
if (inspector) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const sum = (node) =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  sampledBytes = sum(profile.head);
  inspector.disconnect();
}
await setImmediate();
await setImmediate();
observer.disconnect();
assert.equal(JSON.stringify(last), output);
assert.equal(hash(JSON.stringify(messages)), inputHash, "Projection changed its input");
samples.sort();
const percentile = (fraction) =>
  samples[Math.min(samples.length - 1, Math.ceil(samples.length * fraction) - 1)];
const gcByKind = {};
for (const collection of collections) {
  const kind = collection.detail.kind;
  const summary = (gcByKind[kind] ??= { count: 0, ms: 0, maxMs: 0 });
  summary.count++;
  summary.ms += collection.duration;
  summary.maxMs = Math.max(summary.maxMs, collection.duration);
}
console.log(
  JSON.stringify({
    scope: "display projection only; no database, worker, or Gateway",
    node: process.version,
    sourceSha256: hash(source),
    outputSha256: hash(output),
    inputRows: messages.length,
    outputRows: last.messages.length,
    outputBytes: Buffer.byteLength(output),
    operations,
    mode: values.allocation ? "allocation" : "timing",
    hostLoad,
    hostLoadAfter: loadavg(),
    elapsedMs,
    threadCpuMs: (cpu.user + cpu.system) / 1000,
    threadCpuMsPerOperation: (cpu.user + cpu.system) / 1000 / operations,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    gcCount: collections.length,
    gcMs: collections.reduce((total, entry) => total + entry.duration, 0),
    gcMaxMs: Math.max(0, ...collections.map((entry) => entry.duration)),
    gcByKind,
    memoryBefore,
    memoryAfter,
    ...(sampledBytes === undefined
      ? {}
      : { sampledBytes, sampledBytesPerOperation: sampledBytes / operations }),
  }),
);
