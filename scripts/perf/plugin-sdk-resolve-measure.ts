// Native SDK resolve-hook owner benchmark, with 40 prepared synthetic SDK contexts.
// Run unchanged on base/candidate: node --import ./scripts/tsx.mjs
// scripts/perf/plugin-sdk-resolve-measure.ts --iterations 5000 [--allocations]
// Each warmed import resolves an ordinary module, outside SDK roots. Preserve its identity;
// accept less CPU/allocation and zero SDK-context scans. This is not whole-Gateway proof.
// Timing and allocation passes are separate; allocation-pass timing is diagnostic only.
import assert from "node:assert/strict";
import fs from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getPluginCache } from "../../src/plugins/plugin-cache.js";
import { installOpenClawPluginSdkNativeResolver } from "../../src/plugins/plugin-sdk-native-resolver.js";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "5000" },
    contexts: { type: "string", default: "40" },
    allocations: { type: "boolean", default: false },
  },
});
const iterations = Number(values.iterations);
const contextCount = Number(values.contexts);
assert(Number.isSafeInteger(iterations) && iterations >= 5 && iterations % 5 === 0);
assert(Number.isSafeInteger(contextCount) && contextCount > 0);
const directory = path.resolve(".local");
fs.mkdirSync(directory, { recursive: true });
const root = fs.mkdtempSync(path.join(directory, "sdk-resolve-measure-"));
const entries: string[] = [];
function write(filename: string, contents: string) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, contents);
}
try {
  for (let index = 0; index < contextCount; index++) {
    const host = path.join(root, `host-${index}`);
    write(
      path.join(host, "package.json"),
      JSON.stringify({
        name: "openclaw",
        type: "module",
        bin: { openclaw: "./openclaw.mjs" },
        exports: { "./plugin-sdk/core": "./dist/plugin-sdk/core.js" },
      }),
    );
    write(path.join(host, "openclaw.mjs"), "export {};\n");
    write(path.join(host, "dist/plugin-sdk/core.js"), "export const sdk = true;\n");
    const loader = path.join(host, "dist/plugins/loader.js");
    write(loader, "export {};\n");
    const entry = path.join(host, "external-plugin/index.js");
    write(entry, `export const index = ${index};\n`);
    installOpenClawPluginSdkNativeResolver({
      moduleUrl: pathToFileURL(loader).href,
      pluginModulePath: entry,
      pluginSdkResolution: "dist",
      devSourceRoot: null,
    });
    entries.push(pathToFileURL(entry).href);
  }
  const expected = await Promise.all(entries.map((entry) => import(entry)));
  async function run(count: number) {
    for (let completed = 0; completed < count;) {
      for (const [index, entry] of entries.entries()) {
        assert.equal(await import(entry), expected[index]);
        if (++completed === count) {
          break;
        }
      }
    }
  }
  await run(200);
  const contexts = getPluginCache().sdk.contexts;
  const contextValues = contexts.values.bind(contexts);
  let contextScans = 0;
  contexts.values = () => {
    contextScans++;
    return contextValues();
  };
  await run(10);
  Reflect.deleteProperty(contexts, "values");
  const inspector = new Session();
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostLoadBefore = loadavg();
  const batches = [];
  for (let batch = 0; batch < 5; batch++) {
    const cpu = process.threadCpuUsage();
    const start = performance.now();
    await run(iterations / 5);
    const wallMs = performance.now() - start;
    const used = process.threadCpuUsage(cpu);
    batches.push({
      iterations: iterations / 5,
      wallMs,
      threadCpuMs: (used.user + used.system) / 1000,
    });
  }
  let allocatedBytes: number | undefined;
  if (values.allocations) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    allocatedBytes = sum(profile.head);
    inspector.disconnect();
  }
  console.log(
    JSON.stringify({
      iterations,
      contextCount: contexts.size,
      probeImports: 10,
      contextScans,
      allocations: values.allocations,
      batches,
      allocatedBytes,
      hostLoadBefore,
      hostLoadAfter: loadavg(),
      memory: process.memoryUsage(),
    }),
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
