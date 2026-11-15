// Separate real-procfs proof: trigger a worker-spawned hog just after a slow sample.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    output: { type: "string" },
    observers: { type: "string", default: "1" },
    "descendant-cgroup": { type: "string" },
  },
});
assert.equal(process.platform, "linux");
assert.ok(values.owner, "--owner is required");
assert.ok(values.output, "--output is required");
const observers = Number(values.observers);
assert.ok(Number.isSafeInteger(observers) && observers >= 1);
const companions: Array<() => void> = [];
const owner = path.resolve(values.owner);
const {
  watchHostExecMemory,
  getHostExecMemoryBudget,
}: typeof import("../../src/process/child-memory.js") = await import(pathToFileURL(owner).href);
// Qualify only this task's automatic budget; the owner remains latched thereafter.
const budget = (() => {
  const constrainedMemory = Object.getOwnPropertyDescriptor(process, "constrainedMemory");
  const rss = Object.getOwnPropertyDescriptor(process.memoryUsage, "rss");
  assert.ok(constrainedMemory && rss);
  try {
    process.constrainedMemory = () => 1024 ** 3;
    process.memoryUsage.rss = () => 0;
    return getHostExecMemoryBudget();
  } finally {
    Object.defineProperty(process, "constrainedMemory", constrainedMemory);
    Object.defineProperty(process.memoryUsage, "rss", rss);
  }
})();
assert.ok(budget);
assert.equal(budget.memoryBytes, 640 * 1024 ** 2, "Proof requires at least 1 GiB physical RAM");
const limitBytes = budget.memoryBytes;
const fixture = fileURLToPath(new URL("./child-memory-fixture.cjs", import.meta.url));
const child = spawn(process.execPath, [fixture, "2"], {
  detached: true,
  stdio: ["pipe", "pipe", "inherit"],
});
const originalSetTimeout = globalThis.setTimeout;
let stop: (() => void) | undefined;
let phaseTimeout: NodeJS.Timeout | undefined;
let armAt = 0;
let burstAt = 0;
let limitAt = 0;
let observedBytes = 0;
let diagnostic = "";
let output = "";
try {
  await new Promise<void>((resolve, reject) => {
    phaseTimeout = setTimeout(() => reject(new Error("Fixture readiness timed out")), 30_000);
    const onExit = () => reject(new Error("Fixture exited during setup"));
    child.once("error", reject);
    child.once("exit", onExit);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const burst = /\{"event":"burst","at":(\d+)\}/.exec(output);
      if (burst) {
        burstAt = Number(burst[1]);
      }
      if (output.includes('"ready"')) {
        clearTimeout(phaseTimeout);
        child.removeListener("exit", onExit);
        resolve();
      }
    });
  });
  assert.ok(child.pid);
  const pids = new Set([child.pid]);
  for (const tid of await readdir(`/proc/${child.pid}/task`)) {
    const children = await readFile(`/proc/${child.pid}/task/${tid}/children`, "utf8");
    for (const pid of children.trim().split(/\s+/).map(Number)) {
      if (pid > 0) {
        pids.add(pid);
      }
    }
  }
  assert.equal(pids.size, 3, "Expected both worker-spawned descendants");
  if (values["descendant-cgroup"]) {
    const rootGroup = fs.readFileSync(`/proc/${child.pid}/cgroup`, "utf8");
    for (const pid of pids) {
      if (pid !== child.pid) {
        fs.writeFileSync(path.join(values["descendant-cgroup"], "cgroup.procs"), String(pid));
        assert.notEqual(fs.readFileSync(`/proc/${pid}/cgroup`, "utf8"), rootGroup);
      }
    }
  }
  const readPhysicalBytes = async () => {
    const statuses = await Promise.all(
      [...pids].map((pid) => readFile(`/proc/${pid}/status`, "utf8")),
    );
    let bytes = 0;
    for (const status of statuses) {
      for (const match of status.matchAll(/^(?:VmRSS|VmSwap):\s+(\d+) kB$/gm)) {
        bytes += Number(match[1]) * 1024;
      }
    }
    return bytes;
  };
  const initialBytes = await readPhysicalBytes();
  assert.ok(initialBytes < limitBytes / 2, "Fixture must begin below half its bound");
  const slowSample = new Promise<void>((resolve, reject) => {
    phaseTimeout = originalSetTimeout(
      () => reject(new Error("Watcher did not schedule a five-second sample")),
      15_000,
    );
    child.once("exit", () => reject(new Error("Fixture exited before the slow interval")));
    // Forward real deadlines unchanged; shared scheduling subtracts elapsed sample time.
    globalThis.setTimeout = Object.assign((...args: Parameters<typeof setTimeout>) => {
      const timer = originalSetTimeout(...args);
      if (args[1] !== undefined && args[1] >= 4990 && args[1] <= 5000 && !armAt) {
        armAt = Date.now();
        resolve();
      }
      return timer;
    }, originalSetTimeout);
  });
  const onLimit = () => {
    if (limitAt) {
      return;
    }
    limitAt = Date.now();
    process.kill(-child.pid!, "SIGKILL");
  };
  const onDiagnostic = (text: string) => {
    diagnostic += text;
    observedBytes = Number(/RAM (\d+)\//u.exec(text)?.[1] ?? 0) * 1024 ** 2;
  };
  stop = watchHostExecMemory({ pid: child.pid, onLimit, onDiagnostic });
  // Overlapping observers share the same charge and idempotent cancellation.
  for (let index = 1; index < observers; index++) {
    companions.push(watchHostExecMemory({ pid: child.pid, onLimit, onDiagnostic }));
  }
  await slowSample;
  // The pending five-second timer remains real; remove observation before the burst.
  globalThis.setTimeout = originalSetTimeout;
  clearTimeout(phaseTimeout);
  const exit = once(child, "exit", { signal: AbortSignal.timeout(8000) });
  const requestedAt = Date.now();
  child.stdin.write("burst\n");
  // Separate proof observation only; stop polling as soon as growth crosses the cap.
  const crossing = (async () => {
    while (Date.now() - requestedAt <= 5000) {
      const bytes = await readPhysicalBytes();
      if (bytes > limitBytes) {
        return { at: Date.now(), bytes };
      }
      await delay(20);
    }
    throw new Error("Runaway did not observably cross its bound within five seconds");
  })();
  const [crossed, [, exitSignal]] = await Promise.all([crossing, exit]);
  const exitAt = Date.now();
  assert.ok(burstAt, "Worker burst request was not observed");
  assert.ok(burstAt >= armAt && burstAt - armAt <= 250, "Missed the worst-phase burst window");
  assert.ok(crossed.at >= burstAt && crossed.at - burstAt <= 5000);
  assert.ok(exitAt - burstAt >= 4500, "The proof did not exercise the five-second interval");
  assert.ok(exitAt - burstAt <= 6000, "Runaway survived beyond the accepted six-second bound");
  assert.equal(exitSignal, "SIGKILL");
  assert.ok(observedBytes > limitBytes);
  assert.match(diagnostic, /shared host exec memory budget was exceeded/);
  const result = {
    scope: "real worker-descendant burst immediately after a low/stable sample; no fake clocks",
    node: process.version,
    owner,
    ownerModuleSha256: createHash("sha256").update(fs.readFileSync(owner)).digest("hex"),
    scheduledIntervalMs: 5000,
    observers,
    migratedDescendants: values["descendant-cgroup"] ? pids.size - 1 : 0,
    armAt,
    burstAt,
    limitAt,
    exitAt,
    armToBurstMs: burstAt - armAt,
    burstToOverCapMs: crossed.at - burstAt,
    burstToExitMs: exitAt - burstAt,
    initialBytes,
    firstOverCapBytes: crossed.bytes,
    limitBytes,
    observedBytes,
    exitSignal,
    diagnostic,
  };
  fs.writeFileSync(path.resolve(values.output), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  globalThis.setTimeout = originalSetTimeout;
  clearTimeout(phaseTimeout);
  stop?.();
  companions.forEach((stopObserver) => stopObserver());
  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        process.stderr.write(`Fixture cleanup failed: ${String(error)}\n`);
        process.exitCode = 1;
      }
    }
    if (child.exitCode === null && child.signalCode === null) {
      await once(child, "exit");
    }
  }
}
