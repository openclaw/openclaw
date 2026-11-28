import childProcess from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

export function installProcfsFixture({ open, readdir, readFile, onSpawn }) {
  if (open) {
    fs.open = open;
  }
  if (readFile) {
    fs.readFile = readFile;
  }
  if (readdir) {
    fs.readdir = readdir;
  }
  for (const name of ["execFile", "spawn"]) {
    const original = childProcess[name];
    childProcess[name] = (...args) => {
      onSpawn?.();
      return original(...args);
    };
  }
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  syncBuiltinESMExports();
}
