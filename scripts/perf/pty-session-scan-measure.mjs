// Linux owner-boundary probe; all process fixtures belong to this invocation.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const [owner, shape = "live", count = "100", startAt = "0"] = process.argv.slice(2);
assert(owner && ["live", "exited"].includes(shape));
assert.equal(process.platform, "linux");
const operations = Number(count);
assert(Number.isSafeInteger(operations) && operations > 0);
const { signalPtySessionTree } = await import(pathToFileURL(owner).href);
const root = childProcess.spawn(
  "python3",
  [
    "-c",
    `import os,signal,sys
child=os.fork()
if child==0:
 os.setpgid(0,0)
 while True: signal.pause()
def stop(sig,frame):
 os.waitpid(child,0)
 sys.exit(0)
signal.signal(signal.SIGTERM,stop)
print(child,flush=True)
while True: signal.pause()
`,
  ],
  { detached: true, stdio: ["ignore", "pipe", "inherit"] },
);
const closed = once(root, "close");
const lines = createInterface({ input: root.stdout });
const [childLine] = await once(lines, "line");
lines.close();
const childPid = Number(childLine);
assert(root.pid && childPid > 0);
const allowed = new Set([root.pid, -root.pid, childPid, -childPid]);
const originalSpawnSync = childProcess.spawnSync;
const originalKill = process.kill.bind(process);
let scans = 0;
let bytes = 0;
let signalCount = 0;
const unexpectedTargets = new Set();
childProcess.spawnSync = (...args) => {
  const result = originalSpawnSync(...args);
  if (args[0] === "ps") {
    scans++;
    bytes += Buffer.byteLength(result.stdout ?? "");
  }
  return result;
};
syncBuiltinESMExports();
let stopped = false;
const stop = async () => {
  signalPtySessionTree(root.pid, "SIGTERM");
  await Promise.race([
    closed,
    delay(5000, undefined, { ref: false }).then(() => {
      throw new Error("Synthetic PTY session did not exit");
    }),
  ]);
  stopped = true;
  assert.throws(() => originalKill(childPid, 0), { code: "ESRCH" });
};
const gc = [];
const observer = new PerformanceObserver((list) => gc.push(...list.getEntries()));
const loop = monitorEventLoopDelay({ resolution: 10 });
try {
  // Wait until the child owns its distinct job-control group before measuring.
  while (
    Number(readFileSync(`/proc/${childPid}/stat`, "utf8").split(") ")[1].split(" ")[2]) !== childPid
  ) {
    await delay(1);
  }
  if (shape === "exited") {
    await stop();
  }
  // Reuse the prepared session without terminating it on each measured iteration.
  // Signals are checked, then the final uninstrumented call proves real teardown.
  process.kill = (pid) => {
    if (!allowed.has(pid)) {
      unexpectedTargets.add(pid);
    }
    signalCount++;
    return true;
  };
  for (let i = 0; i < 5; i++) {
    signalPtySessionTree(root.pid, "SIGTERM");
  }
  assert.equal(unexpectedTargets.size, 0, "Unexpected warmup signal targets");
  if (Number(startAt) > 0) {
    assert(Number(startAt) > Date.now(), "Missed synchronized start");
    await delay(Number(startAt) - Date.now());
  }
  scans = bytes = signalCount = 0;
  observer.observe({ entryTypes: ["gc"] });
  loop.enable();
  const times = [];
  const cpu = process.threadCpuUsage();
  const start = performance.now();
  for (let i = 0; i < operations; i++) {
    const began = performance.now();
    signalPtySessionTree(root.pid, "SIGTERM");
    times.push(performance.now() - began);
    await delay(1);
  }
  const elapsedMs = performance.now() - start;
  const used = process.threadCpuUsage(cpu);
  loop.disable();
  await delay(10);
  observer.disconnect();
  assert.equal(unexpectedTargets.size, 0, "Unexpected measured signal targets");
  times.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      sourceSha256: createHash("sha256").update(readFileSync(owner)).digest("hex"),
      shape,
      operations,
      scans,
      bytes,
      signalCount,
      elapsedMs,
      mainCpuMsPerOp: (used.user + used.system) / 1000 / operations,
      wallMedianMs: times[Math.floor(times.length / 2)],
      wallP95Ms: times[Math.floor(times.length * 0.95)],
      gcCount: gc.length,
      gcMsPerOp: gc.reduce((total, entry) => total + entry.duration, 0) / operations,
      gcMaxMs: Math.max(0, ...gc.map((entry) => entry.duration)),
      gc: gc.map((entry) => ({ kind: entry.detail.kind, durationMs: entry.duration })),
      loop: {
        samples: loop.count,
        p95Ms: loop.percentile(95) / 1e6,
        p99Ms: loop.percentile(99) / 1e6,
        maxMs: loop.max / 1e6,
      },
    }),
  );
} finally {
  observer.disconnect();
  loop.disable();
  process.kill = originalKill;
  childProcess.spawnSync = originalSpawnSync;
  syncBuiltinESMExports();
  if (!stopped) {
    try {
      if (unexpectedTargets.size === 0) {
        await stop();
      }
    } finally {
      for (const pid of [childPid, root.pid]) {
        try {
          originalKill(pid, "SIGKILL");
        } catch {
          /* Already reaped. */
        }
      }
    }
  }
}
