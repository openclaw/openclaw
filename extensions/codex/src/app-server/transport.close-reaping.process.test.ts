import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { closeCodexAppServerTransportAndWait } from "./transport.js";

/*
 * Real-process regression for adopted-descendant reaping during transport close
 * (#97616). The harness process becomes a Linux child subreaper, mirroring a
 * Gateway that adopts orphaned descendants (gateway-as-PID-1 deployments). A
 * fixture app-server root spawns holders in independent and shared process
 * groups, and each holder spawns a relay. Containment kills these exact
 * descendants during close; after the tracked root exits, their exit statuses
 * must be consumed by the scheduled reaper instead of accumulating as zombies
 * parented to this process. Cleanup is asserted by observing /proc from
 * outside the fixture tree, scoped to run-owned PIDs so unrelated host
 * processes cannot confound the result. A red control first proves the
 * observer detects an adopted zombie that no close path owns.
 */

const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";
const READINESS_ROLES = [
  "root",
  "holder-independent",
  "holder-shared",
  "relay-independent",
  "relay-shared",
] as const;
const DESCENDANT_ROLES = [
  "holder-independent",
  "holder-shared",
  "relay-independent",
  "relay-shared",
] as const;

type FixtureRow = { role: string; pid: number };
type ProcStat = { state: string; ppid: number; startTicks: string };

function readStat(pid: number): ProcStat | undefined {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return undefined;
  }
  const commEnd = stat.lastIndexOf(")");
  const fields = stat.slice(commEnd + 2).split(" ");
  if (commEnd < 0 || !/^\d+$/u.test(fields[19] ?? "")) {
    return undefined;
  }
  return { state: fields[0]!, ppid: Number(fields[1]), startTicks: fields[19]! };
}

function readBootId(): string {
  return readFileSync(BOOT_ID_PATH, "utf8").trim();
}

/** Observe, from outside the fixture tree, zombies this harness adopted. */
function scanRetainedZombies(): number[] {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return [];
  }
  const retained: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    const stat = readStat(Number(entry));
    if (stat && stat.state.startsWith("Z") && stat.ppid === process.pid) {
      retained.push(Number(entry));
    }
  }
  return retained.toSorted((left, right) => left - right);
}

async function waitFor<T>(
  probe: () => T | Promise<T>,
  isDone: (value: T) => boolean,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let latest: T;
  for (;;) {
    latest = await probe();
    if (isDone(latest)) {
      return latest;
    }
    if (Date.now() >= deadline) {
      return latest;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}

/** The test process adopts fixture descendants only as a Linux subreaper. */
function ensureHarnessIsSubreaper(): void {
  const hostRequire = createRequire(import.meta.resolve("openclaw/plugin-sdk/process-runtime"));
  const koffi = hostRequire("koffi") as typeof import("koffi").default;
  const libc = koffi.load(null);
  const prctl = libc.func(
    "int prctl(int, unsigned long, unsigned long, unsigned long, unsigned long)",
  );
  const PR_SET_CHILD_SUBREAPER = 36;
  if (prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) !== 0) {
    throw new Error("harness could not become a Linux child subreaper");
  }
}

async function readFixtureRows(logPath: string): Promise<FixtureRow[]> {
  const contents = await fs.readFile(logPath, "utf8").catch(() => "");
  return contents
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FixtureRow);
}

function fixtureRow(rows: FixtureRow[], role: string): FixtureRow {
  const row = rows.find((candidate) => candidate.role === role);
  if (!row) {
    throw new Error(`Missing fixture row for ${role}`);
  }
  return row;
}

type TeardownHandle = Pick<ChildProcess, "pid" | "exitCode" | "signalCode" | "once" | "kill">;

/**
 * Unconditional cleanup for every task-owned process, on success and failure
 * alike: terminate each fixture PID and tracked handle, join the tracked
 * handles so libuv consumes their exits, then reap adopted zombies the run
 * left parented to this harness so later tests start clean. The fixture log
 * is the roster; file removal must come after this runs.
 */
async function teardownFixtureProcesses(params: {
  logPath: string;
  tracked: ReadonlyArray<TeardownHandle | undefined>;
}): Promise<void> {
  const rows = await readFixtureRows(params.logPath).catch(() => [] as FixtureRow[]);
  const pids = new Set(rows.map((row) => row.pid));
  for (const handle of params.tracked) {
    if (!handle) {
      continue;
    }
    if (typeof handle.pid === "number" && handle.pid > 0) {
      pids.add(handle.pid);
    }
    try {
      handle.kill?.("SIGKILL");
    } catch {
      // The handle may already be gone.
    }
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process may already be gone.
    }
  }
  await Promise.all(
    params.tracked
      .filter((handle): handle is TeardownHandle => handle !== undefined)
      .map(
        (handle) =>
          new Promise<void>((resolve) => {
            if (handle.exitCode != null || handle.signalCode != null) {
              resolve();
              return;
            }
            const timer = setTimeout(resolve, 2_000);
            timer.unref?.();
            handle.once("exit", () => {
              clearTimeout(timer);
              resolve();
            });
          }),
      ),
  );
  // Killed descendants can land as adopted zombies parented to this harness.
  // Wait for terminal states, then consume the statuses through the exported
  // scheduler so a failing run cannot contaminate later tests.
  const roster = [...pids];
  await waitFor(
    () => roster.map((pid) => readStat(pid)),
    (stats) => stats.every((stat) => stat === undefined || stat.state.startsWith("Z")),
    2_000,
  );
  const processRuntime = await import("openclaw/plugin-sdk/process-runtime").catch(() => undefined);
  const scheduler = processRuntime?.scheduleAdoptedDescendantReapAfterRootExit;
  if (typeof scheduler !== "function") {
    return;
  }
  const identities = roster.flatMap((pid) => {
    const stat = readStat(pid);
    return stat && stat.state.startsWith("Z") && stat.ppid === process.pid
      ? [{ pid, startedAt: `${readBootId()}:${stat.startTicks}` }]
      : [];
  });
  if (identities.length === 0) {
    return;
  }
  // A detached, already-exited anchor starts cleanup immediately and never
  // collides with tracked children the production close already scheduled.
  scheduler({ pid: process.pid, exitCode: 0, signalCode: null, once: () => undefined }, identities);
  await waitFor(
    () => identities.every((identity) => readStat(identity.pid) === undefined),
    (done) => done,
    5_000,
  );
}

async function writeFixtures(tempDir: string): Promise<{
  logPath: string;
  rootPath: string;
  holderPath: string;
  relayPath: string;
  leaverPath: string;
}> {
  const logPath = path.join(tempDir, "processes.jsonl");
  const relayPath = path.join(tempDir, "relay.mjs");
  const holderPath = path.join(tempDir, "holder.mjs");
  const rootPath = path.join(tempDir, "root.mjs");
  const leaverPath = path.join(tempDir, "leaver.mjs");
  await fs.writeFile(logPath, "");
  await fs.writeFile(
    relayPath,
    `
setInterval(() => {}, 1_000);
`,
  );
  await fs.writeFile(
    holderPath,
    `
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
const [logPath, role, relayPath] = process.argv.slice(2);
const relay = spawn(process.execPath, [relayPath], { stdio: "ignore" });
relay.unref();
appendFileSync(logPath, JSON.stringify({ role: role.replace("holder", "relay"), pid: relay.pid }) + "\\n");
setInterval(() => {}, 1_000);
`,
  );
  await fs.writeFile(
    rootPath,
    `
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
const [logPath, holderPath, relayPath] = process.argv.slice(2);
appendFileSync(logPath, JSON.stringify({ role: "root", pid: process.pid }) + "\\n");
for (const [role, detached] of [["holder-independent", true], ["holder-shared", false]]) {
  const holder = spawn(process.execPath, [holderPath, logPath, role, relayPath], { detached, stdio: "ignore" });
  holder.unref();
  appendFileSync(logPath, JSON.stringify({ role, pid: holder.pid }) + "\\n");
}
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
`,
  );
  await fs.writeFile(
    leaverPath,
    `
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
const [logPath, relayPath] = process.argv.slice(2);
const orphan = spawn(process.execPath, [relayPath], { stdio: "ignore" });
orphan.unref();
appendFileSync(logPath, JSON.stringify({ role: "control-orphan", pid: orphan.pid }) + "\\n");
process.exit(0);
`,
  );
  return { logPath, rootPath, holderPath, relayPath, leaverPath };
}

describe.skipIf(process.platform !== "linux")("Codex app-server close reaping", () => {
  it("transport close consumes adopted descendants across process groups", async () => {
    ensureHarnessIsSubreaper();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-close-reaping-"));
    const fixtures = await writeFixtures(tempDir);
    // Handles live outside the try so unconditional teardown always sees them.
    let unrelated: ChildProcess | undefined;
    let root: ChildProcessWithoutNullStreams | undefined;
    try {
      unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
      });
      root = spawn(
        process.execPath,
        [fixtures.rootPath, fixtures.logPath, fixtures.holderPath, fixtures.relayPath],
        { detached: true, stdio: ["pipe", "pipe", "pipe"] },
      ) as ChildProcessWithoutNullStreams;
      const rootChild: ChildProcessWithoutNullStreams = root;
      const unrelatedChild: ChildProcess = unrelated;

      const rows = await waitFor(
        () => readFixtureRows(fixtures.logPath),
        (current) =>
          READINESS_ROLES.every((role) => {
            const row = current.find((candidate) => candidate.role === role);
            return row !== undefined && readStat(row.pid) !== undefined;
          }),
        10_000,
      );
      for (const role of DESCENDANT_ROLES) {
        const stat = readStat(fixtureRow(rows, role).pid);
        // Every descendant is alive when close begins, so containment observes
        // and terminates each one through the real production path.
        expect(stat?.state, `${role} must be alive at close`).toBeDefined();
        expect(stat?.state.startsWith("Z"), `${role} must be live, state ${stat?.state}`).toBe(
          false,
        );
      }
      expect(readStat(fixtureRow(rows, "root").pid)?.ppid).toBe(process.pid);

      const closed = await closeCodexAppServerTransportAndWait(rootChild, { drainStdio: true });

      // The tracked root completed normally and libuv consumed its own exit.
      expect(closed).toEqual({ exited: true, cleanup: "closed" });
      expect(rootChild.exitCode).toBe(0);
      expect(rootChild.signalCode).toBeNull();
      expect(readStat(fixtureRow(rows, "root").pid)).toBeUndefined();

      // Run-owned residue check: each retained descendant fully left /proc,
      // meaning its adopted zombie status was consumed rather than left
      // defunct, and no run-owned PID survives as a harness-parented zombie.
      const fixturePids = new Set(DESCENDANT_ROLES.map((entry) => fixtureRow(rows, entry).pid));
      for (const [name, pid] of DESCENDANT_ROLES.map(
        (entry) => [entry, fixtureRow(rows, entry).pid] as const,
      )) {
        const stat = await waitFor(
          () => readStat(pid),
          (current) => current === undefined,
          10_000,
        );
        expect(stat, `${name} pid ${pid} still present: ${JSON.stringify(stat)}`).toBeUndefined();
      }
      const retained = await waitFor(
        () => scanRetainedZombies(),
        (zombies) => !zombies.some((pid) => fixturePids.has(pid)),
        10_000,
      );
      expect(
        retained.filter((pid) => fixturePids.has(pid)),
        `run-owned zombies still parented to harness: ${retained.join(", ")}`,
      ).toEqual([]);

      // Unrelated work outside the closed tree keeps running untouched.
      expect(readStat(unrelatedChild.pid!)).toBeDefined();
    } finally {
      await teardownFixtureProcesses({ logPath: fixtures.logPath, tracked: [root, unrelated] });
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("red control: the observer detects an adopted zombie no close owns, and the exported scheduler reaps it", async () => {
    ensureHarnessIsSubreaper();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-close-reaping-red-"));
    const fixtures = await writeFixtures(tempDir);
    // The handle lives outside the try so unconditional teardown always sees it.
    let leaver: ChildProcess | undefined;
    try {
      // The control leaves a child behind on purpose: the leaver exits while
      // its orphan is alive, the subreaper harness adopts the orphan, and the
      // harness kills it with no waiter anywhere. The observer must report
      // the stuck zombie before the exported scheduler consumes it.
      leaver = spawn(
        process.execPath,
        [fixtures.leaverPath, fixtures.logPath, fixtures.relayPath],
        {
          stdio: "ignore",
        },
      );
      const leaverChild: ChildProcess = leaver;
      await new Promise((resolve) => {
        leaverChild.once("exit", resolve);
      });
      const rows = await waitFor(
        () => readFixtureRows(fixtures.logPath),
        (current) => current.some((row) => row.role === "control-orphan"),
        10_000,
      );
      const orphanPid = fixtureRow(rows, "control-orphan").pid;

      const adopted = await waitFor(
        () => readStat(orphanPid),
        (stat) => stat !== undefined && stat.ppid === process.pid,
        10_000,
      );
      expect(adopted, "orphan was never adopted by the harness").toBeDefined();
      expect(adopted?.state.startsWith("Z"), `orphan must be live, state ${adopted?.state}`).toBe(
        false,
      );

      process.kill(orphanPid, "SIGKILL");
      const zombie = await waitFor(
        () => readStat(orphanPid),
        (stat) => stat !== undefined && stat.state.startsWith("Z") && stat.ppid === process.pid,
        10_000,
      );
      const stuck = await waitFor(
        () => scanRetainedZombies(),
        (zombies) => zombies.includes(orphanPid),
        10_000,
      );
      expect(stuck, "observer must detect the intentionally leaked zombie").toContain(orphanPid);
      expect(zombie, "orphan never became a harness-parented zombie").toBeDefined();

      const processRuntime = await import("openclaw/plugin-sdk/process-runtime");
      expect(typeof processRuntime.scheduleAdoptedDescendantReapAfterRootExit).toBe("function");
      processRuntime.scheduleAdoptedDescendantReapAfterRootExit(leaverChild, [
        { pid: orphanPid, startedAt: `${readBootId()}:${zombie?.startTicks}` },
      ]);
      const stat = await waitFor(
        () => readStat(orphanPid),
        (current) => current === undefined,
        10_000,
      );
      expect(stat, "exported scheduler did not reap the control zombie").toBeUndefined();
    } finally {
      await teardownFixtureProcesses({ logPath: fixtures.logPath, tracked: [leaver] });
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
