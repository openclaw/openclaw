// From each revision, bundle the scope owner and its registry fixture:
// echo 'export * from "./src/plugins/runtime/gateway-request-scope.ts"; export {createEmptyPluginRegistry} from "./src/plugins/registry-empty.ts";' | \
//   node_modules/.bin/esbuild --bundle --platform=node --format=esm --outfile=<arm>.mjs
// node --expose-gc scripts/perf/plugin-registry-binding-measure.mjs --base <base.mjs> --candidate <candidate.mjs>
// Acceptance: lower allocation without repeatable CPU regression, 5 serial AB/BA
// pairs, untraced timing separate from allocation sampling. Measures the scope
// construction used by plugin access assertions, not whole-Gateway throughput.
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    base: { type: "string" },
    candidate: { type: "string" },
    pairs: { type: "string", default: "5" },
  },
});
assert(values.base && values.candidate && globalThis.gc);
const pairs = Number(values.pairs);
assert(Number.isSafeInteger(pairs) && pairs > 0);
const modules = {
  base: await import(pathToFileURL(values.base).href),
  candidate: await import(pathToFileURL(values.candidate).href),
};
const plugins = Array.from({ length: 40 }, (_, i) => ({ pluginId: `synthetic-${i}` }));
const callers = Array.from({ length: 64 }, () => ({
  isWebchatConnect: () => true,
  signal: new AbortController().signal,
  hasCurrentClientAuthority: () => true,
}));
const inspector = new Session();
inspector.connect();
const results = [];
try {
  for (const mode of ["timing", "allocation"]) {
    for (let pair = 0; pair < pairs; pair++) {
      for (const arm of pair % 2 ? ["candidate", "base"] : ["base", "candidate"]) {
        const mod = modules[arm];
        const registry = mod.createEmptyPluginRegistry();
        const operation = (i) =>
          mod.withPluginRuntimeGatewayRequestScope(callers[i % callers.length], () =>
            mod.withPluginRuntimePluginScope(plugins[i % plugins.length], () => {}, registry),
          );
        for (let i = 0; i < 2000; i++) {
          operation(i);
        }
        globalThis.gc();
        if (mode === "allocation") {
          await inspector.post("HeapProfiler.startSampling", {
            samplingInterval: 1024,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
        }
        const count = mode === "timing" ? 100_000 : 5000;
        const hostLoad = loadavg();
        const cpu = process.threadCpuUsage();
        const start = performance.now();
        for (let i = 0; i < count; i++) {
          operation(i);
        }
        const elapsedMs = performance.now() - start;
        const used = process.threadCpuUsage(cpu);
        let bytes;
        if (mode === "allocation") {
          const { profile } = await inspector.post("HeapProfiler.stopSampling");
          const sum = (node) =>
            node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
          bytes = sum(profile.head) / count;
        }
        results.push({
          arm,
          mode,
          pair: pair + 1,
          count,
          cpuNsPerScope: ((used.user + used.system) * 1000) / count,
          allocatedBytesPerScope: bytes,
          elapsedMs,
          hostLoad,
        });
      }
    }
  }
  console.log(JSON.stringify({ node: process.version, warmup: 2000, results }, null, 2));
} finally {
  inspector.disconnect();
}
