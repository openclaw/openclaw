// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/access-policy-scope-measure.ts
//   <synthetic-fixture-root> <label> [timing|allocation]
// Real policy binding + managed plugin admission, 40 plugins and 10,000 profile authorities.
// Acceptance: closed-turn policy checks succeed; record healthy-path admission
// cost against A/A variation. Storage is intentionally untouched by this owner.
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import {
  bindPluginGatewayAccessPolicy,
  assertBoundGatewayAccessDecision,
} from "../../src/plugins/gateway-access-policy-registration.js";
import { createPluginRecord } from "../../src/plugins/loader-records.js";
import { PluginInstance } from "../../src/plugins/plugin-instance.js";
import { PluginInvocationScope } from "../../src/plugins/plugin-invocation-scope.js";
import { createEmptyPluginRegistry } from "../../src/plugins/registry-empty.js";

const [fixtureRoot, label, mode = "timing"] = process.argv.slice(2);
assert(fixtureRoot && label && globalThis.gc);
assert(mode === "timing" || mode === "allocation");
const fixture = JSON.parse(readFileSync(path.join(fixtureRoot, "fixture.json"), "utf8"));
assert.equal(statSync(fixture.databasePath).size, fixture.databaseBytes);
assert(fixture.sessionCount >= 10000 && fixture.workspace.files >= 62000);
const registry = createEmptyPluginRegistry();
const instances = Array.from({ length: 40 }, (_, index) => {
  const record = createPluginRecord({
    id: `synthetic-${index}`,
    source: "synthetic",
    origin: "workspace",
    enabled: true,
    configSchema: false,
  });
  record.status = "loaded";
  registry.plugins.push(record);
  return new PluginInstance(record.id, { record, registry });
});
let delivered = 0;
let errors = 0;
const policy = bindPluginGatewayAccessPolicy(
  {
    authorize: () => ({
      grantId: "synthetic-grant",
      signal: new AbortController().signal,
      assertCurrent() {
        delivered++;
      },
    }),
  },
  instances[0],
);
const config = {};
const authorities = Array.from({ length: 10000 }, (_, index) =>
  policy.authorize({
    config,
    profile: { profileId: `person-${index}`, emails: [], assignedRole: null },
    requiredByRole: true,
  })!,
);
const inspector = new Session();
if (mode === "allocation") {
  inspector.connect();
}
const samples: Array<{
  closed: boolean;
  sample: number;
  checks: number;
  delivered: number;
  errors: number;
  elapsedMs: number;
  cpuMs: number;
  allocatedBytes?: number;
}> = [];
try {
  for (const closed of [false, true]) {
    const scope = new PluginInvocationScope(registry, instances, { retained: true });
    try {
      await scope.run(async () => {
        if (closed) {
          scope.release();
        }
        const dispatch = (index: number) => {
          const authority = authorities[index % authorities.length]!;
          try {
            assertBoundGatewayAccessDecision(authority, undefined, authority.assertCurrent);
          } catch {
            errors++;
          }
        };
        for (let index = 0; index < 10000; index++) {
          dispatch(index);
        }
        for (let sample = 0; sample < 5; sample++) {
          globalThis.gc!();
          delivered = errors = 0;
          if (mode === "allocation") {
            await inspector.post("HeapProfiler.startSampling", {
              samplingInterval: 1024,
              includeObjectsCollectedByMajorGC: true,
              includeObjectsCollectedByMinorGC: true,
            });
          }
          const cpu = process.threadCpuUsage();
          const start = performance.now();
          const iterations = 10000;
          for (let index = 0; index < iterations; index++) {
            dispatch(index);
          }
          const elapsedMs = performance.now() - start;
          const used = process.threadCpuUsage(cpu);
          let allocatedBytes: number | undefined;
          if (mode === "allocation") {
            const { profile } = await inspector.post("HeapProfiler.stopSampling");
            allocatedBytes = profile.samples.reduce((total, entry) => total + entry.size, 0);
          }
          samples.push({
            closed,
            sample,
            checks: iterations,
            delivered,
            errors,
            elapsedMs,
            cpuMs: (used.user + used.system) / 1000,
            allocatedBytes,
          });
        }
      });
    } finally {
      scope.release();
    }
  }
  console.log(JSON.stringify({ label, mode, fixture, load: loadavg(), samples }));
} finally {
  inspector.disconnect();
  await Promise.all(instances.map((instance) => instance.dispose()));
}
