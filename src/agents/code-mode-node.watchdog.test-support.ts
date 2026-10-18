import { readdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import vm from "node:vm";

// Sample while the VM is executing: completed watchdog threads disappear from /proc.
vm.Script = class extends vm.Script {
  override runInContext(...args: Parameters<vm.Script["runInContext"]>) {
    const before = new Set(readdirSync("/proc/self/task"));
    args[0].watchdogThreads = () => readdirSync("/proc/self/task").filter((id) => !before.has(id));
    return super.runInContext(...args);
  }
};
syncBuiltinESMExports();
await import("./code-mode-node.worker.js");
