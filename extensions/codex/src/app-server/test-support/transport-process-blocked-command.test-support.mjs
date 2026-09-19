import childProcess, { execFileSync, spawn } from "node:child_process";
import fs, { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import {
  ProcessInspectionError,
  readCodexAppServerProcessCommand,
} from "../transport-process-snapshot.ts";

const scratch = mkdtempSync(path.join(os.tmpdir(), "codex-blocked-command-"));
const fifo = path.join(scratch, "cmdline");
const marker = path.join(scratch, "ambient-preload");
const preload = path.join(scratch, "preload.cjs");
writeFileSync(preload, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "loaded");`);
execFileSync("mkfifo", [fifo]);
const controller = spawn(
  process.execPath,
  [
    "-e",
    `const fs = require("node:fs");
const fd = fs.openSync(process.argv[1], "r+");
process.stdout.write("ready");
setTimeout(() => { fs.writeSync(fd, Buffer.from("codex\\0app-server\\0")); fs.closeSync(fd); }, 2500);`,
    fifo,
  ],
  { env: {}, stdio: ["ignore", "pipe", "inherit"] },
);
const controllerClosed = new Promise((resolve) => {
  controller.once("close", resolve);
});
try {
  await new Promise((resolve, reject) => {
    controller.once("error", reject);
    controller.stdout.once("data", resolve);
  });
  const commandPath = `/proc/${process.pid}/cmdline`;
  const originalOpen = fs.openSync;
  const originalExecFile = childProcess.execFile;
  let inspectorClosed = false;
  let inspectorUsed = false;
  // A blocking FIFO models cmdline's kernel waits; the controller runs independently.
  fs.openSync = (file, ...args) =>
    file === commandPath ? originalOpen(fifo, "r") : originalOpen(file, ...args);
  childProcess.execFile = (file, args, ...rest) => {
    const evalIndex = args.indexOf("-e");
    if (file === process.execPath && evalIndex >= 0) {
      const injected = `const fixtureFs = require("node:fs");
const fixtureOpen = fixtureFs.openSync;
fixtureFs.openSync = (file, ...args) => file === ${JSON.stringify(commandPath)}
  ? fixtureOpen(${JSON.stringify(fifo)}, "r") : fixtureOpen(file, ...args);
`;
      const injectedArgs = args.slice();
      injectedArgs[evalIndex + 1] = injected + injectedArgs[evalIndex + 1];
      const inspector = originalExecFile(file, injectedArgs, ...rest);
      inspectorUsed = true;
      inspector.once("close", () => {
        inspectorClosed = true;
      });
      return inspector;
    }
    return originalExecFile(file, args, ...rest);
  };
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  syncBuiltinESMExports();
  process.env.NODE_OPTIONS = `--require=${preload}`;
  process.env.BUN_OPTIONS = `--preload=${preload}`;
  const started = performance.now();
  let firstHeartbeatMs;
  const heartbeat = new Promise((resolve) => {
    setTimeout(() => {
      firstHeartbeatMs = performance.now() - started;
      resolve();
    }, 100);
  });
  let outcome;
  try {
    await readCodexAppServerProcessCommand(
      { pid: process.pid, ppid: process.ppid, pgid: process.pid, state: "S", startedAt: "fixture" },
      Date.now() + 1000,
    );
    outcome = { status: "fulfilled" };
  } catch (error) {
    if (!(error instanceof ProcessInspectionError)) {
      throw error;
    }
    outcome = { status: "rejected", reason: error.reason };
  }
  const inspectionMs = performance.now() - started;
  await Promise.all([heartbeat, controllerClosed]);
  console.log(
    JSON.stringify({
      outcome,
      firstHeartbeatMs,
      inspectionMs,
      inspectorUsed,
      inspectorClosed,
      ambientPreloadExecuted: fs.existsSync(marker),
    }),
  );
} finally {
  controller.kill("SIGKILL");
  await controllerClosed;
  rmSync(scratch, { recursive: true, force: true });
}
