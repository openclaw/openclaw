import { execFileSync, spawn } from "node:child_process";
import fs, { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  ProcessInspectionError,
  readCodexAppServerProcessCommand,
} from "../transport-process-snapshot.ts";
import { installProcfsFixture } from "./transport-process-fixture.test-support.mjs";

const scratch = mkdtempSync(path.join(os.tmpdir(), "codex-blocked-command-"));
const fifo = path.join(scratch, "cmdline");
const marker = path.join(scratch, "ambient-preload");
const preload = path.join(scratch, "preload.cjs");
writeFileSync(preload, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "loaded");`);
execFileSync("mkfifo", [fifo]);
const controllerCode = `const fs = require("node:fs");
const fd = fs.openSync(process.argv[1], "r+");
process.stdout.write("ready");
setTimeout(() => { fs.writeSync(fd, Buffer.from("codex\\0app-server\\0")); fs.closeSync(fd); }, 2500);`;
const controller = spawn(process.execPath, ["-e", controllerCode, fifo], {
  env: {},
  stdio: ["ignore", "pipe", "inherit"],
});
const controllerClosed = new Promise((resolve) => {
  controller.once("close", resolve);
});
try {
  await new Promise((resolve, reject) => {
    controller.once("error", reject);
    controller.stdout.once("data", resolve);
  });
  const commandPath = `/proc/${process.pid}/cmdline`;
  const originalOpen = fsPromises.open;
  const result = { descriptorClosed: false, inspectionSpawns: 0 };
  let closed;
  const descriptorClosed = new Promise((resolve) => {
    closed = resolve;
  });
  // A FIFO models a procfs kernel wait without blocking the Gateway's event loop.
  installProcfsFixture({
    open: async (file, ...args) => {
      if (file !== commandPath) {
        return originalOpen(file, ...args);
      }
      const handle = await originalOpen(fifo, "r");
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        result.descriptorClosed = true;
        closed();
      };
      return handle;
    },
    onSpawn: () => {
      result.inspectionSpawns += 1;
    },
  });
  process.env.NODE_OPTIONS = `--require=${preload}`;
  process.env.BUN_OPTIONS = `--preload=${preload}`;
  const started = performance.now();
  const heartbeat = delay(100).then(() => performance.now() - started);
  try {
    await readCodexAppServerProcessCommand(
      { pid: process.pid, ppid: process.ppid, pgid: process.pid, state: "S", startedAt: "fixture" },
      performance.now() + 1000,
    );
    result.outcome = { status: "fulfilled" };
  } catch (error) {
    if (!(error instanceof ProcessInspectionError)) {
      throw error;
    }
    result.outcome = { status: "rejected", reason: error.reason };
  }
  result.inspectionMs = performance.now() - started;
  [result.firstHeartbeatMs] = await Promise.all([heartbeat, controllerClosed, descriptorClosed]);
  result.ambientPreloadExecuted = fs.existsSync(marker);
  console.log(JSON.stringify(result));
} finally {
  controller.kill("SIGKILL");
  await controllerClosed;
  rmSync(scratch, { recursive: true, force: true });
}
