/**
 * launchd runs this standalone CommonJS program as each durable job. launchd keeps a job's
 * last exit status, but only `launchctl print` (documented as "NOT API") exposes the whole
 * outcome, so the wrapper records its own: the process group at start, then the command's
 * exit after that group is empty. It also owns the timeout because launchd has no lifetime
 * bound. Signal names, not numbers, are recorded; Node reports exits that way.
 *
 * The spec file carries argv and environment values (credentials included); the wrapper
 * removes it before starting the command. Keep this dependency-free: it runs from a
 * content-addressed copy that must outlive OpenClaw updates.
 */
export const DURABLE_LAUNCHD_WRAPPER_SOURCE = String.raw`"use strict";
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const specPath = process.argv[2];
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
fs.unlinkSync(specPath);
const startedAt = Date.now();
const save = (value) => {
  const temp = spec.statusPath + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temp, spec.statusPath);
};
let pgid, exit, timedOut = false, finished = false, killTimer;
const finish = (result) => {
  if (finished) return;
  finished = true;
  save({ phase: "exited", ...result, durationMs: Date.now() - startedAt });
  process.exit(0);
};
// EPERM proves a process still holds the group; only ESRCH proves it empty.
const groupAlive = () => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
};
const signalGroup = (signal) => {
  try {
    process.kill(-pgid, signal);
  } catch {}
};
const stop = () => {
  if (pgid === undefined) return;
  signalGroup("SIGTERM");
  killTimer ??= setTimeout(() => signalGroup("SIGKILL"), spec.killGraceMs);
};
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, stop);
const drain = () => {
  if (groupAlive()) {
    setTimeout(drain, 200);
    return;
  }
  finish({
    exitCode: exit.code,
    exitSignal: exit.signal,
    reason: timedOut ? "overall-timeout" : exit.signal ? "signal" : "exit",
  });
};
const failStart = (error) => {
  try {
    fs.appendFileSync(spec.logPath, "Durable process failed to start: " + error.message + "\n");
  } catch {}
  finish({ exitCode: null, exitSignal: null, reason: "spawn-error" });
};
let child;
try {
  const log = fs.openSync(spec.logPath, "a");
  try {
    child = spawn(spec.argv[0], spec.argv.slice(1), {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ["ignore", log, log],
      detached: true,
    });
  } finally {
    fs.closeSync(log);
  }
} catch (error) {
  failStart(error);
}
child.once("error", (error) => {
  if (pgid === undefined) failStart(error);
});
if (child.pid !== undefined) {
  pgid = child.pid;
  // Accepted edge case: if this write fails (disk full), the wrapper dies and the command
  // runs on unsupervised; the Gateway reports its outcome as unknown.
  save({ phase: "running", pgid, startedAt });
  child.once("exit", (code, signal) => {
    exit = { code, signal };
    drain();
  });
  if (spec.timeoutMs > 0) {
    setTimeout(() => {
      timedOut = true;
      stop();
    }, spec.timeoutMs);
  }
}
`;
