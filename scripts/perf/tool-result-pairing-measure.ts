/**
 * Full transcript-pairing repair CPU/allocation benchmark, synthetic history only.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/tool-result-pairing-measure.ts
 *   --source .local/tool-result-pairing-base.ts --scenario canonical --iterations 2000
 * Save the baseline owner before editing; --source replaces only that module.
 * Run five interleaved baseline/candidate pairs per scenario, reversing launch order.
 * Accept lower allocation/CPU with identical output hashes and no material regression.
 * Timing is untraced; allocation is a separate sampling pass including collected objects.
 * This measures the repair owner, not Gateway RPC or model latency.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { AgentMessage } from "../../packages/agent-core/src/types.js";

const { values } = parseArgs({
  options: {
    source: { type: "string" },
    scenario: { type: "string", default: "canonical" },
    iterations: { type: "string", default: "2000" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(values.scenario === "canonical" || values.scenario === "legacy");
assert(global.gc, "Run with --expose-gc");
const owner = path.resolve("packages/agent-core/src/harness/session/tool-result-pairing.ts");
const source = path.resolve(values.source ?? owner);
let substitutions = 0;
const hooks = values.source
  ? registerHooks({
      resolve(specifier, context, nextResolve) {
        if (
          context.parentURL &&
          specifier.startsWith(".") &&
          new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL).href ===
            pathToFileURL(owner).href
        ) {
          substitutions++;
          return nextResolve(pathToFileURL(source).href, context);
        }
        return nextResolve(specifier, context);
      },
    })
  : undefined;
const { repairToolUseResultPairing } =
  await import("../../src/agents/session-transcript-repair.js");
assert(!values.source || substitutions > 0, "Baseline owner must be substituted");
const messages: AgentMessage[] = [];
for (let turn = 0; turn < 100; turn++) {
  messages.push({ role: "user", content: `Synthetic request ${turn}`, timestamp: turn });
  const calls = Array.from({ length: 4 }, (_, index) => ({
    type: "toolCall" as const,
    id: `call_${index}`,
    name: "read",
    arguments: { path: `/synthetic/${turn}/${index}` },
  }));
  messages.push({
    role: "assistant",
    content: [{ type: "text", text: "Reading synthetic inputs" }, ...calls],
    api: "openai-responses",
    provider: "openai",
    model: "synthetic",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: turn,
  });
  for (const [index, call] of calls.entries()) {
    if (values.scenario === "legacy" && turn % 10 === 0 && index === 3) {
      continue;
    }
    messages.push({
      role: "toolResult",
      toolCallId: values.scenario === "legacy" ? "  " : call.id,
      ...(values.scenario === "legacy" ? { call_id: ` ${call.id} ` } : {}),
      toolName: "read",
      content: [{ type: "text", text: "Synthetic result ".repeat(64) }],
      isError: false,
      timestamp: turn,
    });
  }
}
const options = { missingToolResultTimestamp: "assistant" as const };
const expected = repairToolUseResultPairing(messages, options);
const outputHash = createHash("sha256").update(JSON.stringify(expected)).digest("hex");
if (values.scenario === "canonical") {
  assert.equal(expected.messages, messages);
}
let checksum = 0;
function run(count: number) {
  for (let index = 0; index < count; index++) {
    const result = repairToolUseResultPairing(messages, options);
    checksum += result.messages.length + result.added.length;
  }
}
run(200);
global.gc();
const hostLoadBefore = loadavg();
const cpu = process.threadCpuUsage();
const started = performance.now();
run(iterations);
const elapsedMs = performance.now() - started;
const used = process.threadCpuUsage(cpu);
global.gc();
const inspector = new Session();
inspector.connect();
await inspector.post("HeapProfiler.startSampling", {
  samplingInterval: 16384,
  includeObjectsCollectedByMajorGC: true,
  includeObjectsCollectedByMinorGC: true,
});
run(iterations);
const { profile } = await inspector.post("HeapProfiler.stopSampling");
inspector.disconnect();
let bytes = 0;
const nodes = [profile.head];
for (let node = nodes.pop(); node; node = nodes.pop()) {
  bytes += node.selfSize;
  nodes.push(...node.children);
}
assert.equal(
  createHash("sha256")
    .update(JSON.stringify(repairToolUseResultPairing(messages, options)))
    .digest("hex"),
  outputHash,
);
console.log(
  JSON.stringify({
    scenario: values.scenario,
    sourceHash: createHash("sha256").update(readFileSync(source)).digest("hex"),
    node: process.version,
    messages: messages.length,
    calls: 400,
    iterationsPerPass: iterations,
    warmup: 200,
    cpuMs: (used.user + used.system) / 1000,
    elapsedMs,
    allocationBytes: bytes,
    bytesPerRepair: bytes / iterations,
    hostLoadBefore,
    hostLoadAfter: loadavg(),
    outputHash,
    checksum,
  }),
);
hooks?.deregister();
