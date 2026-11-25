// Diagnostic owner workload: node --import ./scripts/tsx.mjs scripts/perf/operator-model-policy-measure.ts
// Run the same five passes on each revision; add --allocations for a separate sampled pass.
// Gateway load proof: scripts/perf/team-shape-stress.ts --operator-model-policy.
import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { prepareOperatorModelPolicy } from "../../src/agents/operator-model-policy.ts";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../src/config/runtime-snapshot.ts";
import type { OpenClawConfig } from "../../src/config/types.openclaw.ts";
import { freezeJsonSnapshot } from "../../src/shared/immutable-data.ts";

const policy = { sourceAgent: "main", deny: ["fixture/restricted-*"] };
const cfg = freezeJsonSnapshot<OpenClawConfig>({
  gateway: {
    roles: {
      default: "reader",
      definitions: {
        reader: { agents: "*", scopes: [], sessions: { others: "write" }, modelPolicy: policy },
      },
    },
  },
  agents: {
    defaults: {
      model: "fixture/primary",
      models: Object.fromEntries(
        Array.from({ length: 64 }, (_, index) => [
          `fixture/model-${index}`,
          { alias: `alias-${index}` },
        ]),
      ),
    },
    entries: {
      main: { model: { primary: "fixture/primary", fallbacks: ["alias-0", "alias-1"] } },
    },
  },
});
const manifestPlugins = { owners: { modelIdNormalizationPolicies: new Map() } };
const inspector = process.argv.includes("--allocations") ? new Session() : undefined;
inspector?.connect();
setRuntimeConfigSnapshot(cfg);
try {
  for (let pass = 0; pass < 5; pass++) {
    await inspector?.post("HeapProfiler.startSampling", {
      samplingInterval: 1024,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    const start = performance.now();
    const cpu = process.cpuUsage();
    let models = 0;
    for (let index = 0; index < 5_000; index++) {
      models += prepareOperatorModelPolicy({ cfg, policy, manifestPlugins })!.models.length;
    }
    const used = process.cpuUsage(cpu);
    const wallMs = performance.now() - start;
    const sampled = await inspector?.post("HeapProfiler.stopSampling");
    console.log(
      JSON.stringify({
        pass,
        operations: 5_000,
        models,
        mode: inspector ? "allocation-diagnostic" : "untraced-timing",
        wallMs,
        cpuMs: (used.user + used.system) / 1_000,
        heapUsed: process.memoryUsage().heapUsed,
        ...(sampled
          ? { sampledBytes: sampled.profile.samples.reduce((sum, sample) => sum + sample.size, 0) }
          : {}),
      }),
    );
  }
} finally {
  inspector?.disconnect();
  clearRuntimeConfigSnapshot();
}
