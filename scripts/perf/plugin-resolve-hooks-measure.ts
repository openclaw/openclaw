/**
 * Measure the real plugin loader's process-wide resolve chain with 40 synthetic plugins.
 * Run on each revision: node --expose-gc --import ./scripts/tsx.mjs
 * scripts/perf/plugin-resolve-hooks-measure.ts [iterations=5000] [plugins=40]
 * Reports hook count after boot/replacements/disposal and sampled allocation + CPU
 * for warm host import() calls in separate timing/allocation passes. Append "probe"
 * to count instrumented calls/depth instead of using that run for timings. No Gateway or operator state is accessed.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import inspector from "node:inspector/promises";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createPluginCache,
  retirePluginCache,
  withPluginCache,
} from "../../src/plugins/plugin-cache.ts";
import { bindPluginInstanceModuleLoader } from "../../src/plugins/plugin-instance-module-loader.ts";
import { PluginInstance } from "../../src/plugins/plugin-instance.ts";

const iterations = Number(process.argv[2] ?? 5000);
const plugins = Number(process.argv[3] ?? 40);
const probe = process.argv[4] === "probe";
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(Number.isSafeInteger(plugins) && plugins > 0);
const directory = path.resolve(".local");
fs.mkdirSync(directory, { recursive: true });
const root = fs.mkdtempSync(path.join(directory, "plugin-resolve-"));
process.env.OPENCLAW_STATE_DIR = path.join(root, "state");
const original = Module.registerHooks;
let active = 0;
let calls = 0;
let depth = 0;
let maxDepth = 0;
Module.registerHooks = (hooks) => {
  const resolve = hooks.resolve;
  const handle = original({
    ...hooks,
    ...(resolve && probe
      ? {
          resolve(specifier, context, nextResolve) {
            calls++;
            maxDepth = Math.max(maxDepth, ++depth);
            try {
              return resolve(specifier, context, nextResolve);
            } finally {
              depth--;
            }
          },
        }
      : {}),
  });
  if (resolve) {
    active++;
  }
  const deregister = handle.deregister.bind(handle);
  return {
    deregister() {
      if (resolve) {
        active--;
      }
      deregister();
    },
  };
};
const cache = createPluginCache();
const owners: PluginInstance[] = [];
const session = new inspector.Session();
session.connect();
try {
  const entry = path.join(root, "entry.cjs");
  fs.writeFileSync(entry, "exports.value = 42;");
  const host = path.join(root, "host.mjs");
  fs.writeFileSync(host, "export const value = 42;");
  const url = pathToFileURL(host).href;
  const load = (index: number) => {
    const instance = new PluginInstance(`fixture-${index}`);
    withPluginCache(cache, () =>
      bindPluginInstanceModuleLoader({
        instance,
        origin: "config",
        source: entry,
        rootDir: root,
        standalone: true,
      }),
    );
    assert.equal((instance.loadModule(entry) as { value: number }).value, 42);
    return instance;
  };
  for (let i = 0; i < plugins; i++) {
    owners.push(load(i));
  }
  const bootHooks = active;
  for (const [i, owner] of owners.entries()) {
    await owner.dispose();
    owners[i] = load(i);
  }
  const reloadedHooks = active;
  for (let i = 0; i < 500; i++) {
    await import(url);
  }
  globalThis.gc?.();
  calls = maxDepth = 0;
  const cpu = process.cpuUsage();
  const started = performance.now();
  for (let i = 0; i < iterations; i++) {
    await import(url);
  }
  const elapsedMs = performance.now() - started;
  const used = process.cpuUsage(cpu);
  const resolveCalls = calls;
  await session.post("HeapProfiler.startSampling", {
    samplingInterval: 512,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  for (let i = 0; i < iterations; i++) {
    await import(url);
  }
  const { profile } = await session.post("HeapProfiler.stopSampling");
  const sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  const measured = {
    iterations,
    plugins,
    bootHooks,
    reloadedHooks,
    resolveCalls: probe ? resolveCalls : null,
    maxDepth: probe ? maxDepth : null,
    cpuMs: (used.user + used.system) / 1000,
    elapsedMs,
    sampledBytes,
    hostLoad: os.loadavg(),
    rss: process.memoryUsage().rss,
  };
  for (const instance of owners) {
    await instance.dispose();
  }
  console.log(JSON.stringify({ ...measured, disposedHooks: active }));
} finally {
  Module.registerHooks = original;
  session.disconnect();
  for (const instance of owners) {
    await instance.dispose();
  }
  await retirePluginCache(cache);
  fs.rmSync(root, { recursive: true, force: true });
}
