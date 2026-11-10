// Owner microbench: 40 unchanged extensions, two missing-handler lookups per delta.
// Verify live registration/removal before warmup. No whole-Gateway latency claim.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/extension-handler-lookup-measure.ts
// --events 100000 [--allocations] [--module /absolute/frozen/runner.ts]
// Run at least five alternating base/candidate pairs. Sample allocations separately
// from CPU; the frozen owner must resolve its imports against the same dependencies.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createExtensionRuntime } from "../../src/agents/sessions/extensions/loader.js";
import type { Extension } from "../../src/agents/sessions/extensions/types.js";
import type { ModelRegistry } from "../../src/agents/sessions/model-registry.js";
import type { SessionManager } from "../../src/agents/sessions/session-manager.js";
import { startCollectedHeapSampling } from "../lib/heap-sampling.ts";

const { values } = parseArgs({
  options: {
    events: { type: "string", default: "100000" },
    allocations: { type: "boolean", default: false },
    module: { type: "string" },
  },
});
const events = Number(values.events);
assert(Number.isSafeInteger(events) && events > 0);
assert(globalThis.gc, "Run with --expose-gc");
const { ExtensionRunner }: typeof import("../../src/agents/sessions/extensions/runner.js") =
  await import(
    values.module
      ? pathToFileURL(values.module).href
      : "../../src/agents/sessions/extensions/runner.js"
  );
const extensions = Array.from({ length: 40 }, (_, index) => ({
  path: `/synthetic/extension-${index}.ts`,
  handlers: new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>(),
})) as Extension[];
// The lookup owner never accesses session persistence or model discovery.
const runner = new ExtensionRunner(
  extensions,
  createExtensionRuntime(),
  "/synthetic",
  {} as SessionManager,
  {} as ModelRegistry,
);
const handler = async () => undefined;
const handlers = [handler];
const empty: typeof handlers = [];
const event = "message_update";
const first = extensions[0]!.handlers;
const last = extensions[39]!.handlers;
assert.equal(runner.hasHandlers(event), false);
last.set(event, handlers);
assert.equal(runner.hasHandlers(event), true);
last.delete(event);
assert.equal(runner.hasHandlers(event), false);
first.set(event, empty);
assert.equal(runner.hasHandlers(event), false);
first.set(event, handlers);
assert.equal(runner.hasHandlers(event), true);
first.delete(event);
assert.equal(runner.hasHandlers(event), false);
function run(count: number) {
  let digest = 2166136261;
  let matches = 0;
  for (let index = 0; index < count; index++) {
    const before = runner.hasHandlers(event);
    const after = runner.hasHandlers(event);
    matches += Number(before) + Number(after);
    digest = Math.imul(digest ^ (Number(before) * 2 + Number(after)), 16777619) >>> 0;
  }
  return { digest, matches };
}
run(100_000);
globalThis.gc();
const inspector = new Session();
if (values.allocations) {
  await startCollectedHeapSampling(inspector, 4096);
}
const load = loadavg();
const cpuStart = process.threadCpuUsage();
const started = performance.now();
const result = run(events);
const wallMs = performance.now() - started;
const cpu = process.threadCpuUsage(cpuStart);
let allocatedBytes: number | undefined;
let ownerAllocatedBytes: number | undefined;
if (values.allocations) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  allocatedBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  function ownerBytes(node: HeapProfiler.SamplingHeapProfileNode, insideOwner = false): number {
    const owned = insideOwner || node.callFrame.functionName === "hasHandlers";
    return (
      (owned ? node.selfSize : 0) +
      node.children.reduce((sum, child) => sum + ownerBytes(child, owned), 0)
    );
  }
  ownerAllocatedBytes = ownerBytes(profile.head);
  inspector.disconnect();
}
assert.equal(result.matches, 0);
console.log(
  JSON.stringify({
    events,
    lookups: events * 2,
    allocations: values.allocations,
    digest: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
    cpuMs: (cpu.user + cpu.system) / 1000,
    wallMs,
    allocatedBytes,
    ownerAllocatedBytes,
    load,
    memory: process.memoryUsage(),
  }),
);
