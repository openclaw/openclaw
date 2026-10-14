import { readdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { getHeapStatistics, setFlagsFromString } from "node:v8";
import vm from "node:vm";

// The shared thread-watchdog fixture also runs on Bun; only the native-GC probe needs V8 GC.
let collectGarbage: () => void = () => {
  setFlagsFromString("--expose_gc");
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
