// Bundle LiveState with esbuild, then run this with Node --expose-gc.
// --module <live-state.mjs> --root <new fixture directory> [--files 62000]
// [--pairs 5] [--output <artifact prefix>]. CPU includes start/change/stop;
// ownerCpu and elapsed cover only start(). Allocation sampling runs separately.
// Measures the unchanged watcher owner on main vs an already-running worker.
// Worker bootstrap/storage imports are deliberately excluded: production reuses
// its existing storage worker. The service regression proves that wiring.
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

const { values } = parseArgs({
  options: {
    module: { type: "string" },
    root: { type: "string" },
    files: { type: "string", default: "62000" },
    pairs: { type: "string", default: "5" },
    output: { type: "string" },
  },
});
const moduleUrl = isMainThread
  ? pathToFileURL(path.resolve(values.module)).href
  : workerData.moduleUrl;
const { LiveState } = await import(moduleUrl);
let nativeWatches = 0;
const watch = fs.watch;
fs.watch = function (filename, options, listener) {
  if (!options?.recursive || process.platform === "darwin" || process.platform === "win32") {
    nativeWatches++;
  }
  return watch.call(this, filename, options, listener);
};
syncBuiltinESMExports();
const cpuMs = (cpu) => (cpu.user + cpu.system) / 1000;
const sum = (node) => node.selfSize + node.children.reduce((n, child) => n + sum(child), 0);
const inspector = new Session();
inspector.connect();
async function sample(root, allocation = false, profile = false) {
  global.gc();
  if (allocation) {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  if (profile) {
    await inspector.post("Profiler.enable");
    await inspector.post("Profiler.start");
  }
  let observed;
  const event = new Promise((resolve) => {
    observed = resolve;
  });
  const live = new LiveState(root, observed);
  nativeWatches = 0;
  const cpu = process.threadCpuUsage();
  const time = performance.now();
  live.start();
  const elapsed = performance.now() - time;
  const ownerCpu = cpuMs(process.threadCpuUsage(cpu));
  assert.equal(live.state, "watching");
  const registrations = nativeWatches;
  const allocated = allocation
    ? sum((await inspector.post("HeapProfiler.stopSampling")).profile.head)
    : null;
  const cpuProfile = profile ? (await inspector.post("Profiler.stop")).profile : undefined;
  // Edit a pre-existing nested file and wait for the actual production debounce.
  fs.appendFileSync(path.join(root, "private/artifacts/source-0/original.txt"), "changed\n");
  const timeout = setTimeout(() => {
    throw new Error("Change was not observed");
  }, 5000);
  await event;
  clearTimeout(timeout);
  live.stop();
  await immediate();
  return { elapsed, ownerCpu, registrations, allocated, cpuProfile };
}
if (!isMainThread) {
  parentPort.on("message", (input) => {
    void sample(input.root, input.allocation, input.profile).then((result) =>
      parentPort.postMessage(result, []),
    );
  });
  parentPort.postMessage("ready", []);
} else {
  assert(values.root, "--root is required and must not exist");
  const root = path.resolve(values.root),
    count = Number(values.files);
  fs.mkdirSync(root);
  const directories = Math.floor(count / 4);
  fs.mkdirSync(path.join(root, "private/artifacts"), { recursive: true });
  fs.mkdirSync(path.join(root, "private/claims"));
  fs.mkdirSync(path.join(root, "private/projects"));
  fs.writeFileSync(path.join(root, "vault.json"), "{}");
  const contents = Buffer.alloc(18000, 120);
  for (let i = 0; i < directories; i++) {
    const directory = path.join(root, "private/artifacts", `source-${i}`);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "original.txt"), contents);
  }
  for (let i = directories; i < count; i++) {
    fs.writeFileSync(
      path.join(root, "private", i % 2 ? "claims" : "projects", `${i}.md`),
      contents,
    );
  }
  const worker = new Worker(new URL(import.meta.url), { workerData: { moduleUrl } });
  await once(worker, "message");
  const report = {
    node: process.version,
    platform: process.platform,
    cpus: os.availableParallelism(),
    load: os.loadavg(),
    files: count,
    bytes: count * contents.length,
    directories: directories + 5,
    samples: [],
  };
  async function run(arm, group, allocation = false, profile = false) {
    // This sampling pass measures the caller separately from the owner's heap.
    global.gc();
    if (allocation && arm === "B") {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 32768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    nativeWatches = 0;
    const cpu = process.threadCpuUsage(),
      total = process.cpuUsage(),
      time = performance.now();
    let syncMs, result;
    if (arm === "A") {
      const pending = sample(root, allocation, profile);
      syncMs = performance.now() - time;
      result = await pending;
    } else {
      const response = once(worker, "message");
      worker.postMessage({ root, allocation, profile }, []);
      syncMs = performance.now() - time;
      [result] = await response;
    }
    const mainCpu = cpuMs(process.threadCpuUsage(cpu)),
      totalCpu = cpuMs(process.cpuUsage(total));
    const mainAllocated = allocation
      ? arm === "A"
        ? result.allocated
        : sum((await inspector.post("HeapProfiler.stopSampling")).profile.head)
      : null;
    if (result.cpuProfile) {
      fs.writeFileSync(
        `${values.output ?? root}-${arm}.cpuprofile`,
        JSON.stringify(result.cpuProfile),
      );
      delete result.cpuProfile;
    }
    const row = {
      arm,
      group,
      allocation,
      syncMs,
      mainStartMs: arm === "A" ? result.elapsed : syncMs,
      mainWatchers: nativeWatches,
      mainCpu,
      totalCpu,
      mainAllocated,
      ...result,
    };
    report.samples.push(row);
    console.log(JSON.stringify(row));
  }
  try {
    await run("A", "warmup");
    await run("B", "warmup");
    for (const allocation of [false, true]) {
      for (let i = 0; i < Number(values.pairs); i++) {
        for (const arm of ["A", "B", "B", "A"]) {
          await run(arm, `ABBA-${i}`, allocation);
        }
      }
      for (let i = 0; i < Number(values.pairs); i++) {
        for (const arm of ["A", "A"]) {
          await run(arm, `AA-${i}`, allocation);
        }
      }
    }
    await run("A", "profile", false, true);
    await run("B", "profile", false, true);
    console.log(JSON.stringify({ report }));
  } finally {
    await worker.terminate();
    inspector.disconnect();
    fs.rmSync(root, { recursive: true });
  }
}
