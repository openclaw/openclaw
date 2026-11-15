// Replay one synchronous ancestor recovery sweep through real registry subscriptions.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/agent-directory-recovery-measure.ts
//   --owner <bundled-registry.mjs> --state-dir <new-directory> [--allocations]
// Bundle each revision with esbuild --bundle --platform=node --format=esm --packages=external.
// Forty prepared agents, 100 warmup sweeps and 1,000 measured sweeps. This measures
// owner work, not native event frequency or whole-Gateway throughput.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    "state-dir": { type: "string" },
    allocations: { type: "boolean" },
  },
});
assert.ok(values.owner && values["state-dir"] && global.gc);
const stateDir = path.resolve(values["state-dir"]);
fs.mkdirSync(stateDir);
const registry: typeof import("../../src/agents/agent-dir-registry.js") = await import(
  pathToFileURL(path.resolve(values.owner)).href
);
const agents = Array.from({ length: 40 }, (_, index) => ({
  agentId: `agent-${index}`,
  agentDir: path.join(stateDir, "agents", `agent-${index}`, "agent"),
}));
for (const agent of agents) {
  fs.mkdirSync(agent.agentDir, { recursive: true });
}
const callbacks: fs.WatchListener<string>[] = [];
const originalWatch = fs.watch;
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const originalRealpath = fs.realpathSync.native;
let resolutions = 0;
fs.realpathSync.native = new Proxy(originalRealpath, {
  apply(target, thisArg, args) {
    resolutions++;
    return Reflect.apply(target, thisArg, args);
  },
});
class ReplayWatch extends EventEmitter implements fs.FSWatcher {
  close() {}
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}
const native: {
  watch(
    filename: fs.PathLike,
    options: fs.WatchOptionsWithStringEncoding,
    listener: fs.WatchListener<string>,
  ): fs.FSWatcher;
} = fs;
native.watch = (_filename, _options, listener) => {
  callbacks.push(listener);
  return new ReplayWatch();
};
try {
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  for (const agent of agents) {
    registry.registerResolvedAgentDir(agent);
  }
} finally {
  Object.defineProperty(process, "platform", platform);
  fs.watch = originalWatch;
}
const sweep = async () => {
  for (const callback of callbacks) {
    callback("change", null);
  }
  await Promise.resolve();
};
const inspector = new Session();
try {
  for (let index = 0; index < 100; index++) {
    await sweep();
  }
  global.gc();
  inspector.connect();
  if (values.allocations) {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  resolutions = 0;
  const iterations = 1000;
  const cpu = process.cpuUsage();
  const started = performance.now();
  for (let index = 0; index < iterations; index++) {
    await sweep();
  }
  const elapsedMs = performance.now() - started;
  const usedCpu = process.cpuUsage(cpu);
  let allocationBytes: number | undefined;
  if (values.allocations) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    allocationBytes = profile.samples.reduce((total, sample) => total + sample.size, 0);
  }
  for (const agent of agents) {
    assert.equal(registry.resolveRegisteredAgentIdForDir(agent.agentDir), agent.agentId);
  }
  console.log(
    JSON.stringify({
      iterations,
      agents: agents.length,
      callbacksPerSweep: callbacks.length,
      resolutions,
      cpuMs: (usedCpu.user + usedCpu.system) / 1000,
      elapsedMs,
      allocationBytes,
      hostLoad: os.loadavg(),
      node: process.version,
    }),
  );
} finally {
  inspector.disconnect();
  fs.realpathSync.native = originalRealpath;
  for (const agent of agents) {
    registry.unregisterResolvedAgentDir(agent);
  }
  fs.rmSync(stateDir, { recursive: true });
}
