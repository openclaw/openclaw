// Native SDK resolve-hook owner benchmark, with 40 prepared synthetic SDK contexts.
// Run unchanged on base/candidate: node --import ./scripts/tsx.mjs
// scripts/perf/plugin-sdk-resolve-measure.ts --iterations 5000 [--allocations]
// Each warmed import resolves an ordinary module, outside SDK roots. Preserve its identity;
// accept less CPU/allocation and zero SDK-context scans. This is not whole-Gateway proof.
// Timing and allocation passes are separate; allocation-pass timing is diagnostic only.
// --sdk-requires measures repeated SDK access from one transformed plugin instead.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
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
    "sdk-requires": { type: "boolean", default: false },
    "source-ref": { type: "string" },
  },
});
if (values["source-ref"]) {
  const file = "src/plugins/plugin-module-loader-cache.ts";
  const owner = new URL(`../../${file}`, import.meta.url).href;
  const source = execFileSync("git", ["show", `${values["source-ref"]}:${file}`], {
    encoding: "utf8",
  });
  registerHooks({
    load(url, context, nextLoad) {
      return url === owner
        ? { format: "module-typescript", source, shortCircuit: true }
        : nextLoad(url, context);
    },
  });
}
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
  for (let index = 0; index < (values["sdk-requires"] ? 0 : contextCount); index++) {
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
  let sdkPath: string | undefined;
  let readSdk: (() => unknown) | undefined;
  let expectedSdk: unknown;
  if (values["sdk-requires"]) {
    const { getCachedPluginModuleLoader } =
      await import("../../src/plugins/plugin-module-loader-cache.js");
    sdkPath = path.join(root, "sdk.cjs");
    write(sdkPath, "module.exports = { marker: 42 };\n");
    const entry = path.join(root, "entry.ts");
    write(
      entry,
      'export function read() { return require("openclaw/plugin-sdk/fixture").marker; }',
    );
    const loader = getCachedPluginModuleLoader({
      modulePath: entry,
      importerUrl: import.meta.url,
      aliasMap: { "openclaw/plugin-sdk/fixture": sdkPath },
      tryNative: false,
    });
    readSdk = (loader(entry) as { read(this: void): unknown }).read;
    expectedSdk = readSdk();
    assert.equal(expectedSdk, 42);
  }
  async function run(count: number) {
    if (readSdk) {
      for (let completed = 0; completed < count; completed++) {
        assert.equal(readSdk(), expectedSdk);
      }
      return;
    }
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
  let sdkResolveCalls = 0;
  const probe = sdkPath
    ? registerHooks({
        resolve(specifier, context, nextResolve) {
          sdkResolveCalls += Number(specifier === sdkPath);
          return nextResolve(specifier, context);
        },
      })
    : undefined;
  await run(10);
  probe?.deregister();
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
      sourceRef: values["source-ref"] ?? "working-tree",
      contextCount: contexts.size,
      probeImports: 10,
      contextScans,
      ...(sdkPath ? { sdkRequires: true, sdkResolveCalls } : {}),
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
