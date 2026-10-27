import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it, vi } from "vitest";
import * as processContainment from "./transport-process-containment.js";
import { terminateCodexAppServerOrphan } from "./transport-process-containment.js";
import * as processSnapshot from "./transport-process-snapshot.js";
import type { PosixProcess } from "./transport-process-snapshot.js";
import { closeCodexAppServerTransportAndWait } from "./transport.js";

type FixtureEvent = {
  role: "root" | "separate-leader" | "separate-descendant" | "shared-leader" | "shared-descendant";
  pid: number;
  pgid: number;
};

type ProcessRow = {
  pid: number;
  command: string;
};

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

async function listProcesses(tempDir: string): Promise<ProcessRow[]> {
  // Stream and retain only owned fixtures: unrelated host command lines can
  // exceed execFileSync's buffer and must not leak into a failed assertion.
  const child = spawn("ps", ["-axo", "pid=,command="], { stdio: ["ignore", "pipe", "ignore"] });
  const closed = once(child, "close");
  const rows: ProcessRow[] = [];
  for await (const line of createInterface({ input: child.stdout })) {
    if (!line.includes(tempDir)) {
      continue;
    }
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match) {
      rows.push({
        pid: Number(match[1]),
        command: match[2] ?? "",
      });
    }
  }
  expect((await closed)[0]).toBe(0);
  return rows;
}

async function waitForFixtureEvents(logPath: string, count: number): Promise<FixtureEvent[]> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const events = await readFixtureEvents(logPath);
    if (events.length >= count) {
      return events;
    }
    await delay(20);
  }
  throw new Error(`timed out waiting for ${count} process fixture events`);
}

async function readFixtureEvents(logPath: string): Promise<FixtureEvent[]> {
  const contents = await fs.readFile(logPath, "utf8").catch(() => "");
  return contents
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FixtureEvent);
}

async function removeTaskOwnedFixtureProcesses(tempDir: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const ownedRows = await listProcesses(tempDir);
    if (ownedRows.length === 0) {
      return;
    }
    for (const row of ownedRows) {
      try {
        process.kill(row.pid, "SIGKILL");
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
}

describe.skipIf(process.platform === "win32")("Codex app-server process containment", () => {
  it.each(["startedAt", "pgid"] as const)(
    "does not signal a registered PID with a changed %s",
    async (field) => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        detached: true,
        stdio: "ignore",
      });
      await once(child, "spawn");
      try {
        const identity = (await processSnapshot.readCodexAppServerProcessSnapshot())?.find(
          (row) => row.pid === child.pid,
        );
        if (!identity) {
          throw new Error("Missing test process identity");
        }
        const stale =
          field === "startedAt"
            ? { ...identity, startedAt: "Mon Jan 1 00:00:00 2001" }
            : { ...identity, pgid: identity.pgid + 1 };
        // PID reuse retires a stale row; group drift remains ambiguous and blocks startup.
        expect(await terminateCodexAppServerOrphan(stale)).toBe(field === "startedAt");
        expect(child.exitCode).toBeNull();
        expect(child.signalCode).toBeNull();
        expect(process.kill(child.pid!, 0)).toBe(true);
      } finally {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    },
  );

  it("reaps descendants in independent and root process groups before close returns", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-transport-process-"));
    const logPath = path.join(tempDir, "processes.jsonl");
    const rootPath = path.join(tempDir, "root.mjs");
    const leaderPath = path.join(tempDir, "leader.mjs");
    const descendantPath = path.join(tempDir, "descendant.mjs");
    await fs.writeFile(logPath, "");
    await fs.writeFile(
      descendantPath,
      `
import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const [logPath, role] = process.argv.slice(2);
const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim());
appendFileSync(logPath, JSON.stringify({ role, pid: process.pid, pgid }) + "\\n");
for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(signal, () => {});
setInterval(() => {}, 1_000);
`,
    );
    await fs.writeFile(
      leaderPath,
      `
import { appendFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
const [logPath, role, descendantPath] = process.argv.slice(2);
const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim());
appendFileSync(logPath, JSON.stringify({ role, pid: process.pid, pgid }) + "\\n");
const descendant = spawn(process.execPath, [descendantPath, logPath, role.replace("leader", "descendant")], { stdio: "ignore" });
descendant.unref();
for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(signal, () => {});
setInterval(() => {}, 1_000);
`,
    );
    await fs.writeFile(
      rootPath,
      `
import { appendFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
const [logPath, leaderPath, descendantPath] = process.argv.slice(2);
const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim());
appendFileSync(logPath, JSON.stringify({ role: "root", pid: process.pid, pgid }) + "\\n");
for (const [role, detached] of [["separate-leader", true], ["shared-leader", false]]) {
  const child = spawn(process.execPath, [leaderPath, logPath, role, descendantPath], { detached, stdio: "ignore" });
  child.unref();
}
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
`,
    );

    const root = spawn(process.execPath, [rootPath, logPath, leaderPath, descendantPath], {
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    try {
      const events = await waitForFixtureEvents(logPath, 5);
      const eventByRole = new Map(events.map((event) => [event.role, event]));
      const rootEvent = eventByRole.get("root");
      const separateLeader = eventByRole.get("separate-leader");
      const separateDescendant = eventByRole.get("separate-descendant");
      const sharedLeader = eventByRole.get("shared-leader");
      const sharedDescendant = eventByRole.get("shared-descendant");
      expect(rootEvent).toBeDefined();
      expect(separateLeader?.pgid).toBe(separateLeader?.pid);
      expect(separateDescendant?.pgid).toBe(separateLeader?.pgid);
      expect(sharedLeader?.pgid).toBe(rootEvent?.pgid);
      expect(sharedDescendant?.pgid).toBe(rootEvent?.pgid);
      await expect(
        closeCodexAppServerTransportAndWait(root, {
          forceKillDelayMs: 500,
          exitTimeoutMs: 2_000,
        }),
      ).resolves.toEqual({ exited: true, cleanup: "closed" });
      expect(root.exitCode).toBe(0);
      expect(root.signalCode).toBeNull();

      const survivors = await listProcesses(tempDir);
      expect(survivors).toEqual([]);
    } finally {
      await removeTaskOwnedFixtureProcesses(tempDir);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it
    .skipIf(process.platform !== "linux")
    .each(["default", "owned", "containment-refused", "kill-refused", "kill-threw"] as const)(
    "keeps managed wrapper process cleanup evidence distinct: %s",
    async (mode) => {
      // openclaw-temp-dir: allow reuses the process suite's owned-fixture cleanup.
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-wrapper-close-"));
      const logPath = path.join(tempDir, "processes.jsonl");
      const wrapperPath = path.join(tempDir, "wrapper.mjs");
      const childPath = path.join(tempDir, "child.mjs");
      const mirroredSignalPath = path.join(tempDir, "mirrored-signal");
      await fs.writeFile(logPath, "");
      await fs.writeFile(
        childPath,
        `
import { appendFileSync } from "node:fs";
const [logPath] = process.argv.slice(2);
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
appendFileSync(logPath, JSON.stringify({ role: "shared-descendant", pid: process.pid, pgid: process.ppid }) + "\\n");
`,
      );
      // Match the supported npm launcher's inherited pipes and signal mirroring.
      await fs.writeFile(
        wrapperPath,
        `
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
const [childPath, logPath, mirroredSignalPath] = process.argv.slice(2);
const child = spawn(process.execPath, [childPath, logPath], { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => { if (!child.killed) child.kill(signal); });
}
child.on("exit", (code, signal) => {
  if (signal) {
    appendFileSync(mirroredSignalPath, signal);
    process.kill(process.pid, signal);
  }
  else process.exit(code ?? 1);
});
appendFileSync(logPath, JSON.stringify({ role: "root", pid: process.pid, pgid: process.pid }) + "\\n");
`,
      );
      const wrapper = spawn(
        process.execPath,
        [wrapperPath, childPath, logPath, mirroredSignalPath],
        {
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const wrapperClosed = once(wrapper, "close");
      let restoreContainment: (() => void) | undefined;
      let restoreKill: (() => void) | undefined;
      try {
        const events = await waitForFixtureEvents(logPath, 2);
        const descendantPid = events.find((event) => event.role === "shared-descendant")?.pid;
        expect(descendantPid).toBeDefined();
        const before = await processSnapshot.readCodexAppServerProcessSnapshot();
        const descendant = before.find((row) => row.pid === descendantPid);
        expect(descendant).toMatchObject({ ppid: wrapper.pid, pgid: wrapper.pid });
        if (mode === "containment-refused") {
          const spy = vi
            .spyOn(processContainment, "terminateCodexAppServerDescendants")
            .mockResolvedValue(undefined);
          restoreContainment = () => spy.mockRestore();
        }
        if (mode === "kill-refused" || mode === "kill-threw") {
          const kill = wrapper.kill.bind(wrapper);
          const spy = vi.spyOn(wrapper, "kill").mockImplementation((signal) => {
            if (signal !== "SIGKILL") {
              return kill(signal);
            }
            if (mode === "kill-threw") {
              throw new Error("owned root kill refused");
            }
            return false;
          });
          restoreKill = () => spy.mockRestore();
        }

        const options = mode === "default" ? {} : { terminateOwnedProcess: true as const };
        await expect(closeCodexAppServerTransportAndWait(wrapper, options)).resolves.toEqual({
          exited: true,
          cleanup: mode === "owned" ? "closed" : "uncertain",
        });
        await wrapperClosed;
        expect(wrapper.exitCode).toBe(mode === "containment-refused" ? 0 : null);
        expect(wrapper.signalCode).toBe(mode === "containment-refused" ? null : "SIGKILL");
        const mirrored = await fs.readFile(mirroredSignalPath, "utf8").catch(() => "");
        expect(mirrored).toBe(mode === "owned" || mode === "containment-refused" ? "" : "SIGKILL");
        // A later opt-in cannot promote a prior close's uncertain evidence.
        await expect(
          closeCodexAppServerTransportAndWait(wrapper, { terminateOwnedProcess: true }),
        ).resolves.toEqual({ exited: true, cleanup: mode === "owned" ? "closed" : "uncertain" });

        // A conservative result and physical process exit are separate facts.
        const after = await processSnapshot.readCodexAppServerProcessSnapshot();
        expect(after.some((row) => row.pid === wrapper.pid)).toBe(false);
        expect(
          after.some(
            (row) =>
              row.pid === descendantPid &&
              row.startedAt === descendant?.startedAt &&
              !processSnapshot.isDeadProcessState(row.state),
          ),
        ).toBe(false);
        expect(await listProcesses(tempDir)).toEqual([]);
      } finally {
        restoreContainment?.();
        restoreKill?.();
        await removeTaskOwnedFixtureProcesses(tempDir);
        await wrapperClosed;
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    },
  );

  it.each([
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
  ] as const)("revalidates identities while quiescing: %s", async (mode, sentinelSurvived) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-identity-reuse-"));
    const rootPath = path.join(tempDir, "root.mjs");
    const sentinelPath = path.join(tempDir, "sentinel.mjs");
    const sentinelPidPath = path.join(tempDir, "sentinel.pid");
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
import { writeFileSync } from "node:fs";
const [sentinelPath, sentinelPidPath] = process.argv.slice(2);
const sentinel = spawn(process.execPath, [sentinelPath], { detached: true, stdio: "ignore" });
sentinel.unref();
writeFileSync(sentinelPidPath, String(sentinel.pid));
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
`,
    );
    const root = spawn(process.execPath, [rootPath, sentinelPath, sentinelPidPath], {
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let restoreInspection: (() => void) | undefined;
    try {
      let sentinelPid: number | undefined;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const contents = await fs.readFile(sentinelPidPath, "utf8").catch(() => "");
        if (contents) {
          sentinelPid = Number(contents);
          break;
        }
        await delay(20);
      }
      const initial = await processSnapshot.readCodexAppServerProcessSnapshot();
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
      const stoppedOldSentinel = { ...oldSentinel, state: "T" };
      const stoppedSentinel = { ...sentinelIdentity, state: "T" };
      const runningTree = [rootIdentity, sentinelIdentity];
      const rootStoppedTree = [stoppedRoot, sentinelIdentity];
      const stoppedTree = [stoppedRoot, stoppedSentinel];
      const scenarios: Record<typeof mode, Array<PosixProcess[] | undefined | "deadline">> = {
        reuse: [
          [rootIdentity, oldSentinel],
          [rootIdentity, oldSentinel],
          [stoppedRoot, oldSentinel],
          [stoppedRoot, oldSentinel],
          [stoppedRoot, stoppedOldSentinel],
          stoppedTree,
        ],
        late: [[rootIdentity], [rootIdentity], rootStoppedTree, rootStoppedTree, stoppedTree],
        reparented: [
          runningTree,
          runningTree,
          rootStoppedTree,
          rootStoppedTree,
          [stoppedRoot, { ...stoppedSentinel, ppid: 1, pgid: stoppedSentinel.pgid + 1 }],
        ],
        "root-resumed": [
          runningTree,
          runningTree,
          runningTree,
          runningTree,
          rootStoppedTree,
          rootStoppedTree,
          stoppedTree,
        ],
        traced: [
          runningTree,
          runningTree,
          rootStoppedTree,
          rootStoppedTree,
          [stoppedRoot, { ...stoppedSentinel, state: "t" }],
        ],
        uninterruptible: [
          runningTree,
          runningTree,
          [stoppedRoot, { ...sentinelIdentity, state: "U" }],
          [stoppedRoot, { ...sentinelIdentity, state: "U" }],
        ],
        "unconfirmed-termination": [
          runningTree,
          runningTree,
          [stoppedRoot, { ...sentinelIdentity, state: "U" }],
          [stoppedRoot, { ...sentinelIdentity, state: "U" }],
        ],
        "snapshot-failure": [runningTree, runningTree, rootStoppedTree, rootStoppedTree, undefined],
        "inspection-timeout": [runningTree, runningTree, "deadline"],
        extended: [
          runningTree,
          runningTree,
          ...Array.from({ length: 16 }, () => rootStoppedTree),
          stoppedTree,
        ],
      };
      const snapshots = scenarios[mode];
      let inspection = 0;
      let descendantSignalled = false;
      const actualSnapshot = processSnapshot.readCodexAppServerProcessSnapshot;
      const actualProcess = processSnapshot.readCodexAppServerProcess;
      let rootStopObserved = false;
      const actualKill = process.kill.bind(process);
      const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        const signalled = actualKill(pid, signal);
        if (pid === sentinelPid && signal === "SIGKILL") {
          descendantSignalled = true;
        }
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
          await delay(Math.max(1, inspectionDeadline - Date.now()));
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
      const snapshotSpy = vi
        .spyOn(processSnapshot, "readCodexAppServerProcessSnapshot")
        .mockImplementation((inspectionDeadline, pids) =>
          readSnapshot(inspectionDeadline ?? Date.now() + 2_000, pids),
        );
      const processSpy = vi
        .spyOn(processSnapshot, "readCodexAppServerProcess")
        .mockImplementation(async (pid, inspectionDeadline) =>
          (await readSnapshot(inspectionDeadline, [pid]))?.find((row) => row.pid === pid),
        );
      restoreInspection = () => {
        snapshotSpy.mockRestore();
        processSpy.mockRestore();
        killSpy.mockRestore();
      };
      const closed = await closeCodexAppServerTransportAndWait(root, {
        forceKillDelayMs: 500,
        exitTimeoutMs: 2_000,
      });
      restoreInspection();
      expect(closed).toEqual({
        exited: true,
        cleanup: sentinelSurvived || mode === "unconfirmed-termination" ? "uncertain" : "closed",
      });
      expect(root.exitCode).toBe(0);
      const survived = (await listProcesses(tempDir)).some(
        (row) => row.pid === sentinelPid && row.command.includes(tempDir),
      );
      expect(survived).toBe(sentinelSurvived);
      if (mode === "snapshot-failure" || mode === "inspection-timeout") {
        const sentinel = await processSnapshot.readCodexAppServerProcess(
          sentinelIdentity.pid,
          Date.now() + 2_000,
        );
        expect(sentinel).toBeDefined();
        expect(sentinel?.state).not.toMatch(/^[Tt]/);
      }
    } finally {
      restoreInspection?.();
      await removeTaskOwnedFixtureProcesses(tempDir);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
