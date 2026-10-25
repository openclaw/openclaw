// Diagnostic owner workload: node --import ./scripts/tsx.mjs scripts/perf/operator-model-policy-measure.ts
// Run the same five passes on each revision. Gateway load proof is separate:
// scripts/perf/operator-model-policy-load.mjs. Heap usage here is not allocation rate.
import { performance } from "node:perf_hooks";
import { prepareOperatorModelPolicy } from "../../src/agents/operator-model-policy.ts";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../src/config/runtime-snapshot.ts";
import type { OpenClawConfig } from "../../src/config/types.openclaw.ts";
import { freezeJsonSnapshot } from "../../src/shared/immutable-data.ts";

const cfg = freezeJsonSnapshot<OpenClawConfig>({
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
const policy = { sourceAgent: "main", deny: ["fixture/restricted-*"] };
setRuntimeConfigSnapshot(cfg);
try {
  for (let pass = 0; pass < 5; pass++) {
    const start = performance.now();
    const cpu = process.cpuUsage();
    let models = 0;
    for (let index = 0; index < 5_000; index++) {
      models += prepareOperatorModelPolicy({ cfg, policy, manifestPlugins })!.models.length;
    }
    const used = process.cpuUsage(cpu);
    console.log(
      JSON.stringify({
        pass,
        operations: 5_000,
        models,
        wallMs: performance.now() - start,
        cpuMs: (used.user + used.system) / 1_000,
        heapUsed: process.memoryUsage().heapUsed,
      }),
    );
  }
} finally {
  clearRuntimeConfigSnapshot();
}
