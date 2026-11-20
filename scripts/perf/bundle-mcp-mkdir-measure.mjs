/**
 * Compare actual MCP directory-preparation owners on an existing synthetic directory:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/bundle-mcp-mkdir-measure.mjs \
 *   --baseline src/agents/bundle-mcp-config.base.ts --fixture /path/to/synthetic-fixture
 * Keep the baseline beside its original source for unchanged relative imports.
 * Runs five A1/B/A2 controls; allocation and 100 ms injection are separate passes.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    baseline: { type: "string" },
    candidate: { type: "string", default: "src/agents/bundle-mcp-config.ts" },
    fixture: { type: "string" },
    iterations: { type: "string", default: "1000" },
  },
});
assert(values.baseline && values.fixture && global.gc);
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const dataDir = path.resolve(values.fixture, "plugin-data", "probe");
await fsp.mkdir(dataDir, { recursive: true });
const params = {
  config: { mcpServers: { probe: { command: "node" } } },
  prepareDataDirsByServer: { probe: { pluginId: "probe", dataDir } },
};
const base = (await import(pathToFileURL(path.resolve(values.baseline))))
  .prepareOwnedBundleMcpDataDirs;
const candidate = (await import(pathToFileURL(path.resolve(values.candidate))))
  .prepareOwnedBundleMcpDataDirs;
const originalSync = fs.mkdirSync;
const originalAsync = fsp.mkdir;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
let sample;
fs.mkdirSync = new Proxy(originalSync, {
  apply(method, receiver, args) {
    if (sample && String(args[0]) === dataDir) {
      sample.sync++;
      if (sample.inject) {
        Atomics.wait(sleeper, 0, 0, 100);
      }
    }
    return Reflect.apply(method, receiver, args);
  },
});
fsp.mkdir = new Proxy(originalAsync, {
  apply(method, receiver, args) {
    if (sample && String(args[0]) === dataDir) {
      sample.async++;
      if (sample.inject) {
        return delay(100).then(() => Reflect.apply(method, receiver, args));
      }
    }
    return Reflect.apply(method, receiver, args);
  },
});
const sum = (node) => node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
const p95 = (samples) => samples.toSorted((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1];
try {
  for (const mode of ["timing", "allocation", "delay"]) {
    for (let pass = 0; pass < 5; pass++) {
      for (const [label, run] of [
        ["A1", base],
        ["B", candidate],
        ["A2", base],
      ]) {
        for (let index = 0; index < 100; index++) {
          await run(params);
        }
        global.gc();
        await nextTurn();
        const inspector = new Session();
        if (mode === "allocation") {
          inspector.connect();
          await inspector.post("HeapProfiler.startSampling", {
            samplingInterval: 1024,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
        }
        const count = mode === "delay" ? 1 : iterations;
        sample = { sync: 0, async: 0, inject: mode === "delay" };
        const hostLoad = loadavg();
        const thread = process.threadCpuUsage();
        const cpu = process.cpuUsage();
        const start = performance.now();
        const timer = mode === "delay" ? delay(0).then(() => performance.now() - start) : undefined;
        const latencies = [];
        for (let index = 0; index < count; index++) {
          const began = performance.now();
          const result = await run(params);
          latencies.push(performance.now() - began);
          assert.equal(result.diagnostics.length, 0);
          assert.equal(result.config.mcpServers.probe.command, "node");
        }
        const elapsedMs = performance.now() - start;
        const main = process.threadCpuUsage(thread);
        const total = process.cpuUsage(cpu);
        const counts = sample;
        sample = undefined;
        const allocation =
          mode === "allocation"
            ? sum((await inspector.post("HeapProfiler.stopSampling")).profile.head) / count
            : undefined;
        if (mode === "allocation") {
          inspector.disconnect();
        }
        console.log(
          JSON.stringify({
            mode,
            pass,
            label,
            count,
            hostLoad,
            meanMs: elapsedMs / count,
            p95Ms: p95(latencies),
            mainCpuUs: (main.user + main.system) / count,
            totalCpuUs: (total.user + total.system) / count,
            allocatedBytes: allocation,
            syncMkdir: counts.sync,
            asyncMkdir: counts.async,
            timerMs: await timer,
          }),
        );
      }
    }
  }
} finally {
  fs.mkdirSync = originalSync;
  fsp.mkdir = originalAsync;
}
