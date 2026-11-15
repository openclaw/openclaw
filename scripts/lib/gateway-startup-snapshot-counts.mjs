import childProcess from "node:child_process";
// Native fs-safe copies bypass fs.copyFile. Count staging allocation and publication
// instead, before cleanup can erase the evidence. NODE_OPTIONS carries this into children.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { threadId } from "node:worker_threads";

const output = process.env.OPENCLAW_BENCH_SNAPSHOT_COUNTS;
if (output) {
  const append = fs.appendFileSync;
  append(output, `${JSON.stringify({ kind: "observer", pid: process.pid, threadId })}\n`);
  const record = (kind, pathname, bytes = 0) => {
    if (typeof pathname === "string" && pathname.includes("openclaw-sqlite-readonly-")) {
      append(output, `${JSON.stringify({ kind, pathname, bytes, pid: process.pid, threadId })}\n`);
    }
  };
  const allocated = fs.mkdtempSync;
  fs.mkdtempSync = function (...args) {
    const result = Reflect.apply(allocated, this, args);
    record("directory", result);
    return result;
  };
  const allocatedAsync = fs.promises.mkdtemp;
  fs.promises.mkdtemp = async function (...args) {
    const result = await Reflect.apply(allocatedAsync, this, args);
    record("directory", result);
    return result;
  };
  const renamed = fs.renameSync;
  fs.renameSync = function (source, target) {
    const result = Reflect.apply(renamed, this, [source, target]);
    if (typeof target === "string" && /database\.sqlite(?:-wal)?$/u.test(target)) {
      record("publication", target, fs.statSync(target).size);
    }
    return result;
  };
  // Service relays strip NODE_OPTIONS hooks. The synthetic observer must follow
  // their native children too, or an unobserved snapshot could look like zero work.
  for (const method of ["spawn", "spawnSync"]) {
    const spawn = childProcess[method];
    childProcess[method] = function (command, args, options) {
      const observedArgs =
        path.basename(command).replace(/\.exe$/u, "") === "node" && Array.isArray(args)
          ? ["--import", import.meta.filename, ...args]
          : args;
      return Reflect.apply(spawn, this, [command, observedArgs, options]);
    };
  }
  syncBuiltinESMExports();
}
