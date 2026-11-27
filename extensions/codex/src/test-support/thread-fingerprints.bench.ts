/** Owner-only: node --expose-gc --import ./scripts/tsx.mjs extensions/codex/src/test-support/thread-fingerprints.bench.ts */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import {
  flattenCodexDynamicToolFunctions,
  type CodexDynamicToolSpec,
  type JsonValue,
} from "../app-server/protocol.js";
import {
  codexDynamicToolsFingerprint,
  codexLegacyDynamicToolsFingerprint,
  stabilizeJsonValue,
} from "../app-server/thread-fingerprints.js";

// Frozen pre-optimization algorithm; the complete canonical JSON is a persisted contract.
function baseline(tools: readonly JsonValue[]) {
  return JSON.stringify(
    tools
      .map(stabilizeJsonValue)
      .toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  );
}
const algorithms = { baseline, candidate: codexLegacyDynamicToolsFingerprint };
const fixture = new URL(
  "../../../../test/fixtures/agents/prompt-snapshots/codex-runtime-happy-path/codex-dynamic-tools.telegram-direct.json",
  import.meta.url,
);
const catalogTools = JSON.parse(readFileSync(fixture, "utf8")) as CodexDynamicToolSpec[];
const sourceTools = flattenCodexDynamicToolFunctions(catalogTools);
const goldenCatalogs = [
  catalogTools,
  catalogTools.toReversed(),
  sourceTools,
  [null, true, false, 0, -0, 1.5, "é", "e", "E", [1, null, "x"]],
  [JSON.parse('{"__proto__":{"x":1},"2":"two","10":"ten","a":"\\n\\\""}')],
];
for (const catalog of goldenCatalogs) {
  const legacy = baseline(catalog);
  assert.equal(algorithms.candidate(catalog), legacy);
  assert.equal(
    codexDynamicToolsFingerprint(catalog),
    `sha256:${createHash("sha256").update(legacy).digest("hex")}`,
  );
}

const samples = 5;
const iterations = 10;
const inspector = new Session();
inspector.connect();
function countWork(run: () => string) {
  const stringify = JSON.stringify;
  let calls = 0;
  let chars = 0;
  JSON.stringify = (input: unknown) => {
    const value = stringify(input);
    calls++;
    chars += value?.length ?? 0;
    return value;
  };
  try {
    run();
  } finally {
    JSON.stringify = stringify;
  }
  return { stringifyCalls: calls, stringifyChars: chars };
}
function sampledBytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + sampledBytes(child), 0);
}
const results = [];
try {
  for (const size of [10, 50, 200]) {
    const tools = Array.from({ length: size }, (_, index) => ({
      ...sourceTools[(index * 7) % sourceTools.length]!,
      name: `tool_${(index * 137) % size}`,
    }));
    assert.equal(algorithms.candidate(tools), baseline(tools));
    const cold = [];
    for (const [name, fingerprint] of Object.entries(algorithms)) {
      const start = performance.now();
      fingerprint(tools);
      cold.push({ name, ms: performance.now() - start, ...countWork(() => fingerprint(tools)) });
      for (let warmup = 0; warmup < 2; warmup++) {
        fingerprint(tools);
      }
    }
    const measurements = [];
    for (let sample = 0; sample < samples; sample++) {
      for (const [name, fingerprint] of Object.entries(algorithms)) {
        globalThis.gc?.();
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 4096,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
        const start = performance.now();
        for (let iteration = 0; iteration < iterations; iteration++) {
          fingerprint(tools);
        }
        const msPerOp = (performance.now() - start) / iterations;
        const { profile } = await inspector.post("HeapProfiler.stopSampling");
        const allocatedBytesPerOp = sampledBytes(profile.head) / iterations;
        measurements.push({ sample, name, msPerOp, allocatedBytesPerOp });
      }
    }
    results.push({ size, cold, measurements });
  }
} finally {
  inspector.disconnect();
}
const report = {
  goldenCases: goldenCatalogs.length,
  fixture: fixture.pathname,
  samples,
  iterations,
  loadavg: loadavg(),
  results,
};
console.log(JSON.stringify(report, null, 2));
