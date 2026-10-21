import childProcess, { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  readCodexAppServerProcessCommand,
  readCodexAppServerProcessSnapshot,
} from "../transport-process-snapshot.ts";

const actualPlatform = process.platform;
const fixtureProcfs = process.argv.includes("--fixture-procfs");
if ((!fixtureProcfs && actualPlatform !== "linux") || process.env.UV_THREADPOOL_SIZE !== "1") {
  throw new Error("This probe requires Linux (or --fixture-procfs) and UV_THREADPOOL_SIZE=1.");
}
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "codex-procfs-queue-"));
if (fixtureProcfs) {
  const mapped = new Map(
    [
      ["/proc/sys/kernel/random/boot_id", "00000000-0000-0000-0000-000000000001"],
      [
        `/proc/${process.pid}/stat`,
        `${process.pid} (proof) S ${process.ppid} ${process.pid}${" 0".repeat(14)} 1 0 12345\n`,
      ],
      [`/proc/${process.pid}/cmdline`, "procfs-proof\0"],
    ].map(([key, value], index) => {
      const target = path.join(scratch, String(index));
      fs.writeFileSync(target, value);
      return [key, target];
    }),
  );
  const originalReadFileSync = fs.readFileSync;
  const originalOpenSync = fs.openSync;
  fs.readFileSync = (file, ...args) => originalReadFileSync(mapped.get(file) ?? file, ...args);
  fs.openSync = (file, ...args) => originalOpenSync(mapped.get(file) ?? file, ...args);
  const originalExecFile = childProcess.execFile;
  childProcess.execFile = (file, args, ...rest) => {
    const evalIndex = args.indexOf("-e");
    if (file === process.execPath && evalIndex >= 0) {
      const injected = `const fixtureFs = require("node:fs");
const fixtureOpen = fixtureFs.openSync;
const fixtureFiles = new Map(${JSON.stringify([...mapped])});
fixtureFs.openSync = (file, ...args) => fixtureOpen(fixtureFiles.get(file) ?? file, ...args);
const fixtureReaddir = fixtureFs.readdirSync;
fixtureFs.readdirSync = (file, ...args) => file === "/proc"
  ? [${JSON.stringify(String(process.pid))}] : fixtureReaddir(file, ...args);
`;
      const injectedArgs = args.slice();
      injectedArgs[evalIndex + 1] = injected + injectedArgs[evalIndex + 1];
      return originalExecFile(file, injectedArgs, ...rest);
    }
    return originalExecFile(file, args, ...rest);
  };
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  syncBuiltinESMExports();
}
const own = (
  await readCodexAppServerProcessSnapshot(performance.now() + 10_000, [process.pid])
).find((row) => row.pid === process.pid);
if (!own) {
  throw new Error("The observer identity is unavailable.");
}
const fifo = path.join(scratch, "worker-blocker");
execFileSync("mkfifo", [fifo]);
const fd = fs.openSync(fifo, "r+");
let release;
try {
  // One blocking read occupies the isolated process's only filesystem worker.
  const heldAt = performance.now();
  const held = promisify(fs.read)(fd, Buffer.alloc(1), 0, 1, null);
  const filesystemWorkerReleaseDeadlineMs = 10_500;
  let blockedFilesystemWorkerMs;
  const releaseWorker = () => {
    if (blockedFilesystemWorkerMs !== undefined) {
      return;
    }
    fs.writeSync(fd, Buffer.from("x"));
    blockedFilesystemWorkerMs = performance.now() - heldAt;
  };
  const directStart = performance.now();
  fs.readFileSync(`/proc/${process.pid}/stat`);
  const directReadMs = performance.now() - directStart;
  const started = performance.now();
  const deadline = performance.now() + 10_000;
  let eventLoopDelayMs;
  const responsive = delay(100).then(() => {
    eventLoopDelayMs = performance.now() - started - 100;
  });
  release = setTimeout(releaseWorker, filesystemWorkerReleaseDeadlineMs);
  const outcomes = await Promise.allSettled([
    readCodexAppServerProcessSnapshot(deadline, [process.pid]),
    readCodexAppServerProcessCommand(own, deadline),
    readCodexAppServerProcessSnapshot(deadline),
  ]);
  const inspectionMs = performance.now() - started;
  const filesystemWorkerHeldAtInspection = blockedFilesystemWorkerMs === undefined;
  await responsive;
  clearTimeout(release);
  releaseWorker();
  await held;
  const result = {
    node: process.version,
    platform: actualPlatform,
    procfs: fixtureProcfs ? "fixture" : "kernel",
    sourceSha256: createHash("sha256")
      .update(fs.readFileSync(new URL("../transport-process-snapshot.ts", import.meta.url)))
      .digest("hex"),
    startupDeadlineMs: 10_000,
    filesystemWorkerReleaseDeadlineMs,
    blockedFilesystemWorkerMs,
    filesystemWorkerHeldAtInspection,
    directReadMs,
    eventLoopDelayMs,
    inspectionMs,
    outcomes: outcomes.map((outcome, index) => {
      const operation = ["selected-identity", "selected-command", "full-snapshot"][index];
      const detail =
        outcome.status === "rejected"
          ? { name: outcome.reason?.name, reason: outcome.reason?.reason }
          : index === 1
            ? { commandBytes: Buffer.byteLength(outcome.value) }
            : { observerPresent: outcome.value.some((row) => row.pid === process.pid) };
      return Object.assign({ operation, status: outcome.status }, detail);
    }),
  };
  console.log(JSON.stringify(result));
} finally {
  clearTimeout(release);
  fs.closeSync(fd);
  fs.rmSync(scratch, { recursive: true, force: true });
}
