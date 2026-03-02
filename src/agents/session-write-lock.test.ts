import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// Mock getProcessStartTime so PID-recycling detection works on non-Linux
// (macOS, CI runners). isPidAlive is left unmocked.
const FAKE_STARTTIME = 12345;
vi.mock("../shared/pid-alive.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../shared/pid-alive.js")>();
  return {
    ...original,
    getProcessStartTime: (pid: number) => (pid === process.pid ? FAKE_STARTTIME : null),
  };
});

import {
  __testing,
  acquireSessionWriteLock,
  cleanStaleLockFiles,
  resolveSessionLockMaxHoldFromTimeout,
} from "./session-write-lock.js";

async function expectLockRemovedOnlyAfterFinalRelease(params: {
  lockPath: string;
  firstLock: { release: () => Promise<void> };
  secondLock: { release: () => Promise<void> };
}) {
  await expect(fs.access(params.lockPath)).resolves.toBeUndefined();
  await params.firstLock.release();
  await expect(fs.access(params.lockPath)).resolves.toBeUndefined();
  await params.secondLock.release();
  await expect(fs.access(params.lockPath)).rejects.toThrow();
}

async function expectCurrentPidOwnsLock(params: {
  sessionFile: string;
  timeoutMs: number;
  staleMs?: number;
}) {
  const { sessionFile, timeoutMs, staleMs } = params;
  const lockPath = `${sessionFile}.lock`;
  const lock = await acquireSessionWriteLock({ sessionFile, timeoutMs, staleMs });
  const raw = await fs.readFile(lockPath, "utf8");
  const payload = JSON.parse(raw) as { pid: number };
  expect(payload.pid).toBe(process.pid);
  await lock.release();
}

describe("acquireSessionWriteLock", () => {
  it("reuses locks across symlinked session paths", async () => {
    if (process.platform === "win32") {
      expect(true).toBe(true);
      return;
    }

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-"));
    try {
      const realDir = path.join(root, "real");
      const linkDir = path.join(root, "link");
      await fs.mkdir(realDir, { recursive: true });
      await fs.symlink(realDir, linkDir);

      const sessionReal = path.join(realDir, "sessions.json");
      const sessionLink = path.join(linkDir, "sessions.json");

      const lockA = await acquireSessionWriteLock({ sessionFile: sessionReal, timeoutMs: 500 });
      const lockB = await acquireSessionWriteLock({ sessionFile: sessionLink, timeoutMs: 500 });

      await lockB.release();
      await lockA.release();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the lock file until the last release", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-"));
    try {
      const sessionFile = path.join(root, "sessions.json");
      const lockPath = `${sessionFile}.lock`;

      const lockA = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });
      const lockB = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });

      await expectLockRemovedOnlyAfterFinalRelease({
        lockPath,
        firstLock: lockA,
        secondLock: lockB,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reclaims stale lock files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-"));
    try {
      const sessionFile = path.join(root, "sessions.json");
      const lockPath = `${sessionFile}.lock`;
      await fs.writeFile(
        lockPath,
        JSON.stringify({ pid: 123456, createdAt: new Date(Date.now() - 60_000).toISOString() }),
        "utf8",
      );

      await expectCurrentPidOwnsLock({ sessionFile, timeoutMs: 500, staleMs: 10 });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not reclaim fresh malformed lock files during contention", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-"));
    try {
      const sessionFile = path.join(root, "sessions.json");
      const lockPath = `${sessionFile}.lock`;
      await fs.writeFile(lockPath, "{}", "utf8");

      await expect(
        acquireSessionWriteLock({ sessionFile, timeoutMs: 50, staleMs: 60_000 }),
      ).rejects.toThrow(/session file locked/);
      await expect(fs.access(lockPath)).resolves.toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reclaims malformed lock files once they are old enough", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-"));
    try {
      const sessionFile = path.join(root, "sessions.json");
      const lockPath = `${sessionFile}.lock`;
      await fs.writeFile(lockPath, "{}", "utf8");
      const staleDate = new Date(Date.now() - 2 * 60_000);
      await fs.utimes(lockPath, staleDate, staleDate);

      const lock = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500, staleMs: 10_000 });
      await lock.release();
      await expect(fs.access(lockPath)).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("watchdog releases stale in-process locks", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const sessionFile = path.join(root, "session.jsonl");
      const lockPath = `${sessionFile}.lock`;
      const lockA = await acquireSessionWriteLock({
        sessionFile,
        timeoutMs: 500,
        maxHoldMs: 1,
      });

      const released = await __testing.runLockWatchdogCheck(Date.now() + 1000);
      expect(released).toBeGreaterThanOrEqual(1);
      await expect(fs.access(lockPath)).rejects.toThrow();

      const lockB = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });
      await expect(fs.access(lockPath)).resolves.toBeUndefined();

      // Old release handle must not affect the new lock.
      await expectLockRemovedOnlyAfterFinalRelease({
        lockPath,
        firstLock: lockA,
        secondLock: lockB,
      });
    } finally {
      warnSpy.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("derives max hold from timeout plus grace", () => {
    expect(resolveSessionLockMaxHoldFromTimeout({ timeoutMs: 600_000 })).toBe(720_000);
    expect(resolveSessionLockMaxHoldFromTimeout({ timeoutMs: 1_000, minMs: 5_000 })).toBe(121_000);
  });

  it("clamps max hold for effectively no-timeout runs", () => {
    expect(
      resolveSessionLockMaxHoldFromTimeout({
        timeoutMs: 2_147_000_000,
      }),
    ).toBe(2_147_000_000);
  });

  it("cleans stale .jsonl lock files in sessions directories", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-"));
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const nowMs = Date.now();
    const staleDeadLock = path.join(sessionsDir, "dead.jsonl.lock");
    const staleAliveLock = path.join(sessionsDir, "old-live.jsonl.lock");
    const freshAliveLock = path.join(sessionsDir, "fresh-live.jsonl.lock");

    try {
      await fs.writeFile(
        staleDeadLock,
        JSON.stringify({
          pid: 999_999,
          createdAt: new Date(nowMs - 120_000).toISOString(),
        }),
        "utf8",
      );
      await fs.writeFile(
        staleAliveLock,
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date(nowMs - 120_000).toISOString(),
        }),
        "utf8",
      );
      await fs.writeFile(
        freshAliveLock,
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date(nowMs - 1_000).toISOString(),
        }),
        "utf8",
      );

      const result = await cleanStaleLockFiles({
        sessionsDir,
        staleMs: 30_000,
        nowMs,
        removeStale: true,
      });

      expect(result.locks).toHaveLength(3);
      expect(result.cleaned).toHaveLength(2);
      expect(result.cleaned.map((entry) => path.basename(entry.lockPath)).toSorted()).toEqual([
        "dead.jsonl.lock",
        "old-live.jsonl.lock",
      ]);

      await expect(fs.access(staleDeadLock)).rejects.toThrow();
      await expect(fs.access(staleAliveLock)).rejects.toThrow();
      await expect(fs.access(freshAliveLock)).resolves.toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("removes held locks on termination signals", async () => {
    const signals = ["SIGINT", "SIGTERM", "SIGQUIT", "SIGABRT"] as const;
    const originalKill = process.kill.bind(process);
    process.kill = ((_pid: number, _signal?: NodeJS.Signals) => true) as typeof process.kill;
    try {
      for (const signal of signals) {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-cleanup-"));
        try {
          const sessionFile = path.join(root, "sessions.json");
          const lockPath = `${sessionFile}.lock`;
          await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });
          const keepAlive = () => {};
          if (signal === "SIGINT") {
            process.on(signal, keepAlive);
          }

          __testing.handleTerminationSignal(signal);

          await expect(fs.stat(lockPath)).rejects.toThrow();
          if (signal === "SIGINT") {
            process.off(signal, keepAlive);
          }
        } finally {
          await fs.rm(root, { recursive: true, force: true });
        }
      }
    } finally {
      process.kill = originalKill;
    }
  });

  it("reclaims lock files with recycled PIDs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-"));
    try {
      const sessionFile = path.join(root, "sessions.json");
      const lockPath = `${sessionFile}.lock`;
      // Write a lock with a live PID (current process) but a wrong starttime,
      // simulating PID recycling: the PID is alive but belongs to a different
      // process than the one that created the lock.
      await fs.writeFile(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString(),
          starttime: 999_999_999,
        }),
        "utf8",
      );

      await expectCurrentPidOwnsLock({ sessionFile, timeoutMs: 500 });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not reclaim lock files without starttime (backward compat)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-"));
    try {
      const sessionFile = path.join(root, "sessions.json");
      const lockPath = `${sessionFile}.lock`;
      // Old-format lock without starttime — should NOT be reclaimed just because
      // starttime is missing. The PID is alive, so the lock is valid.
      await fs.writeFile(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString(),
        }),
        "utf8",
      );

      await expect(acquireSessionWriteLock({ sessionFile, timeoutMs: 50 })).rejects.toThrow(
        /session file locked/,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not treat malformed starttime as recycled", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-"));
    try {
      const sessionFile = path.join(root, "sessions.json");
      const lockPath = `${sessionFile}.lock`;
      await fs.writeFile(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString(),
          starttime: 123.5,
        }),
        "utf8",
      );

      await expect(acquireSessionWriteLock({ sessionFile, timeoutMs: 50 })).rejects.toThrow(
        /session file locked/,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("registers cleanup for SIGQUIT and SIGABRT", () => {
    expect(__testing.cleanupSignals).toContain("SIGQUIT");
    expect(__testing.cleanupSignals).toContain("SIGABRT");
  });
  it("cleans up locks on SIGINT without removing other handlers", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-"));
    const originalKill = process.kill.bind(process);
    const killCalls: Array<NodeJS.Signals | undefined> = [];
    let otherHandlerCalled = false;

    process.kill = ((pid: number, signal?: NodeJS.Signals) => {
      killCalls.push(signal);
      return true;
    }) as typeof process.kill;

    const otherHandler = () => {
      otherHandlerCalled = true;
    };

    process.on("SIGINT", otherHandler);

    try {
      const sessionFile = path.join(root, "sessions.json");
      const lockPath = `${sessionFile}.lock`;
      await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });

      process.emit("SIGINT");

      await expect(fs.access(lockPath)).rejects.toThrow();
      expect(otherHandlerCalled).toBe(true);
      expect(killCalls).toEqual([]);
    } finally {
      process.off("SIGINT", otherHandler);
      process.kill = originalKill;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("cleans up locks on exit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-"));
    try {
      const sessionFile = path.join(root, "sessions.json");
      const lockPath = `${sessionFile}.lock`;
      await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });

      process.emit("exit", 0);

      await expect(fs.access(lockPath)).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("keeps other signal listeners registered", () => {
    const keepAlive = () => {};
    process.on("SIGINT", keepAlive);

    __testing.handleTerminationSignal("SIGINT");

    expect(process.listeners("SIGINT")).toContain(keepAlive);
    process.off("SIGINT", keepAlive);
  });
});
