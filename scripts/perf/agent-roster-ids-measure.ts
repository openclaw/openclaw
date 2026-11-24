/**
 * Warm roster-owner CPU/allocation measurement with a synthetic 200-agent fleet.
 * Run each revision with:
 * node --import ./scripts/tsx.mjs scripts/perf/agent-roster-ids-measure.ts
 * Add --allocations for a separate sampled-allocation pass (ignore its timings).
 * --module <absolute-path> selects an equivalent roster module from the base revision.
 * Acceptance: identical IDs, fewer rebuilt lists and lower CPU/allocation per lookup.
 * This isolates roster derivation; it makes no whole-Gateway latency claim.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { runtimeConfigPublication } from "../../src/config/runtime-config-publication.js";
import { freezeJsonSnapshot } from "../../src/shared/immutable-data.js";

const { values } = parseArgs({
  options: { module: { type: "string" }, allocations: { type: "boolean", default: false } },
});
const { listAgentIds }: typeof import("../../src/agents/agent-roster.js") = await import(
  values.module ? pathToFileURL(values.module).href : "../../src/agents/agent-roster.js"
);
const expected = Array.from({ length: 200 }, (_, index) => `agent-${index}`);
const inspector = new Session();
if (values.allocations) {
  inspector.connect();
}
try {
  for (const mode of ["published", "captured"] as const) {
    const config = {
      agents: {
        ownership: "explicit" as const,
        entries: Object.fromEntries(
          expected.map((id) => [
            id,
            { name: id, model: "mock/model", workspace: `/synthetic/${id}` },
          ]),
        ),
      },
    };
    if (mode === "published") {
      runtimeConfigPublication.current = { config, revision: {} };
    } else {
      freezeJsonSnapshot(config);
    }
    assert.deepEqual(listAgentIds(config), expected);
    for (let index = 0; index < 100; index++) {
      listAgentIds(config);
    }
    if (values.allocations) {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const samples = [];
    let previous = listAgentIds(config);
    let rebuiltLists = 0;
    let checksum = 0;
    for (let sample = 0; sample < 5; sample++) {
      const start = performance.now();
      const cpu = process.threadCpuUsage();
      for (let iteration = 0; iteration < 2000; iteration++) {
        const ids = listAgentIds(config);
        rebuiltLists += Number(ids !== previous);
        checksum += ids.length;
        previous = ids;
      }
      const used = process.threadCpuUsage(cpu);
      samples.push({
        elapsedMs: performance.now() - start,
        cpuMs: (used.user + used.system) / 1000,
      });
    }
    assert.equal(checksum, 2_000_000);
    let sampledBytes: number | undefined;
    if (values.allocations) {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      const nodes = [profile.head];
      sampledBytes = 0;
      for (const node of nodes) {
        sampledBytes += node.selfSize;
        nodes.push(...node.children);
      }
    }
    console.log(
      JSON.stringify({
        mode,
        operations: 10_000,
        rebuiltLists,
        sampledBytes,
        samples,
        load: loadavg(),
      }),
    );
  }
} finally {
  runtimeConfigPublication.current = undefined;
  if (values.allocations) {
    inspector.disconnect();
  }
}
