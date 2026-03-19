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

async function withTempSessionLockFile(
  run: (params: { root: string; sessionFile: string; lockPath: string }) => Promise<void>,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-"));
  try {
    const sessionFile = path.join(root, "sessions.json");
    await run({ root, sessionFile, lockPath: `${sessionFile}.lock` });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function writeCurrentProcessLock(lockPath: string, extra?: Record<string, unknown>) {
  await fs.writeFile(
    lockPath,
    JSON.stringify({
      pid: process.pid,
      createdAt: new Date().toISOString(),
      ...extra,
    }),
    "utf8",
  );
}

async function expectActiveInProcessLockIsNotReclaimed(params?: {
  legacyStarttime?: unknown;
}): Promise<void> {
  await withTempSessionLockFile(async ({ sessionFile, lockPath }) => {
    const lock = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });
    const lockPayload = {
      pid: process.pid,
      createdAt: new Date().toISOString(),
      ...(params && "legacyStarttime" in params ? { starttime: params.legacyStarttime } : {}),
    };
    await fs.writeFile(lockPath, JSON.stringify(lockPayload), "utf8");

    await expect(
      acquireSessionWriteLock({
        sessionFile,
        timeoutMs: 50,
        allowReentrant: false,
      }),
    ).rejects.toThrow(/session file locked/);
    await lock.release();
  });
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
    await withTempSessionLockFile(async ({ sessionFile, lockPath }) => {
      const lockA = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });
      const lockB = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });

      await expectLockRemovedOnlyAfterFinalRelease({
        lockPath,
        firstLock: lockA,
        secondLock: lockB,
      });
    });
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
    await withTempSessionLockFile(async ({ sessionFile, lockPath }) => {
      await fs.writeFile(lockPath, "{}", "utf8");
      const staleDate = new Date(Date.now() - 2 * 60_000);
      await fs.utimes(lockPath, staleDate, staleDate);

      const lock = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500, staleMs: 10_000 });
      await lock.release();
      await expect(fs.access(lockPath)).rejects.toThrow();
    });
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
    const freshAliveSession = path.join(sessionsDir, "fresh-live.jsonl");
    const freshAliveLock = `${freshAliveSession}.lock`;

    // Create the session file so acquireSessionWriteLock can work
    await fs.writeFile(freshAliveSession, "", "utf8");

    // Acquire a real lock to populate HELD_LOCKS - this is necessary because
    // locks with matching PID + starttime but NOT in HELD_LOCKS are treated
    // as orphans (orphan-self-pid detection for lost in-memory state).
    const heldLock = await acquireSessionWriteLock({
      sessionFile: freshAliveSession,
      timeoutMs: 30_000,
    });

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
      // freshAliveLock is already written by acquireSessionWriteLock above

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
      await heldLock.release();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("cleans orphan self-lock files during cleanup even when timestamp is fresh", async () => {
    // This test covers the case where the gateway process lost in-memory
    // HELD_LOCKS state but the lock file still references the current PID
    // with a fresh timestamp. At startup, HELD_LOCKS is empty, so any lock
    // owned by the current PID should be treated as orphaned.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-orphan-self-"));
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const nowMs = Date.now();
    // Fresh timestamp (only 1 second old), but not in HELD_LOCKS
    const orphanSelfLock = path.join(sessionsDir, "orphan-self.jsonl.lock");

    try {
      await fs.writeFile(
        orphanSelfLock,
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date(nowMs - 1_000).toISOString(),
          // Note: no starttime field, which makes shouldTreatAsOrphanSelfLock return true
        }),
        "utf8",
      );

      const result = await cleanStaleLockFiles({
        sessionsDir,
        staleMs: 30_000, // 30 seconds - the lock is only 1 second old
        nowMs,
        removeStale: true,
      });

      expect(result.locks).toHaveLength(1);
      expect(result.cleaned).toHaveLength(1);
      expect(result.cleaned[0].staleReasons).toContain("orphan-self-pid");
      await expect(fs.access(orphanSelfLock)).rejects.toThrow();
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
    await withTempSessionLockFile(async ({ sessionFile, lockPath }) => {
      // Write a lock with a live PID (current process) but a wrong starttime,
      // simulating PID recycling: the PID is alive but belongs to a different
      // process than the one that created the lock.
      await writeCurrentProcessLock(lockPath, { starttime: 999_999_999 });

      await expectCurrentPidOwnsLock({ sessionFile, timeoutMs: 500 });
    });
  });

  it("reclaims orphan lock files without starttime when PID matches current process", async () => {
    await withTempSessionLockFile(async ({ sessionFile, lockPath }) => {
      // Simulate an old-format lock file left behind by a previous process
      // instance that reused the same PID (common in containers).
      await writeCurrentProcessLock(lockPath);

      await expectCurrentPidOwnsLock({ sessionFile, timeoutMs: 500 });
    });
  });

  it("does not reclaim active in-process lock files without starttime", async () => {
    await expectActiveInProcessLockIsNotReclaimed();
  });

  it("does not reclaim active in-process lock files with malformed starttime", async () => {
    await expectActiveInProcessLockIsNotReclaimed({ legacyStarttime: 123.5 });
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
    await withTempSessionLockFile(async ({ sessionFile, lockPath }) => {
      await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });

      process.emit("exit", 0);

      await expect(fs.access(lockPath)).rejects.toThrow();
    });
  });
  it("keeps other signal listeners registered", () => {
    const keepAlive = () => {};
    process.on("SIGINT", keepAlive);

    __testing.handleTerminationSignal("SIGINT");

    expect(process.listeners("SIGINT")).toContain(keepAlive);
    process.off("SIGINT", keepAlive);
  });
});

it("cleans orphan self-lock files with matching starttime (Linux-realistic scenario)", async () => {
  // This test covers the Linux-realistic scenario where the lock file has a
  // valid starttime that matches the current process. On Linux, getProcessStartTime
  // always returns a value, so every lock file will have starttime set.
  // The fix must detect these as orphans by comparing starttime values.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-orphan-starttime-"));
  const sessionsDir = path.join(root, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });

  const nowMs = Date.now();
  const orphanWithStarttime = path.join(sessionsDir, "orphan-with-starttime.jsonl.lock");

  try {
    await fs.writeFile(
      orphanWithStarttime,
      JSON.stringify({
        pid: process.pid,
        createdAt: new Date(nowMs - 1_000).toISOString(),
        // Include starttime matching the current process (via mock: FAKE_STARTTIME = 12345)
        // This simulates a Linux environment where starttime is always written.
        starttime: 12345,
      }),
      "utf8",
    );

    const result = await cleanStaleLockFiles({
      sessionsDir,
      staleMs: 30_000, // 30 seconds - the lock is only 1 second old
      nowMs,
      removeStale: true,
    });

    // Should still be cleaned because it's not in HELD_LOCKS
    expect(result.locks).toHaveLength(1);
    expect(result.cleaned).toHaveLength(1);
    expect(result.cleaned[0].staleReasons).toContain("orphan-self-pid");
    await expect(fs.access(orphanWithStarttime)).rejects.toThrow();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("cleans lock with recycled PID using recycled-pid reason (not orphan-self-pid)", async () => {
  // When the lock file has the current PID but a DIFFERENT starttime, the PID
  // was recycled — this lock belongs to a dead process with the same PID.
  // inspectLockPayload detects this via "recycled-pid" reason, NOT orphan-self-pid.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pid-recycled-"));
  try {
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const recycledPidLock = path.join(sessionsDir, "recycled-pid.jsonl.lock");
    const nowMs = Date.now();
    // Use a different starttime (99999 vs mock's 12345) to simulate PID recycle
    const differentStarttime = 99999;
    await fs.writeFile(
      recycledPidLock,
      JSON.stringify({
        pid: process.pid,
        createdAt: new Date(nowMs - 1000).toISOString(), // 1 second ago, fresh timestamp
        starttime: differentStarttime,
      }),
    );

    const result = await cleanStaleLockFiles({
      sessionsDir,
      staleMs: 60_000,
      nowMs,
    });

    // The lock is cleaned because inspectLockPayload detects recycled PID.
    // The reason should be "recycled-pid", NOT "orphan-self-pid".
    expect(result.locks).toHaveLength(1);
    expect(result.cleaned).toHaveLength(1);
    expect(result.cleaned[0].staleReasons).toContain("recycled-pid");
    expect(result.cleaned[0].staleReasons).not.toContain("orphan-self-pid");
    // Lock should be removed
    await expect(fs.access(recycledPidLock)).rejects.toThrow();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
