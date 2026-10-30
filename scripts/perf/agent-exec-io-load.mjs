// Synthetic host-exec workload for team-shape-stress.ts --exec-io-storm.
// Invoked through the real model exec tool, never directly by the controller.
// Arguments: existing artifact directory (on the state filesystem), runner index, lifetime ms.
// Each writer owns at most 128 MiB and records cgroup/IO progress every ten seconds.
import { randomFillSync } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fdatasyncSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";

const [directory, runner, lifetime] = process.argv.slice(2);
const lifetimeMs = Number(lifetime);
if (
  process.platform !== "linux" ||
  !directory ||
  !path.isAbsolute(directory) ||
  !/^\d+$/u.test(runner ?? "") ||
  !Number.isSafeInteger(lifetimeMs) ||
  lifetimeMs <= 0
) {
  throw new Error("Expected Linux artifact directory, numeric runner, and positive lifetime ms");
}
const dataPath = path.join(directory, `agent-exec-io-${runner}.data`);
const evidencePath = path.join(directory, `agent-exec-io-${runner}.jsonl`);
const stopPath = path.join(directory, "agent-exec-io.stop");
const membership = readFileSync("/proc/self/cgroup", "utf8").trim();
const cgroup = membership
  .split("\n")
  .find((line) => line.startsWith("0::"))
  ?.slice(3);
if (!cgroup) {
  throw new Error("IO stress requires cgroup v2");
}
const cgroupPath = path.join("/sys/fs/cgroup", cgroup);
const readIo = (name) => {
  try {
    return readFileSync(path.join(cgroupPath, name), "utf8");
  } catch (error) {
    return { unavailable: error.code };
  }
};
const buffer = randomFillSync(Buffer.allocUnsafe(1024 * 1024));
const fd = openSync(dataPath, "wx+", 0o600);
let bytesWritten = 0;
let cycles = 0;
let stopping = false;
const startedAt = Date.now();
let lastReport = startedAt;
process.on("SIGTERM", () => (stopping = true));
process.on("SIGINT", () => (stopping = true));
function report(phase) {
  appendFileSync(
    evidencePath,
    JSON.stringify({
      phase,
      atEpochMs: Date.now(),
      pid: process.pid,
      bytesWritten,
      cycles,
      membership,
      ioStat: readIo("io.stat"),
      ioMax: readIo("io.max"),
    }) + "\n",
    { mode: 0o600 },
  );
}
try {
  report("started");
  while (Date.now() - startedAt < lifetimeMs && !existsSync(stopPath)) {
    if (stopping) {
      break;
    }
    // Bounded overwrite avoids consuming the VM disk; random bytes resist compression.
    for (let block = 0; block < 8; block++) {
      let written = 0;
      while (written < buffer.length) {
        written += writeSync(
          fd,
          buffer,
          written,
          buffer.length - written,
          (bytesWritten % (128 * 1024 * 1024)) + written,
        );
      }
      bytesWritten += written;
    }
    fdatasyncSync(fd);
    cycles++;
    if (Date.now() - lastReport >= 10_000) {
      report("progress");
      lastReport = Date.now();
    }
    await setImmediate();
  }
} finally {
  closeSync(fd);
  unlinkSync(dataPath);
  report("stopped");
}
