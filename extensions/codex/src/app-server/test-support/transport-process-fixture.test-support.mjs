import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

export function installProcfsFixture(openSync, injected, onInspector) {
  fs.openSync = openSync;
  const execFile = childProcess.execFile;
  childProcess.execFile = (file, args, ...rest) => {
    const evalIndex = args.indexOf("-e");
    if (file !== process.execPath || evalIndex < 0) {
      return execFile(file, args, ...rest);
    }
    const injectedArgs = args.slice();
    injectedArgs[evalIndex + 1] = injected + injectedArgs[evalIndex + 1];
    const inspector = execFile(file, injectedArgs, ...rest);
    onInspector?.(inspector);
    return inspector;
  };
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  syncBuiltinESMExports();
}
