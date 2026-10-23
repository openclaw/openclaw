import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  execution,
  lifecycleSession,
  lifecycleSnapshot,
  serviceContext,
} from "./lifecycle-sync-fixtures.test-support.js";
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
const context = serviceContext();
type LifecycleParams = Parameters<typeof createWorkboardLifecycleService>[0];
let dir: string;
let stores: ReturnType<typeof createWorkboardSqliteStores>;
let store: WorkboardStore;
let service: ReturnType<typeof createWorkboardLifecycleService> | undefined;
let removeIfLossless: Mock<NonNullable<LifecycleParams["worktrees"]>["removeIfLossless"]>;

function openStore() {
  stores = createWorkboardSqliteStores({
    dbPath: path.join(dir, "workboard.sqlite"),
    workerModuleUrl,
  });
  store = new WorkboardStore(stores.cards, sqliteTestAuxStores(stores));
}
async function stop() {
  service?.onGatewayStop();
  await service?.stop?.(context);
  service = undefined;
}
async function restart() {
  await stop();
  await stores.close();
  openStore();
}
async function start(readSessions: LifecycleParams["readSessions"]) {
  service = createWorkboardLifecycleService({
    store,
    readSessions,
    worktrees: { removeIfLossless },
  });
  await store.ready();
  await service.start(context);
  service.onGatewayStart();
}
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-cleanup-"));
  removeIfLossless = vi.fn().mockResolvedValue(true);
  openStore();
});
afterEach(async () => {
  try {
    await stop();
  } finally {
    await stores.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function createManagedCard(
  options: {
    managedPath?: string;
    status?: "blocked" | "running" | "review";
  } = {},
) {
  const status = options.status ?? "running";
  return await store.create({
    title: "Recover managed worktree cleanup",
    status,
    ...(status !== "blocked"
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

const doneSessionSnapshot = (updatedAt: number) =>
  vi.fn().mockResolvedValue(lifecycleSnapshot(lifecycleSession(SESSION_KEY, "done", updatedAt)));

async function expectCleaned(id: string, calls = 1) {
  await vi.waitFor(async () => {
    expect(removeIfLossless).toHaveBeenCalledTimes(calls);
    expect((await store.get(id))?.metadata?.automation?.workspace).toEqual({
      kind: "worktree",
      path: SOURCE_PATH,
      branch: "main",
    });
  });
}

describe("Workboard managed-worktree cleanup recovery", () => {
  it.each(["running", "blocked"] as const)(
    "cleans a %s worktree during the initial restart sweep",
    async (status) => {
      const card = await createManagedCard({ status });
      await restart();
      const readSessions = status === "blocked" ? vi.fn() : doneSessionSnapshot(card.updatedAt + 1);
      await start(readSessions);
      await expectCleaned(card.id);
      if (status === "blocked") {
        expect(readSessions).not.toHaveBeenCalled();
      }
    },
  );

  it("persists a retained worktree obligation and retries it after restart", async () => {
    const managedPath = path.join(dir, "managed-worktree");
    fs.mkdirSync(managedPath);
    const card = await createManagedCard({ managedPath, status: "review" });
    await restart();
    removeIfLossless.mockResolvedValueOnce(false).mockImplementationOnce(async () => {
      fs.rmSync(managedPath, { recursive: true });
      return true;
    });
    await start(doneSessionSnapshot(card.updatedAt));
    await vi.waitFor(() => expect(removeIfLossless).toHaveBeenCalledOnce());
    await stop();
    expect((await store.get(card.id))?.metadata?.automation?.workspace).toMatchObject({
      path: managedPath,
      sourcePath: SOURCE_PATH,
    });
    await restart();
    await start(doneSessionSnapshot(card.updatedAt));
    await expectCleaned(card.id, 2);
  });

  it("does not clean a matched card after a newer running attempt wins the race", async () => {
    const card = await createManagedCard();
    const newerSessionKey = "agent:newer:subagent:workboard-cleanup-recovery";
    const originalSync = store.syncLifecycle.bind(store);
    vi.spyOn(store, "syncLifecycle").mockImplementationOnce(async (id, input) => {
      await store.update(id, {
        sessionKey: newerSessionKey,
        runId: "newer-run",
        execution: execution(newerSessionKey, "newer-run", "running"),
      });
      return await originalSync(id, input);
    });
    await expect(
      syncWorkboardSubagentEnded({
        store,
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
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "running",
      runId: "newer-run",
      execution: { status: "running", runId: "newer-run" },
    });
  });
});
