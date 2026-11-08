import { readdirSync } from "node:fs";
import { mock } from "node:test";
import { GCProfiler, getHeapStatistics, setFlagsFromString } from "node:v8";
import vm from "node:vm";

// The shared thread-watchdog fixture also runs on Bun; only the native-GC probe needs V8 GC.
let collectGarbage: () => void = () => {
  // Inject GC pressure that V8 does not retire first; native OOM uses the normal worker.
  setFlagsFromString("--expose_gc --no-detect-ineffective-gcs-near-heap-limit");
  // Cheap major collections must retire a near-limit worker regardless of GC time share.
  const profilerPrototype: {
    stop: (this: GCProfiler) => ReturnType<GCProfiler["stop"]>;
  } = GCProfiler.prototype;
  const stop = profilerPrototype.stop;
  mock.method(GCProfiler.prototype, "stop", function (this: GCProfiler) {
    const result = stop.call(this);
    for (const entry of result.statistics) {
      entry.cost = 0;
    }
    return result;
  });
  collectGarbage = vm.runInNewContext("gc");
  collectGarbage();
};

// Patch the shared prototype used by the worker's named Script import.
const scriptPrototype: {
  runInContext: (this: vm.Script, ...args: Parameters<vm.Script["runInContext"]>) => unknown;
} = vm.Script.prototype;
const runInContext = scriptPrototype.runInContext;
mock.method(vm.Script.prototype, "runInContext", function (this: vm.Script, ...args) {
  // Sample while the VM is executing: completed watchdog threads disappear from /proc.
  const before = new Set(process.platform === "linux" ? readdirSync("/proc/self/task") : []);
  args[0].heapStatistics = getHeapStatistics;
  args[0].collectGarbage = collectGarbage;
  args[0].watchdogThreads = () => readdirSync("/proc/self/task").filter((id) => !before.has(id));
  return runInContext.apply(this, args);
});
await import("./code-mode-node.worker.js");
