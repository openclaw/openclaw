/**
 * Store-key owner CPU/allocation benchmark; no Gateway or live state.
 * 10k synthetic keys across 40 agents, 3k batches of 65 client lookups.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-store-key-measure.ts
 * Add --source <saved-session-store-key.ts> for the baseline owner, or
 * --mode allocation for a separate sampled-allocation pass including collected objects.
 * --operation identity measures repeated sharing routing derivation on a frozen
 * 40-agent config; --operation routing includes readSessionRoutingFacts per check.
 * Run five alternating base/candidate pairs per mode. Accept identical output
 * digests with lower CPU/allocation; timing runs are untraced. This does not
 * measure whole-Gateway latency, GC, or model turns.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    source: { type: "string" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "3000" },
    operation: { type: "string", default: "key" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(values.mode === "timing" || values.mode === "allocation");
assert(["key", "identity", "routing"].includes(values.operation));
const ownerUrl = new URL("../../src/gateway/session-store-key.ts", import.meta.url);
const source = readFileSync(values.source ?? ownerUrl, "utf8");
let loaded = false;
registerHooks({
  load(url, context, nextLoad) {
    if (url === ownerUrl.href) {
      loaded = true;
      return { format: "module", source: stripTypeScriptTypes(source), shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
const { resolveSessionStoreKey, resolveSessionStoreIdentity, readSessionRoutingFacts } =
  await import("../../src/gateway/session-store-key.js");
const { freezeJsonSnapshot } = await import("../../src/shared/immutable-data.js");
assert(loaded, "Selected owner source must load");
const cfg = freezeJsonSnapshot({
  agents: {
    entries: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`worker-${i}`, {}])),
  },
});
const inputs = Array.from({ length: 10_000 }, (_, i) => {
  const agent = `worker-${i % 40}`;
  const tail =
    i % 20 === 0
      ? `matrix:channel:!Room${i}:Example.org`
      : i % 20 === 1
        ? `signal:group:Group${i}=`
        : `${i % 5 ? "subagent" : "dashboard"}:00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
  return { cfg, sessionKey: `agent:${agent}:${tail}`, storeAgentId: agent, agentId: agent };
});
const targets = inputs.map(({ sessionKey, agentId }) => [{ sessionKey, agentId }]);
function resolve(index: number): string {
  const input = inputs[index]!;
  return values.operation === "key"
    ? resolveSessionStoreKey(input)
    : values.operation === "identity"
      ? resolveSessionStoreIdentity(input).canonicalKey
      : readSessionRoutingFacts(cfg, targets[index]).identities![0]!.canonicalKey;
}
let checksum = 0;
function run(count: number) {
  for (let i = 0; i < count * 65; i++) {
    checksum += resolve(i % inputs.length).length;
  }
}
run(300);
globalThis.gc?.();
const inspector = values.mode === "allocation" ? new Session() : undefined;
inspector?.connect();
await inspector?.post("HeapProfiler.startSampling", {
  samplingInterval: 4096,
  includeObjectsCollectedByMajorGC: true,
  includeObjectsCollectedByMinorGC: true,
});
const hostLoad = loadavg();
const cpuStart = process.threadCpuUsage();
const started = performance.now();
run(iterations);
const elapsedMs = performance.now() - started;
const cpu = process.threadCpuUsage(cpuStart);
const allocation = await inspector?.post("HeapProfiler.stopSampling");
inspector?.disconnect();
function allocated(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
}
const digest = createHash("sha256");
for (let index = 0; index < inputs.length; index++) {
  digest.update(resolve(index)).update("\n");
}
console.log(
  JSON.stringify({
    mode: values.mode,
    operation: values.operation,
    iterations,
    calls: iterations * 65,
    ownerSha256: createHash("sha256").update(source).digest("hex"),
    digest: digest.digest("hex"),
    checksum,
    hostLoad,
    ...(allocation
      ? { sampledBytes: allocated(allocation.profile.head) }
      : {
          cpuMs: (cpu.user + cpu.system) / 1000,
          elapsedMs,
        }),
  }),
);
