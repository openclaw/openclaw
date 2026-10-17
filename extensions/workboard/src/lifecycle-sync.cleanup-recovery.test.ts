import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkboardExecution } from "@openclaw/workboard-contract";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { describe, expect, it, vi } from "vitest";
import { createWorkboardLifecycleService, syncWorkboardSubagentEnded } from "./lifecycle-sync.js";
import { workboardSqliteBackendEntrypoint } from "./sqlite-backend-entrypoint.test-support.js";
import { WorkboardStore } from "./store.js";
import { createWorkboardSqliteStores } from "./test/database-config.js";
import { sqliteTestAuxStores } from "./test/sqlite-store.js";

const workerModuleUrl = resolveRuntimeWorkerUrl(workboardSqliteBackendEntrypoint);
const SESSION_KEY = "agent:main:subagent:workboard-cleanup-recovery";
const RUN_ID = "run-cleanup-recovery";
const MANAGED_PATH = "/state/worktrees/recovery/wb-card";
const SOURCE_PATH = "/repo";
type LifecycleParams = Parameters<typeof createWorkboardLifecycleService>[0];

function openStore(dbPath: string) {
  const stores = createWorkboardSqliteStores({ dbPath, workerModuleUrl });
  return { store: new WorkboardStore(stores.cards, sqliteTestAuxStores(stores)), stores };
}

async function withRecovery(
  run: (fixture: {
    dir: string;
    readonly store: WorkboardStore;
    restart: () => Promise<void>;
    start: (
      readSessions: LifecycleParams["readSessions"],
      removeIfLossless: NonNullable<LifecycleParams["worktrees"]>["removeIfLossless"],
    ) => Promise<void>;
    stop: () => Promise<void>;
  }) => Promise<void>,
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-cleanup-"));
  const dbPath = path.join(dir, "workboard.sqlite");
  let current = openStore(dbPath);
  let service: ReturnType<typeof createWorkboardLifecycleService> | undefined;
  const stop = async () => {
    service?.onGatewayStop();
    await service?.stop?.(context);
    service = undefined;
  };
  try {
    await run({
      dir,
      get store() {
        return current.store;
      },
      stop,
      restart: async () => {
        await stop();
        await current.stores.close();
        current = openStore(dbPath);
      },
      start: async (readSessions, removeIfLossless) => {
        service = createWorkboardLifecycleService({
          store: current.store,
          readSessions,
          worktrees: { removeIfLossless },
        });
        await current.store.ready();
        await service.start(context);
        service.onGatewayStart();
      },
    });
  } finally {
    try {
      await stop();
    } finally {
      await current.stores.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

function execution(
  sessionKey: string,
  runId: string,
  status: WorkboardExecution["status"],
): WorkboardExecution {
  return {
    id: `exec-${runId}`,
    kind: "agent-session",
    mode: "autonomous",
    status,
    sessionKey,
    runId,
    startedAt: 1000,
    updatedAt: 1000,
  };
}

async function createManagedCard(
  store: WorkboardStore,
  options: {
    managedPath?: string;
    status?: "blocked" | "running" | "review";
    withExecutionAssociation?: boolean;
  } = {},
) {
  const status = options.status ?? "running";
  const withExecutionAssociation = options.withExecutionAssociation !== false;
  return await store.create({
    title: "Recover managed worktree cleanup",
    status,
    ...(withExecutionAssociation
      ? {
          sessionKey: SESSION_KEY,
          runId: RUN_ID,
          execution: execution(SESSION_KEY, RUN_ID, status),
        }
      : {}),
    workspace: {
      kind: "worktree",
      path: options.managedPath ?? MANAGED_PATH,
      branch: "openclaw/wb-card",
      sourcePath: SOURCE_PATH,
      sourceBranch: "main",
    },
  });
}

function doneSessionSnapshot(updatedAt: number) {
  return vi.fn().mockResolvedValue({
    sessions: [
      {
        key: SESSION_KEY,
        status: "done" as const,
        hasActiveRun: false,
        updatedAt,
      },
    ],
    complete: true,
  });
}

const context = { logger: { warn: vi.fn() } } as never;

async function expectCleaned(
  store: WorkboardStore,
  id: string,
  remove: ReturnType<typeof vi.fn>,
  calls = 1,
) {
  await vi.waitFor(async () => {
    expect(remove).toHaveBeenCalledTimes(calls);
    expect((await store.get(id))?.metadata?.automation?.workspace).toEqual({
      kind: "worktree",
      path: SOURCE_PATH,
      branch: "main",
    });
  });
}

describe("Workboard managed-worktree cleanup recovery", () => {
  it("cleans a freshly reconciled terminal worktree in the initial restart sweep", async () => {
    await withRecovery(async (db) => {
      const card = await createManagedCard(db.store);
      await db.restart();
      const remove = vi.fn().mockResolvedValue(true);
      await db.start(doneSessionSnapshot(card.updatedAt + 1), remove);
      await expectCleaned(db.store, card.id, remove);
    });
  });

  it("persists a retained worktree obligation and retries it after restart", async () => {
    await withRecovery(async (db) => {
      const managedPath = path.join(db.dir, "managed-worktree");
      fs.mkdirSync(managedPath);
      const card = await createManagedCard(db.store, { managedPath, status: "review" });
      await db.restart();
      const remove = vi
        .fn()
        .mockResolvedValueOnce(false)
        .mockImplementationOnce(async () => {
          fs.rmSync(managedPath, { recursive: true });
          return true;
        });
      await db.start(doneSessionSnapshot(card.updatedAt), remove);
      await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
      await db.stop();
      expect((await db.store.get(card.id))?.metadata?.automation?.workspace).toMatchObject({
        path: managedPath,
        sourcePath: SOURCE_PATH,
      });
      await db.restart();
      await db.start(doneSessionSnapshot(card.updatedAt), remove);
      await expectCleaned(db.store, card.id, remove, 2);
    });
  });

  it("cleans a blocked pre-start worktree without an execution association", async () => {
    await withRecovery(async (db) => {
      const card = await createManagedCard(db.store, {
        status: "blocked",
        withExecutionAssociation: false,
      });
      await db.restart();
      const readSessions = vi.fn();
      const remove = vi.fn().mockResolvedValue(true);
      await db.start(readSessions, remove);
      await vi.waitFor(async () => {
        expect(readSessions).not.toHaveBeenCalled();
        expect(remove).toHaveBeenCalledOnce();
        expect((await db.store.get(card.id))?.metadata?.automation?.workspace).toEqual({
          kind: "worktree",
          path: SOURCE_PATH,
          branch: "main",
        });
      });
    });
  });

  it("does not clean a matched card after a newer running attempt wins the race", async () => {
    await withRecovery(async (db) => {
      const card = await createManagedCard(db.store);
      const newerSessionKey = "agent:newer:subagent:workboard-cleanup-recovery";
      const originalSync = db.store.syncLifecycle.bind(db.store);
      vi.spyOn(db.store, "syncLifecycle").mockImplementationOnce(async (id, input) => {
        await db.store.update(id, {
          sessionKey: newerSessionKey,
          runId: "newer-run",
          execution: execution(newerSessionKey, "newer-run", "running"),
        });
        return await originalSync(id, input);
      });
      const removeIfLossless = vi.fn().mockResolvedValue(true);
      await expect(
        syncWorkboardSubagentEnded({
          store: db.store,
          worktrees: { removeIfLossless },
          event: {
            targetSessionKey: SESSION_KEY,
            runId: RUN_ID,
            endedAt: card.updatedAt + 1,
            outcome: "ok",
          },
        }),
      ).resolves.toBe(0);
      expect(removeIfLossless).not.toHaveBeenCalled();
      await expect(db.store.get(card.id)).resolves.toMatchObject({
        status: "running",
        runId: "newer-run",
        execution: { status: "running", runId: "newer-run" },
      });
    });
  });
});
