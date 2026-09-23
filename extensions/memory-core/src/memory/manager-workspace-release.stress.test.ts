import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { DatabaseSync } from "node:sqlite";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { openOpenClawStateDatabase } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseByPathAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it, vi } from "vitest";
import {
  memoryCoreWorkspaceStateKey,
  openMemoryCoreStateStore,
  SHORT_TERM_LOCK_MAX_ENTRIES,
  SHORT_TERM_LOCK_NAMESPACE,
} from "../dreaming-state.js";
import {
  deleteShortTermLockEntryIfCurrent,
  withMemoryWorkspaceLock,
} from "../memory-workspace-lock.js";
import type { ShortTermLockEntry } from "../short-term-promotion-types.js";
import { configureMemoryCoreDreamingStateForTests } from "../test-helpers.js";
import * as cpu from "./manager-cpu-worker-runtime.js";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("memory workspace release recovery", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });

  it("recovers the next sync after a settled SQLite lease-release failure", async () => {
    const cfg = fixture.createConfig({
      provider: "none",
      sources: ["memory"],
      vectorEnabled: false,
    });
    const manager = await fixture.getFreshManager(cfg, "cli");
    await manager.sync({ reason: "cli", force: true });
    const database = Reflect.get(manager, "db") as DatabaseSync;
    const readPublished = () =>
      database.prepare("SELECT path, text FROM memory_index_chunks ORDER BY path, id").all();
    const publishedBeforeFailure = readPublished();
    expect(publishedBeforeFailure.length).toBeGreaterThan(0);
    const state = openOpenClawStateDatabase();
    const key = memoryCoreWorkspaceStateKey(fixture.paths.workspace);
    const locks = openMemoryCoreStateStore<ShortTermLockEntry>({
      namespace: SHORT_TERM_LOCK_NAMESPACE,
      maxEntries: SHORT_TERM_LOCK_MAX_ENTRIES,
    });
    await fs.writeFile(
      path.join(fixture.paths.memory, "2026-01-12.md"),
      "# Log\nCerulean corrected memory survives recovery.\n",
    );
    state.db.exec(`
      CREATE TRIGGER fail_memory_workspace_release BEFORE DELETE ON plugin_state_entries
      WHEN OLD.plugin_id = 'memory-core' AND OLD.namespace = 'short-term-locks'
      BEGIN SELECT RAISE(ABORT, 'injected workspace cleanup failure'); END;
    `);
    const timings: Record<string, unknown> = {};
    try {
      const started = performance.now();
      const failed = await manager.sync({ reason: "cli", force: true }).then(
        () => undefined,
        (error: unknown) => error,
      );
      timings.initialFailureMs = performance.now() - started;
      timings.initialError = String(failed);
      expect(failed).toBeInstanceOf(Error);
      expect(readPublished()).toEqual(publishedBeforeFailure);
      state.db.exec("DROP TRIGGER fail_memory_workspace_release");
      const orphan = await locks.lookup(key);
      timings.orphanAgeMs = orphan ? Date.now() - orphan.acquiredAt : null;
      timings.orphanOwnerMatchesProcess = orphan?.owner.startsWith(`${process.pid}:`);
      expect(orphan).toBeDefined();

      const retryStarted = performance.now();
      const retry = await manager.sync({ reason: "cli", force: true }).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error: String(error) }),
      );
      timings.retryMs = performance.now() - retryStarted;
      timings.retry = retry;
      console.log("memory-workspace-release-stress", JSON.stringify(timings));
      expect(retry).toEqual({ ok: true });
      expect(readPublished()).toEqual([
        {
          path: "memory/2026-01-12.md",
          text: expect.stringContaining("Cerulean corrected memory survives recovery."),
        },
      ]);
      expect(await locks.lookup(key)).toBeUndefined();
      expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      await manager.close();
      const reopened = await fixture.getFreshManager(cfg, "cli");
      expect((await reopened.search("Cerulean")).length).toBeGreaterThan(0);
    } finally {
      state.db.exec("DROP TRIGGER IF EXISTS fail_memory_workspace_release");
      const orphan = await locks.lookup(key);
      if (orphan) {
        await deleteShortTermLockEntryIfCurrent(locks, key, orphan);
      }
    }
  });

  it("recovers after a real external state writer exceeds lease cleanup's SQLite budget", async () => {
    const cfg = fixture.createConfig({
      provider: "none",
      sources: ["memory"],
      vectorEnabled: false,
    });
    const manager = await fixture.getFreshManager(cfg, "cli");
    await manager.sync({ reason: "cli", force: true });
    const database = Reflect.get(manager, "db") as DatabaseSync;
    const readPublished = () =>
      database.prepare("SELECT path, text FROM memory_index_chunks ORDER BY path, id").all();
    const original = readPublished();
    await manager.sync({ reason: "cli", force: true });
    expect(readPublished()).toEqual(original);
    const state = openOpenClawStateDatabase();
    const key = memoryCoreWorkspaceStateKey(fixture.paths.workspace);
    const locks = openMemoryCoreStateStore<ShortTermLockEntry>({
      namespace: SHORT_TERM_LOCK_NAMESPACE,
      maxEntries: SHORT_TERM_LOCK_MAX_ENTRIES,
    });
    expect(await locks.lookup(key)).toBeUndefined();
    await fs.writeFile(
      path.join(fixture.paths.memory, "2026-01-12.md"),
      "# Log\nCerulean updated memory after external contention.\n",
    );
    let writer: ChildProcessWithoutNullStreams | undefined;
    let writerExited: Promise<number | null> | undefined;
    let writerStderr = "";
    const writerEvents: string[] = [];
    const prepare = cpu.prepareMemoryIndexInWorker;
    const gate = vi.spyOn(cpu, "prepareMemoryIndexInWorker").mockImplementation(async (input) => {
      const result = await prepare(input);
      if (writer || input.source !== "memory") {
        return result;
      }
      const held = createDeferred<void>();
      writer = spawn(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `
            import { DatabaseSync } from "node:sqlite";
            const db = new DatabaseSync(process.argv[1]);
            db.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
            process.stdout.write("held\\n");
            const release = () => {
              db.exec("ROLLBACK");
              db.close();
              process.stdout.write("released\\n");
              process.exit(0);
            };
            const timer = setTimeout(release, 6500);
            process.stdin.on("end", () => { clearTimeout(timer); release(); });
            process.stdin.resume();
          `,
          path.join(fixture.paths.stateDir, "state", "openclaw.sqlite"),
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      writer.stderr.setEncoding("utf8");
      createInterface({ input: writer.stdout }).on("line", (line) => {
        writerEvents.push(line);
        if (line === "held") {
          held.resolve();
        }
      });
      writer.stderr.on("data", (chunk: string) => {
        writerStderr += chunk;
      });
      writer.once("error", held.reject);
      writerExited = new Promise((resolve) => {
        writer!.once("close", (code) => {
          held.reject(new Error(`State contention child exited ${code}: ${writerStderr}`));
          resolve(code);
        });
      });
      await held.promise;
      return result;
    });
    const timings: Record<string, unknown> = {};
    try {
      const started = performance.now();
      const initial = await manager.sync({ reason: "cli", force: true }).then(
        () => undefined,
        (error: unknown) => error,
      );
      timings.initialMs = performance.now() - started;
      timings.initialError = String(initial);
      expect(await writerExited).toBe(0);
      expect(writerEvents).toEqual(["held", "released"]);
      gate.mockRestore();
      const expectedPublication = [
        {
          path: "memory/2026-01-12.md",
          text: expect.stringContaining("Cerulean updated memory after external contention."),
        },
      ];
      if (initial === undefined) {
        expect(readPublished()).toEqual(expectedPublication);
        expect(await locks.lookup(key)).toBeUndefined();
      } else {
        expect(initial).toBeInstanceOf(Error);
        expect(readPublished()).toEqual(original);
      }
      const orphan = await locks.lookup(key);
      timings.orphanAgeMs = orphan ? Date.now() - orphan.acquiredAt : null;
      timings.orphanOwnerMatchesProcess = orphan?.owner.startsWith(`${process.pid}:`);
      expect(state.db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      const retryStarted = performance.now();
      const retry = await manager.sync({ reason: "cli", force: true }).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error: String(error) }),
      );
      timings.retryMs = performance.now() - retryStarted;
      timings.retry = retry;
      console.log("memory-workspace-contention-stress", JSON.stringify(timings));
      expect(retry).toEqual({ ok: true });
      expect(readPublished()).toEqual(expectedPublication);
      expect(await locks.lookup(key)).toBeUndefined();
      await manager.close();
      const reopened = await fixture.getFreshManager(cfg, "cli");
      expect((await reopened.search("Cerulean")).length).toBeGreaterThan(0);
    } finally {
      gate.mockRestore();
      if (writer && writer.exitCode === null) {
        writer.stdin.end();
      }
      await writerExited;
      const orphan = await locks.lookup(key);
      if (orphan) {
        await deleteShortTermLockEntryIfCurrent(locks, key, orphan);
      }
    }
  });

  it("keeps a completed receipt bound to its original physical state database", async () => {
    const workspace = fixture.paths.workspace;
    const key = memoryCoreWorkspaceStateKey(workspace);
    const originalState = openOpenClawStateDatabase();
    const originalLocks = openMemoryCoreStateStore<ShortTermLockEntry>({
      namespace: SHORT_TERM_LOCK_NAMESPACE,
      maxEntries: SHORT_TERM_LOCK_MAX_ENTRIES,
    });
    const otherEnv = {
      ...process.env,
      OPENCLAW_STATE_DIR: path.join(fixture.paths.root, "other-state"),
    };
    let otherLocks: ReturnType<typeof openMemoryCoreStateStore<ShortTermLockEntry>> | undefined;
    try {
      await withMemoryWorkspaceLock(workspace, async () => {
        originalState.db.exec(`
          CREATE TRIGGER fail_memory_workspace_release BEFORE DELETE ON plugin_state_entries
          WHEN OLD.plugin_id = 'memory-core' AND OLD.namespace = 'short-term-locks'
          BEGIN SELECT RAISE(ABORT, 'injected workspace cleanup failure'); END;
        `);
      });
      originalState.db.exec("DROP TRIGGER fail_memory_workspace_release");
      const completed = await originalLocks.lookup(key);
      expect(completed).toBeDefined();
      if (!completed) {
        throw new Error("Expected the retained completed lease");
      }

      await configureMemoryCoreDreamingStateForTests(otherEnv);
      otherLocks = openMemoryCoreStateStore<ShortTermLockEntry>({
        namespace: SHORT_TERM_LOCK_NAMESPACE,
        maxEntries: SHORT_TERM_LOCK_MAX_ENTRIES,
      });
      await otherLocks.register(key, completed);
      const otherTask = vi.fn(async () => "must not run");
      await expect(withMemoryWorkspaceLock(workspace, otherTask)).rejects.toMatchObject({
        code: "MEMORY_WORKSPACE_LOCK_STORE_UNAVAILABLE",
        outcome: { kind: "store-unavailable", reason: "storage-error" },
        cause: { code: "PLUGIN_STATE_INVALID_INPUT" },
      });
      expect(otherTask).not.toHaveBeenCalled();
      expect(await otherLocks.lookup(key)).toEqual(completed);
      expect(await originalLocks.lookup(key)).toEqual(completed);

      await configureMemoryCoreDreamingStateForTests();
      await expect(withMemoryWorkspaceLock(workspace, async () => "recovered")).resolves.toBe(
        "recovered",
      );
      expect(await originalLocks.lookup(key)).toBeUndefined();
      expect(await otherLocks.lookup(key)).toEqual(completed);
      expect(originalState.db.prepare("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
      expect(
        openOpenClawStateDatabase({ env: otherEnv }).db.prepare("PRAGMA integrity_check").get(),
      ).toEqual({ integrity_check: "ok" });
    } finally {
      await configureMemoryCoreDreamingStateForTests();
      try {
        originalState.db.exec("DROP TRIGGER IF EXISTS fail_memory_workspace_release");
        for (const store of [originalLocks, otherLocks]) {
          const entry = await store?.lookup(key);
          if (store && entry) {
            await deleteShortTermLockEntryIfCurrent(store, key, entry);
          }
        }
      } finally {
        await closeOpenClawStateDatabaseByPathAsync(
          path.join(otherEnv.OPENCLAW_STATE_DIR, "state", "openclaw.sqlite"),
        );
      }
    }
  });
});
