import { readdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";
import { GCProfiler, getHeapStatistics, setFlagsFromString } from "node:v8";
import vm from "node:vm";

// The shared thread-watchdog fixture also runs on Bun; only the native-GC probe needs V8 GC.
let collectGarbage: () => void = () => {
  // Inject GC pressure that V8 does not retire first; native OOM uses the normal worker.
  setFlagsFromString("--expose_gc --no-detect-ineffective-gcs-near-heap-limit");
  // Cheap major collections must retire a near-limit worker regardless of GC time share.
  // oxlint-disable-next-line typescript/unbound-method -- The replacement binds the original with call(this).
  const stop = GCProfiler.prototype.stop;
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

// Sample while the VM is executing: completed watchdog threads disappear from /proc.
vm.Script = class extends vm.Script {
  override runInContext(...args: Parameters<vm.Script["runInContext"]>) {
    const before = new Set(process.platform === "linux" ? readdirSync("/proc/self/task") : []);
    args[0].heapStatistics = getHeapStatistics;
    args[0].collectGarbage = collectGarbage;
    args[0].watchdogThreads = () => readdirSync("/proc/self/task").filter((id) => !before.has(id));
    return super.runInContext(...args);
  }
};
syncBuiltinESMExports();
await import("./code-mode-node.worker.js");
