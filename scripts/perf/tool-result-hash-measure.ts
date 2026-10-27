/**
 * Synthetic owner workload: 48 interleaved sessions, 40 frozen 8 KiB tool results each.
 * Reconcile and project each session repeatedly; replace a result every eight rounds
 * and reset each session every 64 rounds. Run baseline/candidate serially in five
 * alternating pairs. This measures prompt-projection work, not Gateway latency.
 *
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/tool-result-hash-measure.ts \
 *   --mode timing --output .local/toolhash.json
 * Repeat with --mode allocation (includes collected objects). For promotion use
 * --trace-gc-nvp --mode promotion --gc-log .local/toolhash.log and redirect stdout
 * to that log. --owner selects an unchanged snapshot of tool-result-truncation.ts;
 * retain its projection-key/message siblings and resolve their other imports to
 * the same checkout. --operations defaults to 6000, with 480 warmup operations.
 */
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { writeSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import {
  constants,
  monitorEventLoopDelay,
  PerformanceObserver,
  type PerformanceEntry,
} from "node:perf_hooks";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createToolResultPromptProjectionState } from "../../src/agents/embedded-agent-runner/session-prompt-state.js";
import type { AgentMessage } from "../../src/agents/runtime/index.js";
import { freezeJsonSnapshot } from "../../src/shared/immutable-data.js";
import { GATEWAY_GC_TRACE_MARKER, readGatewayGcTrace } from "../lib/gateway-bench-profile.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "timing" },
    output: { type: "string" },
    owner: { type: "string" },
    operations: { type: "string", default: "6000" },
    "gc-log": { type: "string" },
  },
});
assert(["timing", "allocation", "promotion"].includes(values.mode), "invalid --mode");
assert(values.output, "--output is required");
const output = path.resolve(values.output);
await mkdir(path.dirname(output), { recursive: true });
const operations = parseStrictIntegerOption({
  raw: values.operations,
  label: "--operations",
  min: 1,
  fallback: 6000,
});
const ownerUrl = values.owner
  ? pathToFileURL(path.resolve(values.owner))
  : new URL("../../src/agents/embedded-agent-runner/tool-result-truncation.ts", import.meta.url);
const {
  reconcileToolResultPromptProjectionState: reconcile,
  projectToolResultMessages: project,
}: typeof import("../../src/agents/embedded-agent-runner/tool-result-truncation.js") = await import(
  ownerUrl.href
);
const sessionCount = 48;
const resultsPerSession = 40;
const textBytes = 8192;
const warmup = 480;
const payload = "synthetic tool output\n".repeat(400);
function message(session: number, revision: number, index: number): AgentMessage {
  const text = `${session}:${revision}:${index}:` + payload.slice(0, textBytes);
  return freezeJsonSnapshot({
    role: "toolResult",
    toolCallId: `call-${index}`,
    toolName: "read",
    content: [
      { type: "text", text },
      { type: "text", text: "\ud800\nsecond block" },
    ],
    isError: false,
    timestamp: index,
  });
}
const sessions = Array.from({ length: sessionCount }, (_, session) => ({
  messages: Array.from({ length: resultsPerSession }, (_result, index) =>
    message(session, 0, index),
  ),
  state: createToolResultPromptProjectionState(),
}));
let resets = 0;
let freshMessages = 0;
function run(operation: number) {
  const index = operation % sessionCount;
  const round = Math.floor(operation / sessionCount);
  const session = sessions[index]!;
  if (round > 0 && round % 64 === 0) {
    session.messages = Array.from({ length: resultsPerSession }, (_, i) =>
      message(index, round, i),
    );
    session.state = createToolResultPromptProjectionState();
    resets++;
    freshMessages += resultsPerSession;
  } else if (round > 0 && round % 8 === 0) {
    const replaced = (round / 8) % resultsPerSession;
    session.messages[replaced] = message(index, round, replaced);
    freshMessages++;
  }
  reconcile(session.messages, session.state);
  const result = project({ messages: session.messages, projectionState: session.state });
  assert.equal(result.messages.length, resultsPerSession);
  for (let i = 0; i < resultsPerSession; i++) {
    assert.equal(result.messages[i], session.messages[i]);
  }
}
function verifyHashes() {
  for (const session of sessions) {
    assert.equal(session.state.sourceHashByKey.size, resultsPerSession);
    for (const entry of session.messages) {
      assert.equal(entry.role, "toolResult");
      if (entry.role !== "toolResult") {
        throw new Error("fixture role changed");
      }
      const texts = entry.content.flatMap((block) => (block.type === "text" ? [block.text] : []));
      assert.equal(
        session.state.sourceHashByKey.get(`tool:${entry.toolCallId}:${entry.timestamp}`),
        hash("sha256", JSON.stringify(texts), "base64url"),
      );
    }
  }
}
for (let i = 0; i < warmup; i++) {
  run(i);
}
verifyHashes();
resets = 0;
freshMessages = 0;
const profilePath = `${output}.heapprofile`;
const marker = (phase: string) =>
  writeSync(
    1,
    `${GATEWAY_GC_TRACE_MARKER}${JSON.stringify({ phase, pid: process.pid, profilePath })}\n`,
  );
if (values.mode === "promotion") {
  assert(values["gc-log"] && global.gc, "promotion requires --gc-log and --expose-gc");
  marker("identify-start");
  global.gc();
  marker("identify-stop");
}
function distribution(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  return {
    count: sorted.length,
    totalMs: sorted.reduce((sum, value) => sum + value, 0),
    p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1] ?? null,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
    p99Ms: sorted[Math.ceil(sorted.length * 0.99) - 1] ?? null,
    maxMs: sorted.at(-1) ?? 0,
  };
}
const collections: { kind: number; ms: number }[] = [];
let measuredStart = Infinity;
let measuredEnd = Infinity;
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    if (entry.startTime >= measuredStart && entry.startTime < measuredEnd) {
      const detail = (entry as PerformanceEntry & { detail: { kind: number } }).detail;
      collections.push({ kind: detail.kind, ms: entry.duration });
    }
  }
});
const inspector = new Session();
if (values.mode === "allocation") {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 16384,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
observer.observe({ entryTypes: ["gc"] });
const loop = monitorEventLoopDelay({ resolution: 1 });
loop.enable();
await delay(10);
loop.reset();
const outsideLoad = loadavg();
const cpu = process.cpuUsage();
const latencies: number[] = [];
marker("heap-start");
measuredStart = performance.now();
for (let i = 0; i < operations; i++) {
  const started = performance.now();
  run(i + warmup);
  latencies.push(performance.now() - started);
  await nextTurn();
}
measuredEnd = performance.now();
marker("heap-stop");
const usedCpu = process.cpuUsage(cpu);
loop.disable();
await nextTurn();
await nextTurn();
observer.disconnect();
const profile =
  values.mode === "allocation"
    ? (await inspector.post("HeapProfiler.stopSampling")).profile
    : undefined;
if (values.mode === "allocation") {
  inspector.disconnect();
}
verifyHashes();
let sampledBytes = 0;
if (profile) {
  const visit = (node: HeapProfiler.SamplingHeapProfileNode) => {
    sampledBytes += node.selfSize;
    node.children.forEach(visit);
  };
  visit(profile.head);
  await writeFile(profilePath, JSON.stringify(profile));
}
const gc = (kind?: number) =>
  distribution(
    collections
      .filter((entry) => kind === undefined || entry.kind === kind)
      .map((entry) => entry.ms),
  );
const promotion =
  values.mode === "promotion"
    ? readGatewayGcTrace(path.resolve(values["gc-log"]!), profilePath)
    : null;
const report = {
  scope:
    "tool-result reconciliation/project owner; synthetic frozen histories; no Gateway or provider latency claim",
  mode: values.mode,
  node: process.version,
  platform: process.platform,
  owner: ownerUrl.href,
  sessionCount,
  resultsPerSession,
  textBytes,
  warmup,
  operations,
  resets,
  freshMessages,
  outsideLoad,
  elapsedMs: measuredEnd - measuredStart,
  cpuMsPerOperation: (usedCpu.user + usedCpu.system) / 1000 / operations,
  latency: distribution(latencies),
  gc: {
    total: gc(),
    msPerOperation: gc().totalMs / operations,
    minor: gc(constants.NODE_PERFORMANCE_GC_MINOR),
    major: gc(constants.NODE_PERFORMANCE_GC_MAJOR),
    incremental: gc(constants.NODE_PERFORMANCE_GC_INCREMENTAL),
    weak: gc(constants.NODE_PERFORMANCE_GC_WEAKCB),
  },
  eventLoop: {
    count: loop.count,
    p95Ms: loop.percentile(95) / 1e6,
    p99Ms: loop.percentile(99) / 1e6,
    maxMs: loop.max / 1e6,
  },
  allocation: profile ? { sampledBytes, bytesPerOperation: sampledBytes / operations } : null,
  promotion: promotion
    ? { ...promotion, bytesPerOperation: promotion.promotedBytes / operations }
    : null,
};
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
