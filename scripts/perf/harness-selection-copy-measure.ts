/**
 * Built-in harness handoff owner probe; synthetic state, no Gateway/provider.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/harness-selection-copy-measure.ts
 *   --source <saved-selection.ts> --mode timing|allocation|major|counts --iterations 3000
 * Alternate five base/candidate pairs per mode. Counts supports --expect-copies 1
 * as a regression check (the old owner retains two distinct full-width copies).
 * Executes the exact rest/handoff block and private helper from the selected source;
 * does not export a production test seam. Plugin handoffs are outside this probe.
 * 205-property attempts, 40 plugin configs, 64 concurrent handoffs held across awaits.
 * Allocation includes collected samples; major excludes minor-collected samples.
 * MiB/min is this owner workload's rate, NOT a production or whole-Gateway estimate.
 * Acceptance: equal handoff contents, preserved caller, one owned copy, lower
 * allocation/CPU. Timing is untraced; sampling passes do not gate latency or GC.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import { compileFunction } from "node:vm";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";

const { values } = parseArgs({
  options: {
    source: { type: "string", default: "src/agents/harness/selection.ts" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "3000" },
    "expect-copies": { type: "string" },
    output: { type: "string" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0 && iterations <= 100_000);
assert(["timing", "allocation", "major", "counts"].includes(values.mode));
assert(global.gc, "Use --expose-gc");
const source = readFileSync(values.source, "utf8");
const start = source.indexOf("  const {\n    contextEngineLogicalTurnLease:");
const end = source.indexOf("  let result: EmbeddedRunAttemptResult;", start);
const helper = source.indexOf("function withoutInternalHarnessAuthority(");
assert(start >= 0 && end > start && helper > end, "Owner source boundaries changed");
type Handoff = {
  attemptParams: Record<string, unknown>;
  pluginAttempt: { params: Record<string, unknown> };
};
const compiled = compileFunction(
  `${stripTypeScriptTypes(`
    ${source.slice(helper)}
    const selection = { builtIn: true, ownerPluginId: undefined };
    const harness = { id: "openclaw" };
    ${source.slice(start, end)}
  `)}\nreturn { attemptParams, pluginAttempt };`,
  ["internalParams"],
  { filename: values.source },
);
function isHandoff(value: unknown): value is Handoff {
  return (
    isRecord(value) &&
    isRecord(value.attemptParams) &&
    isRecord(value.pluginAttempt) &&
    isRecord(value.pluginAttempt.params)
  );
}
function prepare(input: Record<string, unknown>): Handoff {
  const value: unknown = compiled(input);
  assert(isHandoff(value), "Compiled owner returned an invalid handoff");
  return value;
}
const instance = { runId: "synthetic-run", instanceId: "synthetic-instance" };
const input: Record<string, unknown> = {
  admittedRunContext: { operationalRunInstance: instance },
  config: {
    plugins: {
      entries: Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [`synthetic-${i}`, { enabled: true }]),
      ),
    },
  },
  sessionKey: "agent:main:synthetic",
  prompt: "synthetic prompt ".repeat(1024),
  toolsAllow: ["read", "exec"],
  contextEngineLogicalTurnLease: { synthetic: true },
  systemAgentTool: { synthetic: true },
};
for (let i = Object.keys(input).length; i < 205; i++) {
  input[`optionalAttemptField${i}`] = undefined;
}
Object.freeze(input);
const beforeInput = Object.getOwnPropertyDescriptors(input);
const { contextEngineLogicalTurnLease: _lease, systemAgentTool: _tool, ...expected } = input;
expected.operationalRunInstance = instance;
const golden = prepare(input);
assert.deepEqual(golden.pluginAttempt.params, expected);
assert.notEqual(golden.pluginAttempt.params, input);
assert.deepEqual(Object.getOwnPropertyDescriptors(input), beforeInput);
const retainedCopies = new Set([golden.attemptParams, golden.pluginAttempt.params]).size;
if (values["expect-copies"] !== undefined) {
  assert.equal(values.mode, "counts");
  assert.equal(retainedCopies, Number(values["expect-copies"]), "retained full-width copies");
}
async function workload(count: number) {
  for (let offset = 0; offset < count; offset += 64) {
    const pending = Array.from({ length: Math.min(64, count - offset) }, () => prepare(input));
    await nextTurn();
    for (const handoff of pending) {
      assert.equal(handoff.pluginAttempt.params.operationalRunInstance, instance);
      assert.equal(handoff.attemptParams.runtimePluginToolGrant, undefined);
    }
  }
}
await workload(256);
global.gc();
const inspector = new Session();
const sampled = values.mode === "allocation" || values.mode === "major";
if (sampled) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: values.mode === "allocation",
  });
}
const memoryBefore = process.memoryUsage();
const hostLoadBefore = loadavg();
const cpu = process.threadCpuUsage();
const startTime = performance.now();
if (values.mode !== "counts") {
  await workload(iterations);
}
const elapsedMs = performance.now() - startTime;
const used = process.threadCpuUsage(cpu);
const memoryAfter = process.memoryUsage();
let sampledBytes: number | undefined;
if (sampled) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  if (values.output) {
    writeFileSync(`${values.output}.heapprofile`, JSON.stringify(profile));
  }
  inspector.disconnect();
}
const result = {
  mode: values.mode,
  sourceSha256: createHash("sha256").update(source).digest("hex"),
  outputSha256: createHash("sha256").update(JSON.stringify(expected)).digest("hex"),
  properties: Object.keys(input).length,
  retainedCopies,
  iterations,
  elapsedMs,
  cpuUsPerAttempt: (used.user + used.system) / iterations,
  sampledBytesPerAttempt: sampledBytes === undefined ? undefined : sampledBytes / iterations,
  sampledMiBPerMinute:
    sampledBytes === undefined ? undefined : (sampledBytes / 1024 ** 2 / elapsedMs) * 60_000,
  memoryBefore,
  memoryAfter,
  hostLoadBefore,
  hostLoadAfter: loadavg(),
};
if (values.output) {
  writeFileSync(values.output, `${JSON.stringify(result, null, 2)}\n`);
}
console.log(JSON.stringify(result));
