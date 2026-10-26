import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
const mapped = new Map();
if (fixtureProcfs) {
  for (const [file, data] of Object.entries({
    "/proc/sys/kernel/random/boot_id": "00000000-0000-0000-0000-000000000001",
    [`/proc/${process.pid}/stat`]: `${process.pid} (proof) S ${process.ppid} ${process.pid}${" 0".repeat(14)} 1 0 12345\n`,
    [`/proc/${process.pid}/cmdline`]: "procfs-proof\0",
  })) {
    const target = path.join(scratch, String(mapped.size));
    fs.writeFileSync(target, data);
    mapped.set(file, target);
  }
}
const originalOpen = fsPromises.open;
const originalReaddir = fsPromises.readdir;
let inspectionSpawns = 0;
installProcfsFixture({
  open: (file, ...args) => originalOpen(mapped.get(file) ?? file, ...args),
  readdir: (file, options) =>
    fixtureProcfs && file === "/proc"
      ? Promise.resolve([String(process.pid)])
      : originalReaddir(file, {
          ...(typeof options === "string" ? { encoding: options } : options),
          // Procfs observations enumerate one directory, never a recursive inventory.
          recursive: false,
        }),
  onSpawn: () => {
    inspectionSpawns += 1;
  },
});
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
  // Async inspection shares libuv: starvation fails at its deadline, then recovers.
  const held = promisify(fs.read)(fd, Buffer.alloc(1), 0, 1, null);
  let workerReleased = false;
  const releaseWorker = () => {
    if (!workerReleased) {
      fs.writeSync(fd, Buffer.from("x"));
      workerReleased = true;
    }
  };
  const inspect = (deadline) =>
    Promise.allSettled([
      readCodexAppServerProcessSnapshot(deadline, [process.pid]),
      readCodexAppServerProcessCommand(own, deadline),
      readCodexAppServerProcessSnapshot(deadline),
    ]);
  const summarize = (outcomes) =>
    outcomes.map((outcome, index) => ({
      operation: ["selected-identity", "selected-command", "full-snapshot"][index],
      status: outcome.status,
      ...(outcome.status === "rejected"
        ? { name: outcome.reason?.name, reason: outcome.reason?.reason }
        : index === 1
          ? { commandBytes: Buffer.byteLength(outcome.value) }
          : { observerPresent: outcome.value.some((row) => row.pid === process.pid) }),
    }));
  const inspectionDeadlineMs = 1_000;
  const started = performance.now();
  const heartbeat = delay(100).then(() => performance.now() - started);
  release = setTimeout(releaseWorker, 5_000);
  const outcomes = await inspect(started + inspectionDeadlineMs);
  const inspectionMs = performance.now() - started;
  const filesystemWorkerHeldAtInspection = !workerReleased;
  clearTimeout(release);
  releaseWorker();
  await held;
  const recovered = await inspect(performance.now() + 10_000);
  console.log(
    JSON.stringify({
      inspectionDeadlineMs,
      inspectionMs,
      firstHeartbeatMs: await heartbeat,
      filesystemWorkerHeldAtInspection,
      inspectionSpawns,
      outcomes: summarize(outcomes),
      recovered: summarize(recovered),
    }),
  );
} finally {
  clearTimeout(release);
  fs.closeSync(fd);
  fs.rmSync(scratch, { recursive: true, force: true });
}
