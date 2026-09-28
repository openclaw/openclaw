import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { collectErrorGraphCandidates } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  openOpenClawStateDatabase,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { getFileLockProcessStartTime } from "openclaw/plugin-sdk/process-runtime";
import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  configureMemoryCoreDreamingState,
  memoryCoreWorkspaceStateKey,
  openMemoryCoreStateStore,
  SHORT_TERM_LOCK_MAX_ENTRIES,
  SHORT_TERM_LOCK_NAMESPACE,
} from "./dreaming-state.js";
import {
  withMemoryWorkspaceLock,
  withMemoryWorkspacePreparation,
} from "./memory-workspace-lock.js";
import {
  auditShortTermPromotionArtifacts,
  repairShortTermPromotionArtifacts,
} from "./short-term-promotion-artifacts.js";
import type { ShortTermLockEntry } from "./short-term-promotion-types.js";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
  shortTermTestState as testing,
} from "./test-helpers.js";

describe("memory workspace lock orphan recovery", () => {
  let fixtureRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    await configureMemoryCoreDreamingStateForTests();
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lock-"));
  });

  afterAll(async () => {
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
    resetMemoryCoreDreamingStateForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function makeWorkspace(): Promise<string> {
    const workspaceDir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(path.join(workspaceDir, "memory", ".dreams"), { recursive: true });
    return workspaceDir;
  }

  it("waits for an active short-term lock before repairing", async () => {
    const workspaceDir = await makeWorkspace();
    await testing.writeRawRecallStore(workspaceDir, {
      version: 1,
      updatedAt: "2026-04-04T00:00:00.000Z",
      entries: {
        bad: {
          path: "",
        },
      },
    });
    const acquiredAt = Date.now();
    const activeLock = { owner: `${process.pid}:${acquiredAt}`, acquiredAt };
    await testing.writeShortTermLock(workspaceDir, activeLock);

    const blocked = createDeferred<void>();
    const lockKey = memoryCoreWorkspaceStateKey(workspaceDir);
    let activeObservations = 0;
    configureMemoryCoreDreamingState(<T>(options: OpenKeyedStoreOptions) => {
      const store = createPluginStateKeyedStoreForTests<T>("memory-core", options);
      return {
        ...store,
        async observe(...args: Parameters<typeof store.observe>) {
          const observation = await store.observe(...args);
          if (
            options.namespace === SHORT_TERM_LOCK_NAMESPACE &&
            args[0] === lockKey &&
            activeObservations < 2
          ) {
            expect(observation.value).toEqual(activeLock);
            if (++activeObservations === 2) {
              blocked.resolve();
            }
          }
          return observation;
        },
      };
    });
    let settled = false;
    const repairPromise = repairShortTermPromotionArtifacts({ workspaceDir }).then((result) => {
      settled = true;
      return result;
    });
    try {
      // A second real observation proves the owner waited and kept the active lock intact.
      await Promise.race([
        blocked.promise,
        repairPromise.then(() => {
          throw new Error("Repair completed before observing the active lock");
        }),
      ]);
      expect(settled).toBe(false);

      await testing.deleteShortTermLock(workspaceDir);
      const repair = await repairPromise;

      expect(repair.changed).toBe(true);
      expect(repair.rewroteStore).toBe(true);
      expect(repair.removedInvalidEntries).toBe(1);
    } finally {
      await testing.deleteShortTermLock(workspaceDir);
      await Promise.allSettled([repairPromise]);
      await configureMemoryCoreDreamingStateForTests();
    }
  });

  it("keeps preparations and writers in the same local FIFO", async () => {
    const workspace = await makeWorkspace();
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const order: string[] = [];
    const first = withMemoryWorkspacePreparation(workspace, async () => {
      order.push("first preparation");
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const writer = withMemoryWorkspaceLock(workspace, async () => {
      order.push("writer");
    });
    const last = withMemoryWorkspacePreparation(workspace, async () => {
      order.push("last preparation");
    });
    try {
      await nextTurn();
      expect(order).toEqual(["first preparation"]);
    } finally {
      release.resolve();
      await Promise.all([first, writer, last]);
    }
    expect(order).toEqual(["first preparation", "writer", "last preparation"]);
  });

  it("reenters a live write scope and serializes sibling preparations", async () => {
    const workspace = await makeWorkspace();
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const order: string[] = [];
    await withMemoryWorkspaceLock(workspace, async () => {
      const first = withMemoryWorkspacePreparation(workspace, async () => {
        order.push("first");
        entered.resolve();
        await release.promise;
        await withMemoryWorkspacePreparation(workspace, async () => {
          order.push("nested");
        });
      });
      const second = withMemoryWorkspacePreparation(workspace, async () => {
        order.push("second");
      });
      try {
        await entered.promise;
        await nextTurn();
        expect(order).toEqual(["first"]);
      } finally {
        release.resolve();
        await Promise.all([first, second]);
      }
    });
    expect(order).toEqual(["first", "nested", "second"]);
  });

  it("queues preparation resumed from an expired write scope behind the current writer", async () => {
    const workspace = await makeWorkspace();
    const resume = createDeferred<void>();
    const attempted = createDeferred<void>();
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const order: string[] = [];
    const retained = await withMemoryWorkspaceLock(workspace, async () => ({
      task: resume.promise.then(async () => {
        attempted.resolve();
        await withMemoryWorkspacePreparation(workspace, async () => {
          order.push("preparation");
        });
      }),
    }));
    const writer = withMemoryWorkspaceLock(workspace, async () => {
      entered.resolve();
      await release.promise;
      order.push("writer");
    });
    try {
      await entered.promise;
      resume.resolve();
      await attempted.promise;
      await nextTurn();
      expect(order).toEqual([]);
    } finally {
      release.resolve();
      await Promise.all([writer, retained.task]);
    }
    expect(order).toEqual(["writer", "preparation"]);
  });

  it("reports unavailable storage with the original SQLite busy cause", async () => {
    const workspace = await makeWorkspace();
    const blocker = new DatabaseSync(openOpenClawStateDatabase().path);
    const task = vi.fn(async () => "unreachable");
    try {
      blocker.exec("PRAGMA busy_timeout = 0");
      blocker.exec("BEGIN EXCLUSIVE");
      const failure = await withMemoryWorkspaceLock(workspace, task).catch(
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({
        code: "MEMORY_WORKSPACE_LOCK_STORE_UNAVAILABLE",
        outcome: { kind: "store-unavailable", reason: "storage-error" },
      });
      expect(collectErrorGraphCandidates(failure, (record) => [record.cause])).toContainEqual(
        expect.objectContaining({ errcode: 5 }),
      );
      expect(task).not.toHaveBeenCalled();
    } finally {
      blocker.close();
    }
  });

  it("surfaces SQLite contention after a failed release leaves a fresh local lock", async () => {
    const workspace = await makeWorkspace();
    const store = openMemoryCoreStateStore<ShortTermLockEntry>({
      namespace: SHORT_TERM_LOCK_NAMESPACE,
      maxEntries: SHORT_TERM_LOCK_MAX_ENTRIES,
    });
    const stateBlocker = new DatabaseSync(openOpenClawStateDatabase().path);
    try {
      await expect(
        withMemoryWorkspaceLock(workspace, async () => {
          stateBlocker.exec("PRAGMA busy_timeout = 0");
          stateBlocker.exec("BEGIN EXCLUSIVE");
          return "completed";
        }),
      ).resolves.toBe("completed");
    } finally {
      stateBlocker.close();
    }
    const key = memoryCoreWorkspaceStateKey(workspace);
    expect(await store.lookup(key)).toMatchObject({
      owner: expect.stringMatching(`${process.pid}:`),
    });

    const dataPath = path.join(workspace, "locked.sqlite");
    const data = new DatabaseSync(dataPath);
    const dataBlocker = new DatabaseSync(dataPath);
    try {
      data.exec("CREATE TABLE entries (value TEXT)");
      data.exec("PRAGMA busy_timeout = 0");
      dataBlocker.exec("BEGIN EXCLUSIVE");
      await expect(
        withMemoryWorkspaceLock(workspace, async () => {
          data.exec("INSERT INTO entries VALUES ('pending')");
        }),
      ).rejects.toMatchObject({ errcode: 5 });
    } finally {
      dataBlocker.close();
      data.close();
    }
    expect(await store.lookup(key)).toBeUndefined();
  });

  it("reclaims a stale legacy lock after its process id is reused", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    const workspaceDir = await makeWorkspace();
    await testing.writeShortTermLock(workspaceDir, {
      owner: `${process.pid}:${now - 120_000}`,
      acquiredAt: now - 120_000,
    });

    const result = withMemoryWorkspaceLock(workspaceDir, async () => "recovered").then(
      (value) => ({ status: "resolved" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error: String(error) }),
    );
    await vi.advanceTimersByTimeAsync(10_040);

    expect(await result).toEqual({ status: "resolved", value: "recovered" });
  });

  it("reclaims a stale lock when a live process id has a different start identity", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    const ownerStartTime = getFileLockProcessStartTime(process.ppid);
    expect(ownerStartTime).not.toBeNull();
    if (ownerStartTime === null) {
      throw new Error("Expected the test runner process start identity");
    }
    const workspaceDir = await makeWorkspace();
    await testing.writeShortTermLock(workspaceDir, {
      owner: `${process.ppid}:${now - 120_000}`,
      ownerStartTime: ownerStartTime + 1,
      acquiredAt: now - 120_000,
    });

    const result = withMemoryWorkspaceLock(workspaceDir, async () => "recovered").then(
      (value) => ({ status: "resolved" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error: String(error) }),
    );
    await vi.advanceTimersByTimeAsync(10_040);

    expect(await result).toEqual({ status: "resolved", value: "recovered" });
  });

  it("keeps a stale-looking lock while its owner task is active", async () => {
    const workspaceDir = await makeWorkspace();
    let enteredResolve: (() => void) | undefined;
    let releaseResolve: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    const owner = withMemoryWorkspaceLock(workspaceDir, async () => {
      enteredResolve?.();
      await release;
    });
    await entered;

    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 120_000);
    try {
      const audit = await auditShortTermPromotionArtifacts({ workspaceDir });
      expect(audit.issues.map((issue) => issue.code)).not.toContain("recall-lock-stale");
    } finally {
      vi.restoreAllMocks();
      releaseResolve?.();
      await owner;
    }
  });
});
