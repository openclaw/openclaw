/**
 * Measure the four owned cache-TTL text projection paths on the checked-out revision.
 * Synthetic workload: 18 retained tool results, 6,000 characters each, plus three
 * later turns; restored text projections carry eight blocks per retained result.
 * Copy this unchanged file to scripts/perf/tool-result-owned-freeze-measure.ts on
 * both revisions. Run timing separately from allocation, counterbalancing revisions:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/tool-result-owned-freeze-measure.ts timing 3000 base
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/tool-result-owned-freeze-measure.ts allocation 3000 base
 * Repeat base/candidate, candidate/base at least twice. Allocation includes dead
 * objects; sampled CPU is intentionally omitted from allocation output. These are
 * owner costs, not a whole-Gateway throughput or latency claim.
 */
import assert from "node:assert/strict";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { createToolResultPromptProjectionState } from "../../src/agents/embedded-agent-runner/session-prompt-state.js";
import {
  projectToolResultMessages,
  pruneExpiredCacheTtlToolResults,
  resolveCacheTtlPruningSettings,
  restoreCacheTtlToolResultProjections,
} from "../../src/agents/embedded-agent-runner/tool-result-truncation.js";
import type { AgentMessage } from "../../src/agents/runtime/index.js";
import { freezeTrustedJsonSnapshot } from "../../src/shared/immutable-data.js";

const mode = process.argv[2] ?? "timing";
const totalRequests = Number(process.argv[3] ?? 3000);
const iterations = totalRequests / 4;
const revision = process.argv[4] ?? "candidate";
assert(mode === "timing" || mode === "allocation");
assert(Number.isSafeInteger(iterations) && iterations > 0);
const text = "synthetic tool output\n".repeat(300).slice(0, 6000);
const tools: AgentMessage[] = Array.from({ length: 18 }, (_, index) => ({
  role: "toolResult",
  toolCallId: `old-${index}`,
  toolName: "read",
  content: [{ type: "text", text }],
  isError: false,
  timestamp: 42,
}));
const assistant: AgentMessage = {
  role: "assistant",
  content: [],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "synthetic",
  timestamp: 1,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
};
const messages = freezeTrustedJsonSnapshot([
  { role: "user" as const, content: "first", timestamp: 1 },
  assistant,
  ...tools,
  ...["second", "third", "fourth"].flatMap((content) => [
    { role: "user" as const, content, timestamp: 1 },
    assistant,
  ]),
]);
const marks = tools.map((_, index) => ({
  key: `tool:old-${index}:42`,
  mode: "hard",
  placeholder: "[restored]",
}));
const frozen = marks.map(({ key }) => ({
  key,
  sourceHash: "synthetic",
  texts: Array.from({ length: 8 }, (_, i) => `block ${i}: ${text}`),
}));
const entries = (data: unknown) => [{ type: "custom", customType: "openclaw.cache-ttl", data }];
const hardCheckpoint = entries({ prunedToolResults: marks });
const textCheckpoint = entries({ prunedToolResults: [], frozenToolResults: frozen });
const settings = resolveCacheTtlPruningSettings({ mode: "cache-ttl" });
assert(settings);
const softSettings = { ...settings, hardClear: false };
const workloads = ["soft", "hard", "restored-hard", "restored-text"] as const;
const request = (workload: (typeof workloads)[number]) => {
  const state = createToolResultPromptProjectionState();
  if (workload === "restored-text") {
    restoreCacheTtlToolResultProjections(state, textCheckpoint);
  } else if (workload === "restored-hard") {
    restoreCacheTtlToolResultProjections(state, hardCheckpoint);
    projectToolResultMessages({ messages, projectionState: state });
  } else {
    pruneExpiredCacheTtlToolResults({
      messages,
      settings: workload === "soft" ? softSettings : settings,
      contextWindowTokens: 1000,
      lastCacheTouchAt: 700000,
      now: 1000000,
      dropThinkingBlocksForEstimate: false,
      pruneNewRounds: true,
      projectionState: state,
    });
  }
  return state;
};
for (const workload of workloads) {
  const proof = request(workload);
  assert.equal(proof.replacements.size, tools.length);
  for (const { content } of proof.replacements.values()) {
    assert(Object.isFrozen(content));
    assert(content.every(Object.isFrozen));
  }
  assert.equal(
    proof.replacements.get("tool:old-0:42")?.cacheTtl,
    workload === "restored-text" ? undefined : workload === "soft" ? "soft" : "hard",
  );
  for (let i = 0; i < Math.min(iterations, 100); i++) {
    request(workload);
  }
  global.gc?.();
  const inspector = new Session();
  if (mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const loadBefore = os.loadavg();
  const cpuBefore = process.threadCpuUsage();
  const start = performance.now();
  let checksum = 0;
  for (let i = 0; i < iterations; i++) {
    checksum += request(workload).replacements.size;
  }
  const elapsedMs = performance.now() - start;
  const cpu = process.threadCpuUsage(cpuBefore);
  let sampledBytes: number | undefined;
  if (mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    sampledBytes = sum(profile.head);
    inspector.disconnect();
  }
  assert.equal(checksum, iterations * tools.length);
  console.log(
    JSON.stringify({
      revision,
      mode,
      workload,
      iterations,
      resultsPerIteration: tools.length,
      elapsedMs: mode === "timing" ? elapsedMs : undefined,
      mainThreadCpuMs: mode === "timing" ? (cpu.user + cpu.system) / 1000 : undefined,
      sampledBytes,
      bytesPerRequest: sampledBytes === undefined ? undefined : sampledBytes / iterations,
      loadBefore,
      loadAfter: os.loadavg(),
      memory: process.memoryUsage(),
    }),
  );
}
