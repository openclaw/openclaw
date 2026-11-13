#!/usr/bin/env node
// OpenClaw runtime launcher. `openclaw update` copies this file once to
// <state>/runtime/launcher.mjs and never rewrites it; the service runs that copy.
// It starts the runtime slot that slots.json selects. While a new slot is on
// trial, each Gateway start spends one attempt. When none are left, it returns
// to the previous slot. Keep it dependency-free: it must outlive every slot.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RUNTIME_SLOT_ENV = "OPENCLAW_RUNTIME_SLOT";
// Set while the started slot is on trial: its config errors must not park the service.
export const RUNTIME_TRIAL_ENV = "OPENCLAW_RUNTIME_TRIAL";
export const RUNTIME_POINTER_FILE = "slots.json";
const FILE_MODE = 0o644;

/** Returns null when the directory has no slot layout. */
export function readRuntimePointer(dir) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir, RUNTIME_POINTER_FILE), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const pointer = JSON.parse(raw);
  if (typeof pointer?.current !== "string" || typeof pointer.origin !== "string") {
    throw new Error(`invalid runtime pointer in ${dir}`);
  }
  return pointer;
}

/** rename(2) replaces the pointer atomically; the mode does not depend on the umask. */
export function writeRuntimePointer(dir, pointer) {
  const file = path.join(dir, RUNTIME_POINTER_FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temporary, "w", FILE_MODE);
  try {
    fs.fchmodSync(fd, FILE_MODE);
    fs.writeSync(fd, `${JSON.stringify(pointer)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
}

export const runtimeEntry = (root) => path.join(root, "openclaw.mjs");
const usable = (root) => typeof root === "string" && fs.existsSync(runtimeEntry(root));

/** A Gateway start spends one trial attempt; a CLI call only reads the pointer. */
export function selectRuntimeRoot(dir, { start }) {
  const pointer = readRuntimePointer(dir);
  if (!pointer) {
    throw new Error(`no runtime pointer in ${dir}`);
  }
  const fallback = usable(pointer.previous) ? pointer.previous : pointer.origin;
  const onTrial = typeof pointer.trial === "number";
  if (!usable(pointer.current) || (start && onTrial && pointer.trial <= 0)) {
    console.error(`openclaw launcher: ${pointer.current} did not start; returning to ${fallback}`);
    writeRuntimePointer(dir, {
      current: fallback,
      previous: pointer.current,
      origin: pointer.origin,
      failed: pointer.current,
    });
    return { root: fallback, trial: false };
  }
  if (start && onTrial) {
    writeRuntimePointer(dir, { ...pointer, trial: pointer.trial - 1 });
  }
  return { root: pointer.current, trial: start && onTrial };
}

export function launchRuntime(dir, argv, { start }) {
  const { root, trial } = selectRuntimeRoot(dir, { start });
  const env = { ...process.env, [RUNTIME_SLOT_ENV]: root };
  delete env[RUNTIME_TRIAL_ENV];
  if (trial) {
    env[RUNTIME_TRIAL_ENV] = "1";
  }
  const args = [...process.execArgv, runtimeEntry(root), ...argv];
  if (process.platform !== "win32" && typeof process.execve === "function") {
    // Keep the supervisor's PID: the slot replaces this process.
    process.execve(process.execPath, [process.execPath, ...args], env);
  }
  const child = spawn(process.execPath, args, { env, stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  return child;
}

if (import.meta.main) {
  try {
    launchRuntime(path.dirname(fileURLToPath(import.meta.url)), process.argv.slice(2), {
      start: true,
    });
  } catch (error) {
    console.error(`openclaw launcher: ${error instanceof Error ? error.message : String(error)}`);
    // Not 78: systemd must keep retrying a launcher that cannot read its pointer yet.
    process.exitCode = 1;
  }
}
