/**
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/chat-display-admission-measure.mjs
 * Add --allocation for a separate sampled-allocation pass (including collected objects).
 * Add --owner-source <saved-core.ts> to load a baseline at the canonical owner URL.
 * Add --message-mib 5 (or 20) --operations 5 --warmups 1 for a giant code-heavy reply.
 * Add --shape mixed for many short fences and inline spans instead of one large fence.
 * Add --shape fallback for the pathological mixed-code and blockquote fixture.
 * Add --regions-source <saved-regions.ts> to compare code-region implementations.
 * Add --count-scans for a separate work-count pass, outside timing/allocation comparisons.
 * Add --inspection recovery|native|tts|full-row for residual full-text consumers (default preview).
 * Add --source-root <snapshot> to restore baseline modules at their canonical source URLs.
 * Run baseline/candidate in alternating order with identical --operations (default 3000).
 * Acceptance: bounded display work under 50 ms; unchanged normal output and no material harm.
 * Giant output may change at the display cap; full input must remain unchanged.
 * Measures the real display owner on a synthetic 200-row Team-shaped history page, not RPC
 * latency: user/assistant/tool output, attachments, compaction, commentary, and display content.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { performance, PerformanceObserver } from "node:perf_hooks";
import { setImmediate, setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "owner-source": { type: "string" },
    "regions-source": { type: "string" },
    "source-root": { type: "string" },
    "message-mib": { type: "string", default: "0" },
    shape: { type: "string", default: "fence" },
    inspection: { type: "string", default: "preview" },
    warmups: { type: "string" },
    "count-scans": { type: "boolean", default: false },
    operations: { type: "string" },
    allocation: { type: "boolean", default: false },
  },
});
assert(global.gc, "Run with --expose-gc");
const messageMiB = Number(values["message-mib"]);
assert(Number.isSafeInteger(messageMiB) && messageMiB >= 0, "Invalid --message-mib");
assert(["fence", "mixed", "fallback"].includes(values.shape), "Invalid --shape");
assert(
  ["preview", "recovery", "native", "tts", "full-row"].includes(values.inspection),
  "Invalid --inspection",
);
assert(messageMiB > 0 || values.inspection === "preview", "--inspection requires --message-mib");
const operations = Number(values.operations ?? (messageMiB > 0 ? 5 : 3000));
assert(Number.isSafeInteger(operations) && operations > 0, "Invalid --operations");
const warmups = Number(values.warmups ?? (messageMiB > 0 ? 1 : 100));
assert(Number.isSafeInteger(warmups) && warmups >= 0, "Invalid --warmups");
const ownerUrl = new URL("../../src/gateway/chat-display-projection.core.ts", import.meta.url);
const repoUrl = new URL("../../", import.meta.url);
const sourceRoot = values["source-root"] ? resolve(values["source-root"]) : undefined;
const overriddenSources = {};
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
if (values["owner-source"] || values["regions-source"] || values["count-scans"] || sourceRoot) {
  registerHooks({
    load(url, context, nextLoad) {
      let loaded = nextLoad(url, context);
      if (sourceRoot && url.startsWith(repoUrl.href)) {
        const relative = fileURLToPath(url).slice(fileURLToPath(repoUrl).length);
        const snapshot = resolve(sourceRoot, relative);
        if (existsSync(snapshot)) {
          const saved = readFileSync(snapshot, "utf8");
          overriddenSources[relative] = createHash("sha256").update(saved).digest("hex");
          loaded = { ...loaded, format: "module-typescript", source: saved };
        }
      }
      if (url === ownerUrl.href && values["owner-source"]) {
        return { ...loaded, format: "module-typescript", source };
      }
      if (url !== regionsUrl.href || (!values["regions-source"] && !values["count-scans"])) {
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
if (values.inspection === "native") {
  messages[0].content.push({ type: "toolCall", id: "synthetic-read", name: "read", arguments: {} });
}
if (values.inspection === "tts") {
  const spokenText = messages[0].content[0].text.slice("MEDIA:./managed.png\n\n".length).trim();
  messages.push({
    role: "assistant",
    content: [{ type: "audio", url: "https://example.invalid/synthetic.mp3" }],
    openclawTtsSupplement: {
      textSha256: createHash("sha256").update(spokenText).digest("hex"),
    },
  });
}
const options = {
  includeCommentaryFallbacks: true,
  maxChars: values.inspection === "full-row" ? Number.MAX_SAFE_INTEGER : 8000,
  assistantErrorPending: values.inspection === "recovery",
  toolResultMaxChars: 2000,
  resolveCronJobName: () => undefined,
};
const hash = (value) => createHash("sha256").update(value).digest("hex");
const inputHash = hash(JSON.stringify(messages));
const coldCpuStart = process.threadCpuUsage();
const coldProcessCpuStart = process.cpuUsage();
const coldStart = performance.now();
// A queued timer captures the very first blocked turn, unlike a sampled delay histogram.
const coldDelay = setTimeout(0).then(() => performance.now() - coldStart);
const initial = await project(messages, options);
const coldMs = performance.now() - coldStart;
const coldCpu = process.threadCpuUsage(coldCpuStart);
const coldProcessCpu = process.cpuUsage(coldProcessCpuStart);
const coldMainThreadDelayMs = await coldDelay;
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
const samples = new Float64Array(operations);
const delays = new Float64Array(operations);
const hostLoad = loadavg();
const memoryBefore = process.memoryUsage();
const cpuStart = process.threadCpuUsage();
const processCpuStart = process.cpuUsage();
scanCounts.calls = scanCounts.chars = scanCounts.maxChars = 0;
const started = performance.now();
let last;
for (let index = 0; index < operations; index++) {
  const before = performance.now();
  const delay = setTimeout(0).then(() => performance.now() - before);
  last = await project(messages, options);
  samples[index] = performance.now() - before;
  delays[index] = await delay;
}
const elapsedMs = performance.now() - started;
const cpu = process.threadCpuUsage(cpuStart);
const processCpu = process.cpuUsage(processCpuStart);
const memoryAfter = process.memoryUsage();
delays.sort();
const mainThreadDelayMaxMs = delays.at(-1);
const mainThreadDelayP99Ms = delays[Math.ceil(operations * 0.99) - 1];
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
    overriddenSources,
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
    inspection: values.inspection,
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
    delayScope:
      "queued timer latency across each synchronous projection; includes timer scheduling",
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
