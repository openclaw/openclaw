import fs from "node:fs";
import path from "node:path";
import { findLauncherTokens, nodeLaunchers } from "./sentinel.mjs";

const launchers = new Set(nodeLaunchers);
const shells = new Set(["sh", "bash", "dash"]);

/** @param {string[]} cmd */
function isNodeShaped(cmd) {
  const executable = cmd[0];
  if (typeof executable !== "string") {
    return false;
  }
  const name = path.basename(executable);
  if (launchers.has(name)) {
    return true;
  }
  // Shell traces only attribute stacks; any argument may hold the script (`bash -c -e 'cmd'`).
  return shells.has(name) && cmd.slice(1).some((arg) => findLauncherTokens(arg).length > 0);
}

function captureStack() {
  const previousLimit = Error.stackTraceLimit;
  try {
    Error.stackTraceLimit = 26;
    return (new Error().stack ?? "")
      .split("\n")
      .slice(2, 27)
      .map((frame) => frame.trim());
  } finally {
    Error.stackTraceLimit = previousLimit;
  }
}

// Bun's node:child_process implementation resolves these functions at call time.
for (const name of ["spawn", "spawnSync"]) {
  const original = Bun[name];
  Bun[name] = function (...args) {
    let record;
    let tracePath;
    try {
      tracePath = process.env.OPENCLAW_BUN_ONLY_SPAWN_TRACE;
      const arrayForm = Array.isArray(args[0]);
      const cmd = arrayForm ? args[0] : args[0]?.cmd;
      const options = arrayForm ? args[1] : args[0];
      if (tracePath && Array.isArray(cmd) && isNodeShaped(cmd)) {
        record = {
          v: 1,
          pid: process.pid,
          ppid: process.ppid,
          ts: Date.now(),
          cmd: [...cmd],
          cwd: options?.cwd == null ? process.cwd() : String(options.cwd),
          stack: captureStack(),
        };
      }
    } catch {
      // Evidence collection must preserve the spawn's original result or error.
    }
    let child;
    try {
      child = Reflect.apply(original, this, args);
    } catch (error) {
      try {
        if (record) {
          record.childPid = null;
          record.errorCode = error?.code ?? null;
          fs.appendFileSync(tracePath, `${JSON.stringify(record)}\n`);
        }
      } catch {
        // Keep the original spawn error even if recording it fails.
      }
      throw error;
    }
    try {
      if (record) {
        record.childPid = child.pid;
        fs.appendFileSync(tracePath, `${JSON.stringify(record)}\n`);
      }
    } catch {
      // Evidence collection must not change the returned child.
    }
    return child;
  };
}
