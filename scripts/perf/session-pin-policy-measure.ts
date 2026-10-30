/**
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-pin-policy-measure.ts
 * [--source /absolute/path/session-pin-policy.ts] [--iterations 20] [--samples 5]
 * Compare the same workload against base and candidate, alternating launch order.
 * Each iteration checks 10k entries: 80% finished subagents, 20% pinned dashboards
 * parented to their agent main. Timing and allocation use separate passes.
 */
import assert from "node:assert/strict";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { SessionEntry } from "../../src/config/sessions/types.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    source: { type: "string" },
    iterations: { type: "string", default: "20" },
    samples: { type: "string", default: "5" },
  },
});
const integer = (name: "iterations" | "samples") =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min: 1, fallback: 1 });
const iterations = integer("iterations");
const samples = integer("samples");
const source = values.source
  ? pathToFileURL(values.source)
  : new URL("../../src/config/sessions/session-pin-policy.ts", import.meta.url);
const { isPinnableSessionEntry } = (await import(
  source.href
)) as typeof import("../../src/config/sessions/session-pin-policy.js");
const entries = Array.from({ length: 10_000 }, (_, index) => {
  const agent = `agent-${index % 40}`;
  const subagent = index % 5 !== 0;
  return {
    key: `agent:${agent}:${subagent ? "subagent" : "dashboard"}:session-${index}`,
    entry: {
      sessionId: `session-${index}`,
      updatedAt: 1,
      pinnedAt: subagent ? undefined : 1,
      parentSessionKey: `agent:${agent}:main`,
    } satisfies SessionEntry,
  };
});
function run(count: number) {
  let pinnable = 0;
  for (let iteration = 0; iteration < count; iteration++) {
    for (const { key, entry } of entries) {
      pinnable += Number(isPinnableSessionEntry(key, entry));
    }
  }
  assert.equal(pinnable, count * 2_000);
}
function allocated(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
}
run(2);
for (const mode of ["timing", "allocation"] as const) {
  for (let sample = 0; sample < samples; sample++) {
    globalThis.gc?.();
    const hostLoad = loadavg();
    const inspector = mode === "allocation" ? new Session() : undefined;
    inspector?.connect();
    await inspector?.post("HeapProfiler.startSampling", {
      samplingInterval: 32_768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    const cpuStart = process.cpuUsage();
    const start = performance.now();
    run(iterations);
    const elapsedMs = performance.now() - start;
    const cpu = process.cpuUsage(cpuStart);
    const allocation = await inspector?.post("HeapProfiler.stopSampling");
    inspector?.disconnect();
    const operations = iterations * entries.length;
    console.log(
      JSON.stringify({
        mode,
        sample,
        operations,
        hostLoad,
        ...(allocation
          ? { sampledBytesPerEntry: allocated(allocation.profile.head) / operations }
          : {
              cpuUsPerEntry: (cpu.user + cpu.system) / operations,
              wallUsPerEntry: (elapsedMs * 1_000) / operations,
            }),
      }),
    );
  }
}
