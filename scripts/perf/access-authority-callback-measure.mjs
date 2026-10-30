// Bundle each revision's src/plugins/gateway-access-policy-registration.ts:
// node_modules/.bin/esbuild <source> --bundle --platform=node --format=esm --outfile=<arm>.mjs
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/access-authority-callback-measure.mjs \
//   --base <base.mjs> --candidate <candidate.mjs> --iterations 5000 --pairs 5
// Use --mode timing with a larger fixed count for short/noisy CPU windows.
// Acceptance: less allocation with no repeatable CPU regression; serial AB/BA,
// separate untraced CPU and sampled-allocation passes. Fresh real plugin scopes,
// 40 plugins and 64 alternating caller scopes; one applicable policy per caller.
// Operations model 1 assertion, 2 per ordinary event, 4 per tool activity event,
// and 8 in the outer transcript-write path (excluding storage/recovery callbacks).
// This owner benchmark does not measure whole-Gateway latency or throughput.
import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { PluginInstance } from "../../src/plugins/plugin-instance.ts";
import { createEmptyPluginRegistry } from "../../src/plugins/registry-empty.ts";
import { withPluginRuntimeGatewayRequestScope } from "../../src/plugins/runtime/gateway-request-scope.ts";
import { createPluginRecord } from "../../src/plugins/status.test-helpers.ts";

const { values } = parseArgs({
  options: {
    base: { type: "string" },
    candidate: { type: "string" },
    iterations: { type: "string", default: "5000" },
    pairs: { type: "string", default: "5" },
    mode: { type: "string", default: "all" },
  },
});
assert(values.base && values.candidate && globalThis.gc);
const iterations = Number(values.iterations);
const pairs = Number(values.pairs);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(Number.isSafeInteger(pairs) && pairs > 0);
assert(["all", "timing", "allocation"].includes(values.mode));
const modules = {
  base: await import(pathToFileURL(values.base).href),
  candidate: await import(pathToFileURL(values.candidate).href),
};
const registry = createEmptyPluginRegistry();
const instances = Array.from({ length: 40 }, (_, index) => {
  const record = createPluginRecord({ id: `policy-${index}` });
  registry.plugins.push(record);
  return new PluginInstance(record.id, { record, registry });
});
const callers = Array.from({ length: 64 }, () => ({ isWebchatConnect: () => true }));
const context = {
  config: {},
  profile: { profileId: "synthetic-person", emails: [], assignedRole: null },
  requiredByRole: true,
};
const inspector = new Session();
inspector.connect();
const results = [];
try {
  for (const checksPerOperation of [1, 2, 4, 8]) {
    for (const mode of ["timing", "allocation"]) {
      if (values.mode !== "all" && values.mode !== mode) {
        continue;
      }
      for (let pair = 0; pair < pairs; pair++) {
        for (const arm of pair % 2 ? ["candidate", "base"] : ["base", "candidate"]) {
          let checks = 0;
          let revoked = false;
          const authorities = instances.map((instance) =>
            modules[arm]
              .bindPluginGatewayAccessPolicy(
                {
                  authorize: () => ({
                    signal: new AbortController().signal,
                    assertCurrent() {
                      checks++;
                      if (revoked) {
                        throw new Error("revoked");
                      }
                    },
                  }),
                },
                instance,
              )
              .authorize(context),
          );
          const operation = (index) =>
            withPluginRuntimeGatewayRequestScope(callers[index % callers.length], () => {
              const authority = authorities[index % authorities.length];
              for (let check = 0; check < checksPerOperation; check++) {
                authority.assertCurrent();
              }
            });
          let scopeEntries = 0;
          const hook = createHook({
            init(_id, type) {
              if (type === "OpenClawAsyncStore") {
                scopeEntries++;
              }
            },
          });
          hook.enable();
          try {
            operation(0);
          } finally {
            hook.disable();
          }
          assert.equal(scopeEntries, checksPerOperation + 1);
          for (let index = 0; index < 2000; index++) {
            operation(index);
          }
          globalThis.gc();
          if (mode === "allocation") {
            await inspector.post("HeapProfiler.startSampling", {
              samplingInterval: 1024,
              includeObjectsCollectedByMajorGC: true,
              includeObjectsCollectedByMinorGC: true,
            });
          }
          checks = 0;
          const hostLoad = loadavg();
          const cpu = process.threadCpuUsage();
          const start = performance.now();
          for (let index = 0; index < iterations; index++) {
            operation(index);
          }
          const elapsedMs = performance.now() - start;
          const used = process.threadCpuUsage(cpu);
          assert.equal(checks, iterations * checksPerOperation);
          let allocatedBytes;
          if (mode === "allocation") {
            const { profile } = await inspector.post("HeapProfiler.stopSampling");
            const total = (node) =>
              node.selfSize + node.children.reduce((sum, child) => sum + total(child), 0);
            allocatedBytes = total(profile.head);
          }
          revoked = true;
          assert.throws(() => operation(0), /revoked/);
          results.push({
            checksPerOperation,
            scopeEntries,
            mode,
            pair: pair + 1,
            arm,
            iterations,
            hostLoad,
            elapsedMs,
            cpuNsPerOperation: ((used.user + used.system) * 1000) / iterations,
            allocatedBytesPerOperation:
              allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
          });
        }
      }
    }
  }
  console.log(JSON.stringify({ node: process.version, warmup: 2000, results }, null, 2));
} finally {
  inspector.disconnect();
  for (const instance of instances) {
    await instance.dispose();
  }
}
