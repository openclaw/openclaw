// 5,000 calls with 64 tool names; CPU and allocation are measured in separate passes.
// Run: node --expose-gc --import ./scripts/tsx.mjs scripts/perf/embedded-runner-array-copies.ts
// Compare a saved revision of tool-name-allowlist.ts with --owner <path>; alternate launch order.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { owner: { type: "string" } } });
const ownerUrl = new URL(
  "../../src/agents/embedded-agent-runner/tool-name-allowlist.ts",
  import.meta.url,
);
const source = readFileSync(values.owner ?? ownerUrl, "utf8");
let loaded = false;
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url !== ownerUrl.href) {
      return nextLoad(url, context);
    }
    loaded = true;
    return { format: "module", source: stripTypeScriptTypes(source), shortCircuit: true };
  },
});
const { toSessionToolAllowlist } =
  await import("../../src/agents/embedded-agent-runner/tool-name-allowlist.js");
hooks.deregister();
assert(loaded, "The selected owner must be loaded");
const inputs = Array.from(
  { length: 64 },
  (_, offset) =>
    new Set(Array.from({ length: 64 }, (_value, index) => `tool_${(index * 17 + offset) % 64}`)),
);
const expected = [...inputs[0]!].toSorted((a, b) => a.localeCompare(b));
let result: string[] = [];
function run() {
  for (let index = 0; index < 5_000; index++) {
    result = toSessionToolAllowlist(inputs[index % inputs.length]!);
  }
  assert.deepEqual(result, expected);
}
run();
const cpuMs: number[] = [];
const allocatedBytes: number[] = [];
const inspector = new Session();
inspector.connect();
for (let pass = 0; pass < 5; pass++) {
  globalThis.gc?.();
  const before = process.threadCpuUsage();
  run();
  const used = process.threadCpuUsage(before);
  cpuMs.push((used.user + used.system) / 1000);
}
for (let pass = 0; pass < 5; pass++) {
  globalThis.gc?.();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 512,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  run();
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  allocatedBytes.push(sum(profile.head));
}
inspector.disconnect();
console.log(
  JSON.stringify({
    ownerSha256: createHash("sha256").update(source).digest("hex"),
    iterationsPerPass: 5_000,
    namesPerCall: 64,
    cpuMs,
    allocatedBytes,
    hostLoad: loadavg(),
  }),
);
