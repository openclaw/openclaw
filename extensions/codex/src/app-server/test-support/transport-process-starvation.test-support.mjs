import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  readCodexAppServerProcessCommand,
  readCodexAppServerProcessSnapshot,
} from "../transport-process-snapshot.ts";
import { installProcfsFixture } from "./transport-process-fixture.test-support.mjs";

const fixtureProcfs = process.argv.includes("--fixture-procfs");
if ((!fixtureProcfs && process.platform !== "linux") || process.env.UV_THREADPOOL_SIZE !== "1") {
  throw new Error("This probe requires Linux (or --fixture-procfs) and UV_THREADPOOL_SIZE=1.");
}
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "codex-procfs-queue-"));
if (fixtureProcfs) {
  const mapped = new Map(
    Object.entries({
      "/proc/sys/kernel/random/boot_id": "00000000-0000-0000-0000-000000000001",
      [`/proc/${process.pid}/stat`]: `${process.pid} (proof) S ${process.ppid} ${process.pid}${" 0".repeat(14)} 1 0 12345\n`,
      [`/proc/${process.pid}/cmdline`]: "procfs-proof\0",
    }).map(([key, value], index) => {
      const target = path.join(scratch, String(index));
      fs.writeFileSync(target, value);
      return [key, target];
    }),
  );
  const originalOpenSync = fs.openSync;
  installProcfsFixture(
    (file, ...args) => originalOpenSync(mapped.get(file) ?? file, ...args),
    `const fixtureFs = require("node:fs");
const fixtureOpen = fixtureFs.openSync;
const fixtureFiles = new Map(${JSON.stringify([...mapped])});
fixtureFs.openSync = (file, ...args) => fixtureOpen(fixtureFiles.get(file) ?? file, ...args);
const fixtureReaddir = fixtureFs.readdirSync;
fixtureFs.readdirSync = (file, ...args) => file === "/proc"
  ? [${JSON.stringify(String(process.pid))}] : fixtureReaddir(file, ...args);
`,
  );
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
  const held = promisify(fs.read)(fd, Buffer.alloc(1), 0, 1, null);
  const filesystemWorkerReleaseDeadlineMs = 10_500;
  let workerReleased = false;
  const releaseWorker = () => {
    if (workerReleased) {
      return;
    }
    fs.writeSync(fd, Buffer.from("x"));
    workerReleased = true;
  };
  const deadline = performance.now() + 10_000;
  release = setTimeout(releaseWorker, filesystemWorkerReleaseDeadlineMs);
  const outcomes = await Promise.allSettled([
    readCodexAppServerProcessSnapshot(deadline, [process.pid]),
    readCodexAppServerProcessCommand(own, deadline),
    readCodexAppServerProcessSnapshot(deadline),
  ]);
  const filesystemWorkerHeldAtInspection = !workerReleased;
  clearTimeout(release);
  releaseWorker();
  await held;
  const result = {
    startupDeadlineMs: 10_000,
    filesystemWorkerReleaseDeadlineMs,
    filesystemWorkerHeldAtInspection,
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
