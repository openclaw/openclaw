/**
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/chat-display-admission-measure.mjs
 * Add --allocation for a separate sampled-allocation pass (including collected objects).
 * Add --owner-source <saved-core.ts> to load a baseline at the canonical owner URL.
 * Add --message-mib 5 (or 20) --operations 5 --warmups 1 for a giant code-heavy reply.
 * Add --shape mixed for many short fences and inline spans instead of one large fence.
 * Add --shape fallback for the pathological mixed-code and blockquote fixture.
 * Add --regions-source <saved-regions.ts> to compare code-region implementations.
 * Add --count-scans for a separate work-count pass, outside timing/allocation comparisons.
 * Add --async to measure the production worker route, including total process CPU and RSS.
 * Add --worker-dist dist after pnpm build:runtime to use the production-built worker.
 * Allocation and GC observations remain main-thread-only; profile workers separately.
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
import { monitorEventLoopDelay, performance, PerformanceObserver } from "node:perf_hooks";
import { setImmediate, setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "owner-source": { type: "string" },
    "regions-source": { type: "string" },
    "worker-dist": { type: "string" },
    "message-mib": { type: "string", default: "0" },
    shape: { type: "string", default: "fence" },
    warmups: { type: "string" },
    "count-scans": { type: "boolean", default: false },
    operations: { type: "string" },
    allocation: { type: "boolean", default: false },
    async: { type: "boolean", default: false },
  },
});
assert(global.gc, "Run with --expose-gc");
assert(!values["worker-dist"] || values.async, "--worker-dist requires --async");
assert(
  !values.async || (!values["owner-source"] && !values["regions-source"]),
  "Source overrides apply to synchronous baselines; workers load their source independently",
);
const messageMiB = Number(values["message-mib"]);
assert(Number.isSafeInteger(messageMiB) && messageMiB >= 0, "Invalid --message-mib");
assert(["fence", "mixed", "fallback"].includes(values.shape), "Invalid --shape");
const operations = Number(values.operations ?? (messageMiB > 0 ? 5 : 3000));
assert(Number.isSafeInteger(operations) && operations > 0, "Invalid --operations");
const warmups = Number(values.warmups ?? (messageMiB > 0 ? 1 : 100));
assert(Number.isSafeInteger(warmups) && warmups >= 0, "Invalid --warmups");
const ownerUrl = new URL("../../src/gateway/chat-display-projection.core.ts", import.meta.url);
const processDeclarationUrl = new URL(
  "../../src/infra/runtime-process-entrypoints.ts",
  import.meta.url,
);
const workerDist = values["worker-dist"] ? resolve(values["worker-dist"]) : undefined;
const compiledDeclarationUrl = workerDist
  ? pathToFileURL(resolve(workerDist, "infra/runtime-process-entrypoints.js"))
  : undefined;
const compiledWorkerUrl = workerDist
  ? pathToFileURL(resolve(workerDist, "gateway/chat-display-projection.worker.js"))
  : undefined;
const compiledDeclaration = compiledDeclarationUrl
  ? readFileSync(compiledDeclarationUrl)
  : undefined;
const compiledWorker = compiledWorkerUrl ? readFileSync(compiledWorkerUrl) : undefined;
const regionsUrl = new URL(
  "../../packages/markdown-core/src/markdown-code-regions.ts",
  import.meta.url,
);
const source = readFileSync(
  values["owner-source"] ? resolve(values["owner-source"]) : ownerUrl,
  "utf8",
);
const regionsSource = readFileSync(
  values["regions-source"] ? resolve(values["regions-source"]) : regionsUrl,
  "utf8",
);
const scanCounts = { calls: 0, chars: 0, maxChars: 0 };
if (values["count-scans"]) {
  globalThis.markdownCodeRegionMeasure = scanCounts;
}
if (
  values["owner-source"] ||
  values["regions-source"] ||
  values["count-scans"] ||
  compiledDeclarationUrl
) {
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      // Use the native build's declaration so the normal runtime owner resolves compiled workers.
      if (url === processDeclarationUrl.href && compiledDeclarationUrl) {
        return {
          ...loaded,
          format: "module",
          source: `export * from ${JSON.stringify(compiledDeclarationUrl.href)};`,
        };
      }
      if (url === ownerUrl.href && values["owner-source"]) {
        return { ...loaded, format: "module-typescript", source };
      }
      if (url !== regionsUrl.href) {
        return loaded;
      }
      let measuredSource = regionsSource;
      if (values["count-scans"]) {
        measuredSource = measuredSource.replace(
          "export function findMarkdownCodeRegions(",
          "function measuredFindMarkdownCodeRegions(",
        );
        assert.notEqual(measuredSource, regionsSource, "Code-region owner function not found");
        measuredSource += `\nexport function findMarkdownCodeRegions(text: string) {
          const counts = globalThis.markdownCodeRegionMeasure;
          counts.calls++;
          counts.chars += text.length;
          counts.maxChars = Math.max(counts.maxChars, text.length);
          return measuredFindMarkdownCodeRegions(text);
        }\n`;
      }
      return { ...loaded, format: "module-typescript", source: measuredSource };
    },
  });
}
const project = values.async
  ? (await import("../../src/gateway/chat-display-projection.async.ts"))
      .projectChatDisplayMessagesWithStateAsync
  : (await import(ownerUrl.href)).projectChatDisplayMessagesWithState;
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
if (messageMiB > 0) {
  // One media directive activates the real display path without multiplying directive lookups.
  const fencedCode =
    [
      'const reply = "[[reply_to_current]]";',
      "```nested",
      "~~~tilde",
      "`".repeat(97) + " unmatched " + "`".repeat(96),
      "<parameter>synthetic</parameter> " + "[unresolved](".repeat(64),
      "const row = " + "x".repeat(1024) + ";",
    ].join("\n") + "\n";
  const mixedCode = [
    "The result preserves `[[reply_to_current]]` and ``a`b`` as source.",
    "",
    "````typescript",
    'const reply = "[[reply_to_current]]";',
    "```nested",
    "~~~tilde",
    "````",
    "",
    "~~~text",
    "<parameter>synthetic</parameter>",
    "~~~",
    "",
  ].join("\n");
  const mixed = values.shape !== "fence";
  const code = mixed
    ? mixedCode + (values.shape === "fallback" ? "\n> Quoted `literal` source.\n\n" : "")
    : fencedCode;
  const prefix =
    "MEDIA:./managed.png\n\nSynthetic source:\n\n" + (mixed ? "" : "`".repeat(128) + "text\n");
  const suffix = "\n" + (mixed ? "" : "`".repeat(128)) + "\n\nFinished.";
  const bodyChars = messageMiB * 1024 * 1024 - prefix.length - suffix.length;
  const large =
    prefix + code.repeat(Math.ceil(bodyChars / code.length)).slice(0, bodyChars) + suffix;
  assert.equal(large.length, messageMiB * 1024 * 1024);
  messages.splice(0, messages.length, {
    role: "assistant",
    content: [text(large)],
    stopReason: "stop",
    openclawDelivery: { mediaUrls: ["./managed.png"] },
    __openclaw: { id: "synthetic-large-message", seq: 1 },
  });
}
const options = {
  includeCommentaryFallbacks: true,
  maxChars: 8000,
  toolResultMaxChars: 2000,
  resolveCronJobName: () => undefined,
};
const hash = (value) => createHash("sha256").update(value).digest("hex");
const inputHash = hash(JSON.stringify(messages));
const eventLoop = monitorEventLoopDelay({ resolution: 1 });
eventLoop.enable();
// Arm the timer before entering synchronous work; otherwise a blocked first turn is invisible.
await setTimeout(5);
eventLoop.reset();
const coldCpuStart = process.threadCpuUsage();
const coldProcessCpuStart = process.cpuUsage();
const coldStart = performance.now();
const initial = await project(messages, options);
const coldMs = performance.now() - coldStart;
const coldCpu = process.threadCpuUsage(coldCpuStart);
const coldProcessCpu = process.cpuUsage(coldProcessCpuStart);
await setTimeout(2);
const coldMainThreadDelayMs = eventLoop.max / 1e6;
eventLoop.disable();
const output = JSON.stringify(initial);
for (let index = 0; index < warmups; index++) {
  await project(messages, options);
  await setImmediate();
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
eventLoop.enable();
await setTimeout(5);
eventLoop.reset();
const samples = new Float64Array(operations);
const hostLoad = loadavg();
const memoryBefore = process.memoryUsage();
const cpuStart = process.threadCpuUsage();
const processCpuStart = process.cpuUsage();
scanCounts.calls = scanCounts.chars = scanCounts.maxChars = 0;
const started = performance.now();
let last;
for (let index = 0; index < operations; index++) {
  const before = performance.now();
  last = await project(messages, options);
  samples[index] = performance.now() - before;
  await setTimeout(0);
}
const elapsedMs = performance.now() - started;
const cpu = process.threadCpuUsage(cpuStart);
const processCpu = process.cpuUsage(processCpuStart);
const memoryAfter = process.memoryUsage();
await setTimeout(2);
const mainThreadDelayMaxMs = eventLoop.max / 1e6;
const mainThreadDelayP99Ms = eventLoop.percentile(99) / 1e6;
eventLoop.disable();
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
if (values.async) {
  const { drainGlobalSingletonLifecycleState } =
    await import("../../src/shared/global-singleton.ts");
  await drainGlobalSingletonLifecycleState();
}
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
    scope: values.async
      ? "display projection and compute worker; no database or Gateway"
      : "display projection only; no database, worker, or Gateway",
    route: values.async ? "async" : "sync",
    workerRuntime: values.async ? (workerDist ? "production build" : "source with tsx") : "none",
    ...(compiledDeclaration && compiledWorker
      ? {
          workerDist,
          workerDeclarationSha256: hash(compiledDeclaration),
          workerEntrySha256: hash(compiledWorker),
        }
      : {}),
    node: process.version,
    sourceSha256: hash(source),
    regionsSourceSha256: hash(regionsSource),
    outputSha256: hash(output),
    inputSha256: inputHash,
    inputRows: messages.length,
    outputRows: last.messages.length,
    outputBytes: Buffer.byteLength(output),
    operations,
    warmups,
    messageMiB,
    shape: values.shape,
    ...(values["count-scans"] ? { scanCounts, scanScope: "main-thread only" } : {}),
    mode: values.allocation ? "allocation" : "timing",
    hostLoad,
    hostLoadAfter: loadavg(),
    elapsedMs,
    coldMs,
    coldThreadCpuMs: (coldCpu.user + coldCpu.system) / 1000,
    coldProcessCpuMs: (coldProcessCpu.user + coldProcessCpu.system) / 1000,
    coldMainThreadDelayMs,
    threadCpuMs: (cpu.user + cpu.system) / 1000,
    threadCpuMsPerOperation: (cpu.user + cpu.system) / 1000 / operations,
    processCpuMs: (processCpu.user + processCpu.system) / 1000,
    processCpuMsPerOperation: (processCpu.user + processCpu.system) / 1000 / operations,
    mainThreadDelayMaxMs,
    mainThreadDelayP99Ms,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    minMs: samples[0],
    maxMs: samples.at(-1),
    ...(operations <= 100 ? { samplesMs: Array.from(samples) } : {}),
    gcCount: collections.length,
    gcMs: collections.reduce((total, entry) => total + entry.duration, 0),
    gcMaxMs: Math.max(0, ...collections.map((entry) => entry.duration)),
    gcByKind,
    gcScope: "main-thread only",
    memoryBefore,
    memoryAfter,
    memoryScope: "RSS covers all threads; heap/external/arrayBuffers cover the main thread",
    ...(sampledBytes === undefined
      ? {}
      : {
          sampledBytes,
          sampledBytesPerOperation: sampledBytes / operations,
          allocationScope: "main-thread only",
        }),
  }),
);
