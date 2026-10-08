import { readFileSync, readdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import vm from "node:vm";
import { hasErrnoCode } from "../infra/errno.js";

// Sample while the VM is executing: completed watchdog threads disappear from /proc.
vm.Script = class extends vm.Script {
  override runInContext(...args: Parameters<vm.Script["runInContext"]>) {
    const before = new Set(readdirSync("/proc/self/task"));
    args[0].watchdogThreads = () =>
      readdirSync("/proc/self/task")
        .filter((id) => !before.has(id))
        .map((id) => {
          // The process also owns runtime and test-runner threads; identify an unexpected thread.
          const details = (file: string) => {
            try {
              return readFileSync(`/proc/self/task/${id}/${file}`, "utf8").trim();
            } catch (error) {
              if (hasErrnoCode(error, "ENOENT")) {
                return "exited";
              }
              throw error;
            }
          };
          return { id, name: details("comm"), waitChannel: details("wchan") };
        });
    return super.runInContext(...args);
  }
};
syncBuiltinESMExports();
await import("./code-mode-node.worker.js");
