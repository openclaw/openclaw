/**
 * Tool-result sizing owner benchmark (no Gateway latency claim).
 * 40 messages / 20 CJK, emoji and JSON tool results, detached by the initial model
 * history owner into writable containers. Each request applies the context guard's
 * weight-2 estimate, history limits and compaction sizing. Revise one result every
 * 20 requests, including its persistence cap. Compare five alternating
 * base/candidate runs, separately for timing and sampled allocation (includes GC).
 * Accept unchanged bytes/decisions and lower CPU or allocation without a material
 * adverse timing/GC change. Small tail samples are descriptive only.
 *
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/tool-result-size-measure.ts \
 *   --owner /path/to/tool-result-truncation.ts --mode timing --iterations 3000
 * Repeat with --mode allocation, and use --history frozen for the immutable control.
 * Use --budget-owner for the matching text-budget snapshot when --owner is a renamed
 * baseline file beside its siblings; otherwise the sibling text-budget module is used.
 * Require identical outputDigest values across revisions; the digest covers bounded
 * replacement bytes and decisions outside the timed/allocation measurement.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { AgentMessage } from "../../src/agents/runtime/index.js";
import { cloneSessionModelContextEntries } from "../../src/agents/sessions/session-manager-codec.js";
import { freezeTrustedJsonSnapshot } from "../../src/shared/immutable-data.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    "budget-owner": { type: "string" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "3000" },
    history: { type: "string", default: "initial-context" },
  },
});
assert(["timing", "allocation"].includes(values.mode));
assert(["initial-context", "frozen"].includes(values.history));
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "iterations",
  min: 1,
  fallback: 3000,
});
const owner = values.owner
  ? pathToFileURL(values.owner)
  : new URL("../../src/agents/embedded-agent-runner/tool-result-truncation.ts", import.meta.url);
const {
  truncateOversizedToolResultsInMessages,
  estimateToolResultReductionPotential,
  truncateToolResultMessage,
}: typeof import("../../src/agents/embedded-agent-runner/tool-result-truncation.js") = await import(
  owner.href
);
const budgetOwner = values["budget-owner"]
  ? pathToFileURL(values["budget-owner"])
  : new URL("./tool-result-text-budget.ts", owner);
const {
  prepareToolResultTextChars,
}: typeof import("../../src/agents/embedded-agent-runner/tool-result-text-budget.js") =
  await import(budgetOwner.href);
const payloads = [
  "synthetic output 漢字 𠀀\n".repeat(512),
  "emoji result 🙂🚀👩‍💻\n".repeat(512),
  JSON.stringify(
    Array.from({ length: 256 }, (_, id) => ({ id, text: "JSON result 漢字🙂", ok: true })),
  ),
];
function tool(index: number, revision: number): Extract<AgentMessage, { role: "toolResult" }> {
  return {
    role: "toolResult",
    toolName: "read",
    toolCallId: `call-${index}`,
    content: [{ type: "text", text: `${index}:${revision}\n${payloads[index % 3]!}` }],
    isError: false,
    timestamp: index,
  };
}
function createHistory(): AgentMessage[] {
  const entries = Array.from({ length: 40 }, (_, index) => ({
    type: "message" as const,
    id: `entry-${index}`,
    parentId: index === 0 ? null : `entry-${index - 1}`,
    timestamp: "2026-01-01T00:00:00.000Z",
    message:
      index % 2 === 0
        ? tool(index, 0)
        : { role: "user" as const, content: "Continue", timestamp: index },
  }));
  freezeTrustedJsonSnapshot(entries);
  const projected =
    values.history === "frozen" ? entries : cloneSessionModelContextEntries(entries);
  return projected.map((entry) => {
    assert(entry.type === "message");
    return entry.message;
  });
}
const history = createHistory();
const contextWindowTokens = 1_000_000;

// Check bounded output and a writable text revision before profiling warm requests.
const proofHistory = createHistory();
const originalBytes = JSON.stringify(proofHistory);
const bounded = truncateOversizedToolResultsInMessages(
  proofHistory,
  contextWindowTokens,
  1_000,
  15_000,
);
assert.equal(bounded.truncatedCount, 20);
assert.equal(JSON.stringify(proofHistory), originalBytes);
const revised = tool(0, 1);
const revisedBlock = { type: "text" as const, text: "short revised result" };
revised.content = [revisedBlock];
proofHistory[0] = revised;
const beforeRevision = truncateOversizedToolResultsInMessages(
  proofHistory,
  contextWindowTokens,
  1_000,
);
assert.equal(beforeRevision.truncatedCount, 19);
const beforeRevisionBytes = JSON.stringify(beforeRevision);
revisedBlock.text = payloads[2]!;
const afterRevision = truncateOversizedToolResultsInMessages(
  proofHistory,
  contextWindowTokens,
  1_000,
);
assert.equal(afterRevision.truncatedCount, 20);
const outputDigest = createHash("sha256")
  .update(JSON.stringify([bounded, beforeRevisionBytes, afterRevision]))
  .digest("hex");

function run(index: number) {
  if (index % 20 === 0) {
    const position = ((index / 20) % 20) * 2;
    const next = tool(position, index);
    const previous = history[position];
    assert(previous?.role === "toolResult");
    if (values.history === "frozen") {
      history[position] = freezeTrustedJsonSnapshot(next);
    } else {
      const block = previous.content[0];
      const nextBlock = next.content[0];
      assert(block?.type === "text" && nextBlock?.type === "text");
      block.text = nextBlock.text;
    }
    const changed = history[position]!;
    assert.equal(truncateToolResultMessage(changed, 100_000), changed);
  }
  const messages = [...history];
  for (const message of messages) {
    if (message.role === "toolResult") {
      for (const block of message.content) {
        if (block.type === "text") {
          prepareToolResultTextChars(block, block.text, 2);
        }
      }
    }
  }
  const result = truncateOversizedToolResultsInMessages(messages, contextWindowTokens);
  const potential = estimateToolResultReductionPotential({ messages, contextWindowTokens });
  assert.equal(result.messages, messages);
  assert.equal(result.truncatedCount, 0);
  assert.equal(potential.maxReducibleChars, 0);
}
for (let i = 0; i < 200; i++) {
  run(i);
}
global.gc?.();
await nextTurn();
const gcPauses: number[] = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gcPauses.push(entry.duration);
  }
});
observer.observe({ entryTypes: ["gc"] });
const inspector = new Session();
if (values.mode === "allocation") {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 16384,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const hostLoad = loadavg();
const cpuStart = process.cpuUsage();
const start = performance.now();
for (let i = 0; i < iterations; i++) {
  run(i + 200);
  if (i % 100 === 0) {
    await nextTurn();
  }
}
const elapsedMs = performance.now() - start;
const cpu = process.cpuUsage(cpuStart);
await nextTurn();
await nextTurn();
observer.disconnect();
let sampledBytes: number | null = null;
if (values.mode === "allocation") {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  inspector.disconnect();
}
console.log(
  JSON.stringify({
    mode: values.mode,
    owner: owner.href,
    iterations,
    history: values.history,
    messages: 40,
    toolResults: 20,
    outputDigest,
    hostLoad,
    elapsedMs,
    nsPerRequest: (elapsedMs * 1_000_000) / iterations,
    cpuNsPerRequest: ((cpu.user + cpu.system) * 1000) / iterations,
    cpuMsPerRequest: (cpu.user + cpu.system) / 1000 / iterations,
    allocationBytesPerRequest: sampledBytes === null ? null : sampledBytes / iterations,
    gcCount: gcPauses.length,
    gcMsPerRequest: gcPauses.reduce((a, b) => a + b, 0) / iterations,
    gcMaxMs: Math.max(0, ...gcPauses),
    memory: process.memoryUsage(),
  }),
);
