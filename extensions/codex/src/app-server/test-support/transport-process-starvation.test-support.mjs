import childProcess, { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs, {
  closeSync,
  mkdtempSync,
  openSync,
  read,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
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
const scratch = mkdtempSync(path.join(os.tmpdir(), "codex-procfs-queue-"));
if (fixtureProcfs) {
  const files = new Map([
    ["/proc/sys/kernel/random/boot_id", "00000000-0000-0000-0000-000000000001"],
    [
      `/proc/${process.pid}/stat`,
      `${process.pid} (proof) S ${process.ppid} ${process.pid}${" 0".repeat(14)} 1 0 12345\n`,
    ],
    [`/proc/${process.pid}/cmdline`, "procfs-proof\0"],
  ]);
  const mapped = new Map();
  for (const [key, value] of files) {
    const target = path.join(scratch, String(mapped.size));
    writeFileSync(target, value);
    mapped.set(key, target);
  }
  const originalReadFile = fsp.readFile;
  const originalReadFileSync = fs.readFileSync;
  const originalOpenSync = fs.openSync;
  fsp.readFile = (file, ...args) => originalReadFile(mapped.get(file) ?? file, ...args);
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
const own = (await readCodexAppServerProcessSnapshot(Date.now() + 10_000, [process.pid])).find(
  (row) => row.pid === process.pid,
);
if (!own) {
  throw new Error("The observer identity is unavailable.");
}
const fifo = path.join(scratch, "worker-blocker");
execFileSync("mkfifo", [fifo]);
const fd = openSync(fifo, "r+");
let release;
try {
  // One blocking read occupies the isolated process's only filesystem worker.
  const held = promisify(read)(fd, Buffer.alloc(1), 0, 1, null);
  const directStart = performance.now();
  readFileSync(`/proc/${process.pid}/stat`);
  const directReadMs = performance.now() - directStart;
  const started = performance.now();
  const deadline = Date.now() + 10_000;
  let eventLoopDelayMs;
  const responsive = new Promise((resolve) => {
    setTimeout(() => {
      eventLoopDelayMs = performance.now() - started - 100;
      resolve();
    }, 100);
  });
  release = setTimeout(() => writeSync(fd, Buffer.from("x")), 10_500);
  const outcomes = await Promise.allSettled([
    readCodexAppServerProcessSnapshot(deadline, [process.pid]),
    readCodexAppServerProcessCommand(own, deadline),
  ]);
  const inspectionMs = performance.now() - started;
  await Promise.all([held, responsive]);
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: actualPlatform,
        procfs: fixtureProcfs ? "fixture" : "kernel",
        sourceSha256: createHash("sha256")
          .update(readFileSync(new URL("../transport-process-snapshot.ts", import.meta.url)))
          .digest("hex"),
        startupDeadlineMs: 10_000,
        blockedFilesystemWorkerMs: 10_500,
        directReadMs,
        eventLoopDelayMs,
        inspectionMs,
        outcomes: outcomes.map((outcome, index) => {
          const operation = index === 0 ? "selected-identity" : "selected-command";
          if (outcome.status === "rejected") {
            return {
              operation,
              status: "rejected",
              name: outcome.reason?.name,
              reason: outcome.reason?.reason,
            };
          }
          return index === 0
            ? {
                operation,
                status: "fulfilled",
                observerPresent: outcome.value.some((row) => row.pid === process.pid),
              }
            : { operation, status: "fulfilled", commandBytes: Buffer.byteLength(outcome.value) };
        }),
      },
      null,
      2,
    ),
  );
} finally {
  clearTimeout(release);
  closeSync(fd);
  rmSync(scratch, { recursive: true, force: true });
}
