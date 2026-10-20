import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { awaitGateBeforeSettlement, withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { terminateCodexAppServerOrphan } from "./transport-process-containment.js";
import * as processSnapshot from "./transport-process-snapshot.js";
import type { PosixProcess } from "./transport-process-snapshot.js";
import { closeCodexAppServerTransportAndWait } from "./transport.js";

type FixtureEvent = {
  role: "root" | "separate-leader" | "separate-descendant" | "shared-leader" | "shared-descendant";
  pid: number;
  pgid: number;
};

const repeat = (rows: PosixProcess[], times = 2) => Array.from({ length: times }, () => rows);
const closeOptions = { forceKillDelayMs: 500, exitTimeoutMs: 2_000 };

function spawnRoot(file: string, args: string[]) {
  return spawn(process.execPath, [file, ...args], {
    detached: true,
    stdio: "pipe",
  });
}

async function listProcesses(tempDir: string): Promise<number[]> {
  // Stream and retain only owned fixtures: unrelated host command lines can
  // exceed execFileSync's buffer and must not leak into a failed assertion.
  const child = spawn("ps", ["-axo", "pid=,command="], { stdio: ["ignore", "pipe", "ignore"] });
  const closed = once(child, "close");
  const rows: number[] = [];
  for await (const line of createInterface({ input: child.stdout })) {
    if (!line.includes(tempDir)) {
      continue;
    }
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match) {
      rows.push(Number(match[1]));
    }
  }
  expect((await closed)[0]).toBe(0);
  return rows;
}

function fixtureReadiness(child: ChildProcessWithoutNullStreams, count: number): Promise<string[]> {
  return new Promise((resolve) => {
    const lines = createInterface({ input: child.stdout });
    const received: string[] = [];
    lines.on("line", (line) => {
      received.push(line);
      if (received.length === count) {
        lines.close();
        resolve(received);
      }
    });
    child.once("close", () => lines.close());
  });
}

async function cleanupFixture(tempDir: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const ownedRows = await listProcesses(tempDir);
    if (ownedRows.length === 0) {
      await fs.rm(tempDir, { recursive: true, force: true });
      return;
    }
    for (const pid of ownedRows) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          throw error;
        }
      }
    }
    await delay(20);
  }
  const survivors = await listProcesses(tempDir);
  if (survivors.length > 0) {
    throw new Error(`task-owned process fixture survived cleanup: ${JSON.stringify(survivors)}`);
  }
  await fs.rm(tempDir, { recursive: true, force: true });
}

describe.skipIf(process.platform === "win32")("Codex app-server process containment", () => {
  let tempDir: string;
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-process-"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupFixture(tempDir);
  });

  it.each(["startedAt", "pgid"] as const)("does not signal stale %s identities", async (field) => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", tempDir], {
      detached: true,
      stdio: "ignore",
    });
    await once(child, "spawn");
    const identity = (
      await processSnapshot.readCodexAppServerProcessSnapshot(undefined, [child.pid!])
    )?.find((row) => row.pid === child.pid);
    if (!identity) {
      throw new Error("Missing test process identity");
    }
    const stale =
      field === "startedAt"
        ? { ...identity, startedAt: "Mon Jan 1 00:00:00 2001" }
        : { ...identity, pgid: identity.pgid + 1 };
    // PID reuse retires a stale row; group drift remains ambiguous and blocks startup.
    expect(await terminateCodexAppServerOrphan(stale)).toBe(field === "startedAt");
    expect(child).toMatchObject({ exitCode: null, signalCode: null });
    expect(process.kill(child.pid!, 0)).toBe(true);
  });

  it("reaps descendants in independent and root process groups before close returns", async ({
    signal,
  }) => {
    const rootPath = path.join(tempDir, "root.mjs");
    await fs.writeFile(
      rootPath,
      `
import { execFileSync, spawn } from "node:child_process";
const [role] = process.argv.slice(2);
const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim());
const emit = (event) => process.send ? process.send(event) : process.stdout.write(JSON.stringify(event) + "\\n");
function start(role, detached = false) {
  const child = spawn(process.execPath, [process.argv[1], role], { detached, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  child.on("message", emit);
  child.unref();
}
if (role === "root") {
  emit({ role, pid: process.pid, pgid });
  start("separate-leader", true);
  start("shared-leader");
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));
} else {
  if (role.endsWith("leader")) start(role.replace("leader", "descendant"));
  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(signal, () => {});
  emit({ role, pid: process.pid, pgid });
  setInterval(() => {}, 1_000);
}
`,
    );

    const root = spawnRoot(rootPath, ["root"]);

    const ready = fixtureReadiness(root, 5);
    const closed = once(root, "close");
    const lines = await withinTest(
      awaitGateBeforeSettlement(ready, closed, "timed out waiting for 5 process fixture events"),
      signal,
    );
    const events = lines.map((line) => JSON.parse(line) as FixtureEvent);
    const groups = Object.fromEntries(events.map(({ role, pgid }) => [role, pgid]));
    expect(groups).toEqual({
      root: expect.any(Number),
      "separate-leader": events.find(({ role }) => role === "separate-leader")?.pid,
      "separate-descendant": groups["separate-leader"],
      "shared-leader": groups.root,
      "shared-descendant": groups.root,
    });
    await expect(closeCodexAppServerTransportAndWait(root, closeOptions)).resolves.toEqual({
      exited: true,
      cleanup: "closed",
    });
    expect(root).toMatchObject({ exitCode: 0, signalCode: null });

    expect(await listProcesses(tempDir)).toEqual([]);
  });

  it.for([
    ["reuse", true],
    ["late", false],
    ["reparented", false],
    ["root-resumed", false],
    ["traced", false],
    ["uninterruptible", false],
    ["unconfirmed-termination", false],
    ["snapshot-failure", true],
    ["inspection-timeout", true],
    ["extended", false],
  ] as const)("revalidates identities while quiescing: %s", async (scenario, ctx) => {
    const [mode, sentinelSurvived] = scenario;
    const rootPath = path.join(tempDir, "root.mjs");
    const sentinelPath = path.join(tempDir, "sentinel.mjs");
    await fs.writeFile(
      sentinelPath,
      `
for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(signal, () => {});
setInterval(() => {}, 1_000);
`,
    );
    await fs.writeFile(
      rootPath,
      `
import { spawn } from "node:child_process";
const [sentinelPath] = process.argv.slice(2);
const sentinel = spawn(process.execPath, [sentinelPath], { detached: true, stdio: "ignore" });
sentinel.unref();
process.stdout.write(String(sentinel.pid) + "\\n");
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
`,
    );
    const root = spawnRoot(rootPath, [sentinelPath]);
    const ready = fixtureReadiness(root, 1);
    const rootClosed = once(root, "close");
    const [sentinelPidLine] = await withinTest(
      awaitGateBeforeSettlement(ready, rootClosed, "Missing root or sentinel process identity"),
      ctx.signal,
    );
    const sentinelPid = Number(sentinelPidLine);
    const initial = await processSnapshot.readCodexAppServerProcessSnapshot(undefined, [
      root.pid!,
      sentinelPid,
    ]);
    const rootIdentity = initial?.find((row) => row.pid === root.pid);
    const sentinelIdentity = initial?.find((row) => row.pid === sentinelPid);
    if (!rootIdentity || !sentinelIdentity) {
      throw new Error("Missing root or sentinel process identity");
    }
    const stoppedRoot = { ...rootIdentity, state: "T" };
    const oldSentinel = {
      ...sentinelIdentity,
      ppid: rootIdentity.pid,
      state: "S",
      startedAt: "Mon Jan 1 00:00:00 2001",
    };
    const stoppedSentinel = { ...sentinelIdentity, state: "T" };
    const runningTree = [rootIdentity, sentinelIdentity];
    const rootStoppedTree = [stoppedRoot, sentinelIdentity];
    const stoppedTree = [stoppedRoot, stoppedSentinel];
    const quiescing = [...repeat(runningTree), ...repeat(rootStoppedTree)];
    const blockedTree = [stoppedRoot, { ...sentinelIdentity, state: "U" }];
    const scenarios: Record<typeof mode, Array<PosixProcess[] | undefined | "deadline">> = {
      reuse: [
        ...repeat([rootIdentity, oldSentinel]),
        ...repeat([stoppedRoot, oldSentinel]),
        [stoppedRoot, { ...oldSentinel, state: "T" }],
        stoppedTree,
      ],
      late: [...repeat([rootIdentity]), ...repeat(rootStoppedTree), stoppedTree],
      reparented: [
        ...quiescing,
        [stoppedRoot, { ...stoppedSentinel, ppid: 1, pgid: stoppedSentinel.pgid + 1 }],
      ],
      "root-resumed": [...repeat(runningTree, 4), ...repeat(rootStoppedTree), stoppedTree],
      traced: [...quiescing, [stoppedRoot, { ...stoppedSentinel, state: "t" }]],
      uninterruptible: [...repeat(runningTree), ...repeat(blockedTree)],
      "unconfirmed-termination": [...repeat(runningTree), ...repeat(blockedTree)],
      "snapshot-failure": [...quiescing, undefined],
      "inspection-timeout": [...repeat(runningTree), "deadline"],
      extended: [...repeat(runningTree), ...repeat(rootStoppedTree, 16), stoppedTree],
    };
    const snapshots = scenarios[mode];
    let inspection = 0;
    let descendantSignalled = false;
    const actualSnapshot = processSnapshot.readCodexAppServerProcessSnapshot;
    const actualProcess = processSnapshot.readCodexAppServerProcess;
    let rootStopObserved = false;
    const actualKill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      const signalled = actualKill(pid, signal);
      descendantSignalled ||= pid === sentinelPid && signal === "SIGKILL";
      return signalled;
    });
    const readSnapshot = async (
      inspectionDeadline: number,
      pids?: readonly number[],
    ): Promise<PosixProcess[]> => {
      // Identity faults exercise signalling; cleanup needs a separate OS
      // observation. A queued kill alone must not certify an uninterruptible child.
      if (descendantSignalled && mode !== "unconfirmed-termination") {
        return await actualSnapshot(inspectionDeadline, pids);
      }
      const rows = snapshots[Math.min(inspection++, snapshots.length - 1)];
      if (rows === "deadline") {
        await delay(Math.max(1, inspectionDeadline - performance.now()));
        throw new processSnapshot.ProcessInspectionError("deadline");
      }
      if (!rows) {
        throw new processSnapshot.ProcessInspectionError("unavailable");
      }
      if (
        !rootStopObserved &&
        rows.some((row) => row.pid === rootIdentity.pid && row.state === "T")
      ) {
        // Do not let synthetic stopped rows outrun delivery of the real SIGSTOP.
        while (
          !(await actualProcess(rootIdentity.pid, inspectionDeadline))?.state.startsWith("T")
        ) {
          await delay(1);
        }
        rootStopObserved = true;
      }
      return rows;
    };
    vi.spyOn(processSnapshot, "readCodexAppServerProcessSnapshot").mockImplementation(
      (inspectionDeadline, pids) =>
        readSnapshot(inspectionDeadline ?? performance.now() + 2_000, pids),
    );
    vi.spyOn(processSnapshot, "readCodexAppServerProcess").mockImplementation(
      async (pid, inspectionDeadline) =>
        (await readSnapshot(inspectionDeadline, [pid]))?.find((row) => row.pid === pid),
    );
    const closed = await closeCodexAppServerTransportAndWait(root, closeOptions);
    vi.restoreAllMocks();
    expect(closed).toEqual({
      exited: true,
      cleanup: sentinelSurvived || mode === "unconfirmed-termination" ? "uncertain" : "closed",
    });
    expect(root.exitCode).toBe(0);
    const survived = (await listProcesses(tempDir)).includes(sentinelPid);
    expect(survived).toBe(sentinelSurvived);
    if (mode === "snapshot-failure" || mode === "inspection-timeout") {
      const sentinel = await processSnapshot.readCodexAppServerProcess(
        sentinelIdentity.pid,
        performance.now() + 2_000,
      );
      expect(sentinel).toBeDefined();
      expect(sentinel?.state).not.toMatch(/^[Tt]/);
    }
  });
});
