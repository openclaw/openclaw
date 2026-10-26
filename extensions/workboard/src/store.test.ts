// Workboard tests cover store plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { MAX_DATE_TIMESTAMP_MS } from "openclaw/plugin-sdk/number-runtime";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersistedWorkboardCard, WorkboardCardStore } from "./persistence-types.js";
import { workboardSqliteBackendEntrypoint } from "./sqlite-backend-entrypoint.test-support.js";
import { MAX_CARD_METADATA_BYTES, MAX_RUN_ID_LENGTH } from "./store-constants.js";
import { contains, expectRejected, expectStored, fakeClock } from "./store-family.test-support.js";
import { WorkboardStore } from "./store.js";
import { createWorkboardSqliteStores } from "./test/database-config.js";
import { codexExecution } from "./test/execution.js";
import { createKernelStores } from "./test/sqlite-kernel.js";
import { sqliteOnly as test } from "./test/sqlite-only.js";
import {
  createWorkboardSqliteTestHarness,
  createWorkboardSqliteTestStore,
  sqliteTestAuxStores,
} from "./test/sqlite-store.js";

const createStore = () => createWorkboardSqliteTestStore({ createStores: createKernelStores });
function createCard(
  storeFixture: WorkboardStore,
  title: string,
  input: Omit<Parameters<WorkboardStore["create"]>[0], "title"> = {},
) {
  return storeFixture.create({ title, ...input });
}

const workerModuleUrl = resolveRuntimeWorkerUrl(workboardSqliteBackendEntrypoint);

function openPersistentStore(dbPath: string) {
  const stores = createWorkboardSqliteStores({ dbPath, workerModuleUrl });
  return Object.assign(new WorkboardStore(stores.cards, sqliteTestAuxStores(stores)), {
    [Symbol.asyncDispose]: () => stores.close(),
  });
}

function createPausedCardStore(delegate: WorkboardCardStore) {
  let pause:
    | {
        reached: () => void;
        waitForResume: Promise<void>;
      }
    | undefined;
  let pauseAfter:
    | {
        matches: (key: string, value: PersistedWorkboardCard | undefined) => boolean;
        reached: () => void;
        waitForResume: Promise<void>;
      }
    | undefined;
  const beforeWrite = async () => {
    const current = pause;
    if (!current) {
      return;
    }
    pause = undefined;
    current.reached();
    await current.waitForResume;
  };
  const afterWrite = async (key: string, value?: PersistedWorkboardCard) => {
    const current = pauseAfter;
    if (!current || !current.matches(key, value)) {
      return;
    }
    pauseAfter = undefined;
    current.reached();
    await current.waitForResume;
  };
  async function write<T>(
    key: string,
    value: PersistedWorkboardCard | undefined,
    perform: () => Promise<T>,
    committed: (result: T) => boolean = () => true,
  ) {
    await beforeWrite();
    const result = await perform();
    if (committed(result)) {
      await afterWrite(key, value);
    }
    return result;
  }
  return {
    store: {
      register: (key, value) => write(key, value, () => delegate.register(key, value)),
      registerIfAbsent: (key, value) =>
        write(key, value, () => delegate.registerIfAbsent(key, value), Boolean),
      registerIfUpdatedAt: (key, value, revision) =>
        write(key, value, () => delegate.registerIfUpdatedAt(key, value, revision), Boolean),
      claimIfOwnerAvailable: (key, value, revision, ownerId, now) =>
        write(
          key,
          value,
          () => delegate.claimIfOwnerAvailable(key, value, revision, ownerId, now),
          (result) => result === "updated",
        ),
      deleteIfUpdatedAt: (key, revision) =>
        write(key, undefined, () => delegate.deleteIfUpdatedAt(key, revision), Boolean),
      lookup: (key) => delegate.lookup(key),
      delete: (key) => write(key, undefined, () => delegate.delete(key), Boolean),
      entries: (boardId) => delegate.entries(boardId),
      listCardStatuses: (ids) => delegate.listCardStatuses(ids),
      listBoardAggregates: () => delegate.listBoardAggregates(),
      listStatsAggregates: (boardId) => delegate.listStatsAggregates(boardId),
      hasCards: (boardId) => delegate.hasCards(boardId),
    } satisfies WorkboardCardStore,
    pauseNextWrite() {
      const reached = createDeferred<void>();
      const resume = createDeferred<void>();
      pause = { reached: () => reached.resolve(), waitForResume: resume.promise };
      return { reached: reached.promise, resume: () => resume.resolve() };
    },
    pauseAfterMatchingWrite(
      matches: (key: string, value: PersistedWorkboardCard | undefined) => boolean,
    ) {
      const reached = createDeferred<void>();
      const resume = createDeferred<void>();
      pauseAfter = { matches, reached: () => reached.resolve(), waitForResume: resume.promise };
      return { reached: reached.promise, resume: () => resume.resolve() };
    },
  };
}

function createConcurrentSqliteHarness(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(dir, "workboard.sqlite");
  const operationStores = createWorkboardSqliteStores({ dbPath, workerModuleUrl });
  const hostStores = createWorkboardSqliteStores({ dbPath, workerModuleUrl });
  const paused = createPausedCardStore(operationStores.cards);
  return {
    operation: new WorkboardStore(paused.store, sqliteTestAuxStores(operationStores)),
    host: new WorkboardStore(hostStores.cards, sqliteTestAuxStores(hostStores)),
    paused,
    async [Symbol.asyncDispose]() {
      await hostStores.close();
      await operationStores.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function metadataPressure() {
  return {
    artifacts: Array.from({ length: 12 }, (_, index) => ({
      id: `artifact-${index}`,
      createdAt: index + 1,
      url: `https://example.com/${index}/${"x".repeat(1900)}`,
    })),
  };
}

describe("WorkboardStore", () => {
  it("emits monotonic committed changes, ignores no-ops, and isolates listener failures", async () => {
    const store = createStore();
    const changes = vi.fn();
    changes.mockImplementation(() => {
      throw new Error("listener failed");
    });
    store.onChange = changes;
    const card = await createCard(store, "Idempotent", { idempotencyKey: "same" });
    await createCard(store, "Duplicate", { idempotencyKey: "same" });
    await store.delete("missing");
    expect(card.title).toBe("Idempotent");
    expect(changes).toHaveBeenCalledOnce();
    await store.update(card.id, { notes: "updated" });
    await store.list();
    await expectRejected(store.update("missing", { notes: "failed" }), "card not found");
    expect(changes.mock.calls.map(([change]) => change.revision)).toEqual([1, 2]);
    expect(changes.mock.calls[1]?.[0].epoch).toBe(changes.mock.calls[0]?.[0].epoch);
  });

  it("reports a reference cleanup conflict without overwriting a concurrent peer edit", async () => {
    await using harness = createConcurrentSqliteHarness("openclaw-workboard-delete-references-");
    const parent = await createCard(harness.host, "Selected parent");
    const child = await createCard(harness.host, "Selected child");
    const unrelated = await createCard(harness.host, "Unrelated");
    await harness.host.linkCards(parent.id, child.id);
    const deleted = harness.paused.pauseAfterMatchingWrite(
      (key, value) => key === parent.id && value === undefined,
    );
    const pending = harness.operation.delete(parent.id);
    const outcome = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await deleted.reached;
    const cleanup = harness.paused.pauseNextWrite();
    deleted.resume();
    await cleanup.reached;

    await harness.host.addComment(child.id, { body: "Keep this external comment" });
    const beforeCleanup = await harness.host.addLink(child.id, {
      targetCardId: unrelated.id,
      type: "relates_to",
    });
    cleanup.resume();
    const result = await outcome;
    expect(result).toMatchObject({
      error: { name: "WorkboardCardConflictError", current: beforeCleanup },
    });
    const current = await harness.host.get(child.id);
    expect(current).toEqual(beforeCleanup);
    await expect(harness.host.get(parent.id)).resolves.toBeUndefined();
    await expect(harness.host.get(unrelated.id)).resolves.toEqual(unrelated);
    await expect(
      harness.operation.delete(child.id, { expectedUpdatedAt: current?.updatedAt }),
    ).resolves.toEqual({ deleted: true });
  });

  it.each(["move", "archive", "delete"] as const)(
    "rejects stale %s when another host writes after read",
    async (action) => {
      await using harness = createConcurrentSqliteHarness("openclaw-workboard-action-cas-");
      const base = await createCard(harness.host, "Original", { status: "todo" });
      const options = { expectedUpdatedAt: base.updatedAt };
      const pause = harness.paused.pauseNextWrite();
      const pending = (
        action === "move"
          ? harness.operation.move(base.id, "blocked", 2000, undefined, options)
          : action === "archive"
            ? harness.operation.archive(base.id, true, options)
            : harness.operation.delete(base.id, options)
      ).catch((error: unknown) => error);
      await pause.reached;
      const newer = await harness.host.update(base.id, {
        title: "Host edit",
        labels: ["preserved"],
      });
      pause.resume();
      expect(await pending).toMatchObject({ name: "WorkboardCardConflictError", current: newer });
      await expect(harness.host.get(base.id)).resolves.toEqual(newer);
    },
  );

  it.each(["delete", "claim"] as const)(
    "rejects metadata after a foreign %s wins the comparison",
    async (change) => {
      await using harness = createConcurrentSqliteHarness("openclaw-workboard-metadata-guard-");
      const { operation, host, paused } = harness;
      const base = await createCard(host, "Guard metadata");
      const pause = paused.pauseNextWrite();
      const pending = operation
        .addWorkerLog(base.id, { message: "Stale log" }, { ownerId: "original-worker" })
        .catch((error: unknown) => error);
      await pause.reached;
      if (change === "delete") {
        await host.delete(base.id);
      } else {
        await host.claim(base.id, { ownerId: "foreign-owner" });
      }
      const foreign = await host.get(base.id);
      pause.resume();
      expect(await pending).toMatchObject(
        change === "delete"
          ? { message: `card not found: ${base.id}` }
          : { name: "WorkboardCardConflictError" },
      );
      await expect(host.get(base.id)).resolves.toEqual(foreign);
    },
  );

  it("reports stale revisions before invalid status policy", async () => {
    const store = createStore();
    const base = await createCard(store, "Scheduled", { status: "scheduled" });
    const newer = await store.update(base.id, { title: "Newer scheduled card" });
    await expect(
      store.move(base.id, "running", 0, undefined, { expectedUpdatedAt: base.updatedAt }),
    ).rejects.toMatchObject({ name: "WorkboardCardConflictError", current: newer });
    await expectRejected(
      store.move(base.id, "running", 0, undefined, { expectedUpdatedAt: newer.updatedAt }),
      "card is scheduled for later.",
    );
    await expect(store.get(base.id)).resolves.toEqual(newer);
  });

  it.each([false, true])(
    "preserves the winning cross-host session capture with archived=%s",
    async (archived) => {
      await using harness = createConcurrentSqliteHarness("openclaw-workboard-capture-");
      const { operation: first, host: second, paused } = harness;
      const sessionKey = archived
        ? "agent:main:dashboard:archived-race"
        : `agent:main:dashboard:${"x".repeat(480)}`;
      if (archived) {
        const captured = await second.captureSession({ title: "Captured", sessionKey });
        await second.archive(captured.id, true);
      }
      const pause = archived ? paused.pauseNextWrite() : undefined;
      const pending = first
        .captureSession({ title: "Captured by host A", sessionKey, boardId: "ops" })
        .catch((error: unknown) => error);
      if (pause) {
        await pause.reached;
      }
      const right = await second.captureSession({
        title: "Captured by host B",
        sessionKey,
        boardId: "other",
      });
      pause?.resume();
      const result = await pending;
      if (archived) {
        expect(result).toMatchObject({ name: "WorkboardCardConflictError", current: right });
      } else {
        expect(result).toEqual(right);
      }
      await expect(first.get(right.id)).resolves.toEqual(right);
      expect(right.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      if (archived) {
        expect(right.metadata?.archivedAt).toBeUndefined();
      } else {
        expect(["ops", "other"]).toContain(right.metadata?.automation?.boardId);
      }
      await expect(first.list()).resolves.toEqual([right]);
    },
  );

  it("allows only one cross-host claim per owner", async () => {
    await using harness = createConcurrentSqliteHarness("openclaw-workboard-claim-race-");
    const { operation: first, host: second } = harness;
    const firstCard = await createCard(first, "First", { status: "ready", agentId: "worker" });
    const secondCard = await createCard(first, "Second", { status: "ready", agentId: "worker" });

    const claims = await Promise.allSettled([
      first.claim(firstCard.id, { ownerId: "worker" }),
      second.claim(secondCard.id, { ownerId: "worker" }),
    ]);

    expect(claims.filter((claim) => claim.status === "fulfilled")).toHaveLength(1);
    expect(claims.filter((claim) => claim.status === "rejected")).toHaveLength(1);
    expect((await first.list()).filter((card) => card.status === "running")).toHaveLength(1);
  });

  test("keeps SQLite files private, tables strict, and unresolved executions intact on reopen", async () => {
    const dir = tempDirs.make("openclaw-workboard-sqlite-");
    const dbPath = path.join(dir, "workboard.sqlite");
    if (process.platform !== "win32") {
      fs.chmodSync(dir, 0o755);
    }
    let id: string;
    {
      await using store = openPersistentStore(dbPath);
      const card = await createCard(store, "Unresolved runtime", {
        execution: {
          id: "exec-unresolved",
          kind: "agent-session",
          mode: "autonomous",
          status: "running",
          startedAt: 3,
          updatedAt: 4,
        },
      });
      id = card.id;
      if (process.platform !== "win32") {
        expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
        expect(fs.statSync(dbPath).mode & 0o777).toBe(0o600);
        for (const suffix of ["-wal", "-shm", "-journal"]) {
          const sidecar = dbPath + suffix;
          if (fs.existsSync(sidecar)) {
            expect(fs.statSync(sidecar).mode & 0o777).toBe(0o600);
          }
        }
      }
    }
    {
      using db = new DatabaseSync(dbPath);
      expect(db.prepare("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: "wal" });
      expect(
        db
          .prepare(`SELECT name FROM pragma_table_list
        WHERE schema = 'main' AND type = 'table'
          AND name NOT LIKE 'sqlite_%' AND strict <> 1`)
          .all(),
      ).toEqual([]);
      expect(() =>
        db
          .prepare("INSERT INTO workboard_attachment_blobs (attachment_id, content) VALUES (?, ?)")
          .run("wrong-type", "text-not-blob"),
      ).toThrow();
    }
    {
      await using reopened = openPersistentStore(dbPath);
      const execution = (await reopened.get(id))?.execution;
      expect(execution).toMatchObject({
        id: "exec-unresolved",
        mode: "autonomous",
        status: "running",
      });
      expect(execution).not.toHaveProperty("engine");
      expect(execution).not.toHaveProperty("model");
    }
  });

  // Corrupt child rows must not affect aggregate-only reads.
  test("lists sqlite board summaries without hydrating card child rows", async () => {
    const dbPath = path.join(tempDirs.make("openclaw-workboard-summary-"), "workboard.sqlite");
    let cardId: string;
    {
      await using initial = openPersistentStore(dbPath);
      await initial.upsertBoard({ id: "ops", name: "Ops" });
      const card = await createCard(initial, "Summarize me", { boardId: "ops" });
      cardId = card.id;
      await initial.addComment(card.id, { body: "valid before corruption" });
      const archived = await createCard(initial, "Archived", { boardId: "ops", status: "ready" });
      await initial.archive(archived.id, true);
    }
    {
      using raw = new DatabaseSync(dbPath);
      raw.prepare("UPDATE workboard_card_comments SET body = '' WHERE card_id = ?").run(cardId);
    }
    await using reopened = openPersistentStore(dbPath);
    await expectRejected(reopened.get(cardId), /missing body/);
    await expect(reopened.listBoards()).resolves.toMatchObject({
      boards: contains({
        id: "ops",
        name: "Ops",
        total: 2,
        active: 1,
        archived: 1,
        byStatus: { ready: 1, todo: 1 },
      }),
    });
  });

  it("preserves legacy empty board appearance and persists explicit clears", async () => {
    const dir = tempDirs.make("openclaw-workboard-appearance-");
    const dbPath = path.join(dir, "workboard.sqlite");
    {
      await using store = openPersistentStore(dbPath);
      await store.upsertBoard({ id: "planning", name: "Planning", icon: "rocket", color: "blue" });
      expect(await store.upsertBoard({ id: "planning", name: "Renamed" })).toMatchObject({
        name: "Renamed",
        icon: "rocket",
        color: "blue",
      });
      for (const value of [null, "", "   "]) {
        expect(
          await store.upsertBoard({ id: "planning", icon: value, color: value }),
        ).toMatchObject({ icon: "rocket", color: "blue" });
      }
      const withoutIcon = await store.upsertBoard({
        id: "planning",
        icon: "ignored replacement",
        clearAppearance: ["icon"],
      });
      expect(withoutIcon.icon).toBeUndefined();
      expect(withoutIcon.color).toBe("blue");
      const withoutColor = await store.upsertBoard({ id: "planning", clearAppearance: ["color"] });
      expect(withoutColor.icon).toBeUndefined();
      expect(withoutColor.color).toBeUndefined();
    }
    {
      await using store = openPersistentStore(dbPath);
      const board = (await store.listBoards()).boards.find((item) => item.id === "planning");
      expect(board).toMatchObject({ name: "Renamed" });
      expect(board?.icon).toBeUndefined();
      expect(board?.color).toBeUndefined();
    }
  });

  it.each([
    {
      patch: { clearAppearance: ["name"] },
      existing: true,
      message: "clearAppearance must be an array",
    },
    { patch: { automationJobId: "" }, existing: false, message: "non-empty string" },
    {
      patch: { automationJobId: "x".repeat(129) },
      existing: false,
      message: "128 characters or fewer",
    },
  ])(
    "rejects invalid board patch $patch without modifying existing appearance",
    async ({ patch, existing, message }) => {
      const store = createStore();
      if (existing) {
        await store.upsertBoard({ id: "planning", icon: "rocket", color: "blue" });
      }
      await expectRejected(store.upsertBoard({ id: "planning", ...patch }), message);
      if (existing) {
        expect(
          (await store.listBoards()).boards.find((board) => board.id === "planning"),
        ).toMatchObject({ icon: "rocket", color: "blue" });
      }
    },
  );

  it("creates and lists cards by status order and position", async () => {
    const store = createStore();

    const review = await createCard(store, "Review release notes", {
      status: "review",
      priority: "high",
      labels: "release, docs",
    });
    const todo = await createCard(store, "Fix dashboard copy", { status: "todo", position: 0 });
    expect(todo.position).toBe(0);
    expect(todo.metadata).toBeUndefined();

    expect((await store.list()).map((card) => card.id)).toEqual([todo.id, review.id]);
    expect(review).toMatchObject({ labels: ["release", "docs"], priority: "high" });
    expect(review.events?.[0]).toMatchObject({ kind: "created", toStatus: "review" });
  });

  it("ignores dependency links from generic metadata writes", async () => {
    const store = createStore();
    const parent = await createCard(store, "Parent");
    const child = await createCard(store, "Child", {
      metadata: {
        links: [{ id: "raw-parent", type: "parent", targetCardId: parent.id, createdAt: 1 }],
      },
    });

    expect(child.metadata?.links).toBeUndefined();

    const updated = await store.update(child.id, {
      metadata: {
        links: [{ id: "raw-parent-2", type: "parent", targetCardId: parent.id, createdAt: 2 }],
      },
    });
    expect(updated.metadata?.links).toBeUndefined();
  });

  it("only accepts workspace authority from trusted top-level provenance", async () => {
    const store = createStore();
    const card = await createCard(store, "Restricted card", {
      workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
      metadata: { automation: { workspaceAccess: { unrestricted: true } } },
    });

    expect(card.metadata?.automation?.workspaceAccess).toEqual({
      unrestricted: false,
      roots: ["/workspace"],
      writable: true,
    });

    const updated = await store.update(card.id, {
      metadata: { automation: { workspaceAccess: { unrestricted: true } } },
    });
    expect(updated.metadata?.automation?.workspaceAccess).toEqual({
      unrestricted: false,
      roots: ["/workspace"],
      writable: true,
    });

    const untrusted = await createCard(store, "Untrusted metadata", {
      metadata: { automation: { workspaceAccess: { unrestricted: true } } },
    });
    expect(untrusted.metadata?.automation?.workspaceAccess).toBeUndefined();
  });

  it("only accepts launch state from store-owned transitions", async () => {
    const store = createStore();
    const card = await createCard(store, "Trusted launch", {
      status: "ready",
      workspaceAccess: { unrestricted: true },
      metadata: {
        automation: {
          launch: {
            phase: "prepared",
            requestedSessionKey: "injected-session",
            provisionalRunId: "injected-run",
            preparedAt: 1,
          },
        },
      },
    });
    expect(card.metadata?.automation?.launch).toBeUndefined();

    const claimed = await store.claim(card.id, { ownerId: "worker", token: "claim-token" });
    const prepared = await store.prepareExecutionLaunch(card.id, {
      requestedSessionKey: "subagent:workboard-default-trusted",
      now: 100,
      scope: { ownerId: "worker", token: claimed.token },
    });
    const updated = await store.update(card.id, {
      metadata: {
        automation: {
          launch: {
            ...prepared.launch,
            phase: "accepted",
            acceptedAt: 101,
            acceptedSessionKey: "agent:injected:subagent:workboard-default-trusted",
            acceptedRunId: "injected-accepted-run",
          },
        },
      },
    });

    expect(updated.metadata?.automation?.launch).toEqual(prepared.launch);

    const runId = "r".repeat(164);
    const sessionKey = "agent:worker:subagent:workboard-default-trusted";
    await store.acceptExecutionLaunch(card.id, {
      expectedLaunch: prepared.launch,
      expectedSessionKey: prepared.launch.requestedSessionKey,
      expectedRunId: prepared.launch.provisionalRunId,
      sessionKey,
      runId,
      execution: codexExecution("accepted-exec", 100, { sessionKey, runId }),
      acceptedAt: prepared.launch.preparedAt + 1,
    });
    expect((await store.get(card.id))?.metadata?.automation?.launch).toMatchObject({
      phase: "accepted",
      acceptedRunId: runId,
    });
  });

  it("does not let a delayed launch failure overwrite a newer retry", async () => {
    const store = createStore();
    const card = await createCard(store, "Retried launch", { status: "ready" });
    const firstClaim = await store.claim(card.id, { ownerId: "worker" });
    const first = await store.prepareExecutionLaunch(card.id, {
      requestedSessionKey: "subagent:workboard-default-retried",
      now: 100,
      scope: { ownerId: "worker", token: firstClaim.token },
    });
    await store.failPreparedLaunch(card.id, {
      expectedLaunch: first.launch,
      reason: "first launch failed",
      failedAt: 101,
    });
    await store.unblock(card.id);
    const retryClaim = await store.claim(card.id, { ownerId: "worker" });
    const retry = await store.prepareExecutionLaunch(card.id, {
      requestedSessionKey: "subagent:workboard-default-retried",
      now: 200,
      scope: { ownerId: "worker", token: retryClaim.token },
    });

    await expect(
      store.failPreparedLaunch(card.id, {
        expectedLaunch: first.launch,
        reason: "delayed first failure",
        failedAt: 201,
      }),
    ).resolves.toBe(false);
    await expect(
      store.syncLifecycle(card.id, {
        targetStatus: "review",
        executionStatus: "review",
        sourceUpdatedAt: undefined,
        stale: undefined,
        now: 202,
        association: {
          expectedSessionKey: retry.launch.requestedSessionKey,
          expectedRunId: retry.launch.provisionalRunId,
          sessionKey: `agent:worker:${retry.launch.requestedSessionKey}`,
          acceptedAt: 150,
        },
      }),
    ).resolves.toBe(false);
    expect((await store.get(card.id))?.metadata?.automation?.launch).toEqual(retry.launch);
  });

  it("moves cards and records lifecycle timestamps", async () => {
    const store = createStore();
    const card = await createCard(store, "Ship workboard", { execution: {} });
    expect(card.execution).toBeUndefined();

    const running = await store.move(card.id, "running", 500);
    expect(running.startedAt).toBeGreaterThanOrEqual(card.createdAt);
    expect(running).toMatchObject({ status: "running", position: 500 });
    expect(running.events?.at(-1)).toMatchObject({
      kind: "moved",
      fromStatus: "todo",
      toStatus: "running",
    });

    const done = await store.update(card.id, { status: "done" });
    expect(done.completedAt).toBeGreaterThanOrEqual(done.startedAt ?? 0);

    const rolledBack = await store.update(card.id, {
      status: "todo",
      startedAt: null,
      completedAt: null,
    });
    expect(rolledBack.startedAt).toBeUndefined();
    expect(rolledBack.completedAt).toBeUndefined();
  });

  it("does not let one stale bulk lifecycle patch strip later card updates", async () => {
    using clock = fakeClock();
    clock.set(1000);

    const store = createWorkboardSqliteTestStore();
    const staleCard = await createCard(store, "Stale bulk target");
    const freshCard = await createCard(store, "Fresh bulk target");
    clock.set(3000);
    await store.move(staleCard.id, "running", 1000);

    const patch = {
      status: "review",
      metadata: { lifecycleStatusSourceUpdatedAt: 2000 },
    } as const;
    const result = await store.bulkUpdate({ ids: [staleCard.id, freshCard.id], patch });

    expect(result.cards[0]).toMatchObject({ id: staleCard.id, status: "running" });
    expect(result.cards[0]?.metadata?.lifecycleStatusSourceUpdatedAt).toBeUndefined();
    expect(result.cards[1]).toMatchObject({ id: freshCard.id, status: "review" });
    expect(result.cards[1]?.metadata?.lifecycleStatusSourceUpdatedAt).toBe(2000);
    expect(patch).toEqual({
      status: "review",
      metadata: { lifecycleStatusSourceUpdatedAt: 2000 },
    });
  });

  it("keeps non-status fields from stale lifecycle patches", async () => {
    const store = createStore();
    const card = await createCard(store, "Keep stale sync details", {
      execution: codexExecution("exec-1", 1, {
        sessionKey: "agent:main:dashboard:1",
        runId: "run-1",
        updatedAt: 1000,
      }),
    });
    const lifecycleMoved = await store.update(card.id, {
      status: "review",
      metadata: {
        lifecycleStatusSourceUpdatedAt: 1000,
        stale: {
          detectedAt: 1000,
          lastSessionUpdatedAt: 1000,
          reason: "Session has not reported recent activity.",
        },
      },
    });
    const manual = await store.update(card.id, {
      status: "running",
      metadata: lifecycleMoved.metadata,
    });

    const synced = await store.update(card.id, {
      status: "review",
      execution: codexExecution("exec-1", 1, {
        status: "done",
        sessionKey: "agent:main:dashboard:1",
        runId: "run-1",
        updatedAt: 2000,
      }),
      metadata: { lifecycleStatusSourceUpdatedAt: 1000, stale: null },
    });

    expect(manual.metadata?.stale).toBeDefined();
    expect(synced.status).toBe("running");
    expect(synced.execution).toMatchObject({ runId: "run-1", status: "done", updatedAt: 2000 });
    expect(synced.metadata?.stale).toBeUndefined();
    expect(synced.metadata?.lifecycleStatusSourceUpdatedAt).toBeUndefined();
    expect(synced.events?.at(-1)).toMatchObject({ kind: "attempt_updated", runId: "run-1" });
  });

  it("keeps execution session links aligned with edited card links", async () => {
    const store = createStore();
    const card = await createCard(store, "Relink me", {
      sessionKey: "agent:main:dashboard:1",
      execution: codexExecution("exec-1", 10, { sessionKey: "agent:main:dashboard:1" }),
    });

    const relinked = await store.update(card.id, { sessionKey: "agent:main:dashboard:2" });
    expect(relinked).toMatchObject({
      sessionKey: "agent:main:dashboard:2",
      execution: { sessionKey: "agent:main:dashboard:2" },
    });
    expect(relinked.events?.at(-1)).toMatchObject({
      kind: "linked",
      sessionKey: "agent:main:dashboard:2",
    });

    const unlinked = await store.update(card.id, { sessionKey: "" });
    expect(unlinked.sessionKey).toBeUndefined();
    expect(unlinked.execution?.sessionKey).toBeUndefined();

    const cleared = await store.update(card.id, { execution: null });
    expect(cleared.execution).toBeUndefined();
  });

  it("adds artifact metadata and records its event", async () => {
    const store = createStore();
    const card = await createCard(store, "Artifact");
    const artifact = { label: "Screenshot", path: "/tmp/workboard.png", mimeType: "image/png" };
    const saved = await store.addArtifact(card.id, artifact);
    expect(saved.metadata?.artifacts?.[0]).toMatchObject(artifact);
    expect(saved.events?.at(-1)).toMatchObject({ kind: "artifact_added" });
  });

  it("retains the correlated proof when metadata budget trimming is required", async () => {
    const store = createStore();
    const card = await createCard(store, "Keep proof under metadata pressure", {
      status: "running",
      metadata: metadataPressure(),
    });
    const claimed = await store.claim(card.id, { ownerId: "main", token: "token-1" });
    const artifactCountBefore = claimed.card.metadata?.artifacts?.length ?? 0;
    expect(artifactCountBefore).toBeGreaterThan(5);

    const proofInput = {
      label: "Worker proof",
      command: "pnpm test extensions/workboard",
      note: "y".repeat(1800),
    };
    const pending = await store.addProof(card.id, proofInput, {
      ownerId: "main",
      token: "token-1",
    });
    const pendingProof = pending.metadata?.proof?.at(-1);
    expect(pending.events?.at(-1)).toMatchObject({ kind: "proof_added" });
    expect(pendingProof).toMatchObject({ status: "unknown", command: proofInput.command });
    await expectRejected(
      store.complete(card.id, { ownerId: "main", token: "token-1", proofId: pendingProof?.id }),
      "proof is required to resolve a pending proof.",
    );
    expect(pending.metadata?.artifacts?.length ?? 0).toBeLessThan(artifactCountBefore);
    expect(Buffer.byteLength(JSON.stringify(pending.metadata), "utf8")).toBeLessThanOrEqual(
      24 * 1024,
    );

    const completed = await store.complete(card.id, {
      ownerId: "main",
      token: "token-1",
      summary: "Proof survived metadata trimming.",
      proofId: pendingProof?.id,
      proof: { ...proofInput, status: "passed" },
    });

    expect(completed.metadata?.proof).toEqual([{ ...pendingProof, status: "passed" }]);
    expect(Buffer.byteLength(JSON.stringify(completed.metadata), "utf8")).toBeLessThanOrEqual(
      24 * 1024,
    );
  });

  it("resolves only correlated proof and refuses to rewrite terminal evidence", async () => {
    const store = createStore();
    const proofInput = { command: "review poem", note: "Checked each line." };
    const older = {
      id: "proof-older",
      status: "unknown" as const,
      createdAt: 1_000,
      ...proofInput,
    };
    const latest = { ...older, id: "proof-latest", createdAt: 2_000 };
    const card = await createCard(store, "Proof history", { metadata: { proof: [older, latest] } });
    await expectRejected(
      store.complete(card.id, {
        proofId: latest.id,
        proof: { status: "passed", command: "different evidence" },
      }),
      "completion proof does not match pending proof: proof-latest",
    );
    await expect(store.get(card.id)).resolves.toEqual(card);

    const completion = { proofId: latest.id, proof: { ...proofInput, status: "passed" } };
    const completed = await store.complete(card.id, completion);
    const expected = [older, { ...latest, status: "passed" }];
    expect(completed.metadata?.proof).toEqual(expected);
    expect((await store.complete(card.id, completion)).metadata?.proof).toEqual(expected);
    const reopened = await store.update(card.id, { status: "todo" });
    await expectRejected(
      store.complete(card.id, { proofId: latest.id, proof: { status: "failed" } }),
      "completion proof status does not match existing proof: proof-latest",
    );
    await expect(store.get(card.id)).resolves.toEqual(reopened);
  });

  it("records worker logs and protocol violations on cards", async () => {
    const store = createStore();
    const card = await createCard(store, "Protocol card", {
      status: "running",
      sessionKey: "session-protocol",
      runId: "run-protocol",
      execution: {
        id: "exec-protocol",
        kind: "agent-session",
        engine: "claude-cli",
        mode: "autonomous",
        status: "running",
        model: "anthropic/claude-sonnet-4-6",
        startedAt: 10,
        updatedAt: 10,
      },
    });

    const logged = await store.addWorkerLog(card.id, {
      level: "warning",
      message: "Worker nearing timeout.",
    });
    expect(logged.metadata?.workerLogs?.[0]).toMatchObject({
      level: "warning",
      message: "Worker nearing timeout.",
    });
    expect(logged.events?.at(-1)).toMatchObject({ kind: "orchestration" });

    const violated = await store.recordProtocolViolation(card.id, {
      detail: "Worker exited without workboard_complete.",
      sessionKey: "observed-session",
      runId: "observed-run",
    });
    expect(violated).toMatchObject({
      status: "blocked",
      execution: { status: "blocked", engine: "claude-cli" },
      metadata: {
        attempts: [{ status: "blocked", error: "Worker exited without workboard_complete." }],
        workerProtocol: { state: "violated", detail: "Worker exited without workboard_complete." },
        failureCount: 1,
        notifications: [{ kind: "failed", sessionKey: "observed-session", runId: "observed-run" }],
      },
    });
    expect(violated.events?.at(-1)).toMatchObject({ kind: "protocol_violation" });
  });

  it("claims cards, heartbeats, and releases the claim", async () => {
    const store = createStore();
    const card = await createCard(store, "Coordinate worker", { status: "todo" });

    const claimed = await store.claim(card.id, { ownerId: "main", ttlSeconds: 60 });

    expect(claimed.token).toBeTruthy();
    expect(claimed.card.status).toBe("running");
    expect(claimed.card.agentId).toBeUndefined();
    expect(claimed.card.metadata?.claim).toMatchObject({ ownerId: "main" });

    await expectRejected(store.claim(card.id, { ownerId: "other" }), /already claimed/);

    const heartbeat = await store.heartbeat(card.id, {
      ownerId: "main",
      note: "Still running tests.",
    });
    expect(heartbeat.events?.at(-1)).toMatchObject({ kind: "heartbeat" });
    expect(heartbeat.metadata?.comments?.at(-1)?.body).toBe("Still running tests.");

    await expectRejected(store.heartbeat(card.id, { ownerId: "other" }), /owner/);

    await expectRejected(
      store.releaseClaim(card.id, { ownerId: "main", status: "invalid" }),
      /status must be one of/,
    );
    expect((await store.get(card.id))?.metadata?.claim).toEqual(heartbeat.metadata?.claim);
    const released = await store.releaseClaim(card.id, { ownerId: "main", status: "review" });
    expect(released.status).toBe("review");
    expect(released.metadata?.claim).toBeUndefined();

    const tokenCard = await createCard(store, "Token-authorized worker", { status: "todo" });
    const tokenClaim = await store.claim(tokenCard.id, { ownerId: "main", ttlSeconds: 60 });

    await expectRejected(
      store.heartbeat(tokenCard.id, { ownerId: "other", token: "wrong-token" }),
      /token does not match/,
    );
    await expect(
      store.heartbeat(tokenCard.id, { ownerId: "other", token: tokenClaim.token }),
    ).resolves.toMatchObject({ metadata: { claim: { ownerId: "main" } } });

    await expectRejected(
      store.releaseClaim(tokenCard.id, { ownerId: "other", token: "wrong-token" }),
      /token does not match/,
    );
    const tokenReleased = await store.releaseClaim(tokenCard.id, {
      ownerId: "other",
      token: tokenClaim.token,
    });
    expect(tokenReleased.metadata?.claim).toBeUndefined();
  });

  it("atomically guards and adopts dispatcher workspace authority", async () => {
    const store = createStore();
    const card = await createCard(store, "Legacy dispatch", { status: "ready" });
    const expectedAuthority = {
      boardId: "default",
      status: card.status,
      agentId: card.agentId,
      workspace: card.metadata?.automation?.workspace,
      workspaceAccess: card.metadata?.automation?.workspaceAccess,
    };
    await store.update(card.id, {
      workspace: { kind: "dir", path: "/restricted" },
      workspaceAccess: { unrestricted: false, roots: ["/restricted"], writable: true },
    });

    await expectRejected(
      store.claim(
        card.id,
        { ownerId: "dispatcher" },
        { expectedAuthority, adoptWorkspaceAccess: { unrestricted: true } },
      ),
      "card workspace authority changed before claim",
    );
    await expectStored(store, card.id, {
      status: "ready",
      metadata: {
        automation: {
          workspaceAccess: { unrestricted: false, roots: ["/restricted"], writable: true },
        },
      },
    });

    const legacy = await createCard(store, "Legacy scratch", { status: "ready" });
    const claimed = await store.claim(
      legacy.id,
      { ownerId: "dispatcher" },
      {
        expectedAuthority: {
          boardId: "default",
          status: legacy.status,
          agentId: legacy.agentId,
          workspace: legacy.metadata?.automation?.workspace,
          workspaceAccess: legacy.metadata?.automation?.workspaceAccess,
        },
        adoptWorkspaceAccess: { unrestricted: true },
      },
    );
    expect(claimed.card.metadata?.automation?.workspaceAccess).toEqual({ unrestricted: true });
  });

  it("protects a running worker's expired claim throughout its heartbeat grace period", async () => {
    using clock = fakeClock();
    clock.set(1_000);

    const store = createWorkboardSqliteTestStore();
    const card = await createCard(store, "Grace-protected worker", { status: "ready" });
    const claimed = await store.claim(card.id, { ownerId: "original", ttlSeconds: 1 });
    const expiresAt = claimed.card.metadata?.claim?.expiresAt;
    if (expiresAt === undefined) {
      throw new Error("expected a timed worker claim");
    }

    clock.set(expiresAt + 1);
    await expectRejected(
      store.claim(card.id, { ownerId: "replacement" }),
      "card already claimed by original.",
    );
    const renewed = await store.heartbeat(card.id, { ownerId: "original", token: claimed.token });
    expect(renewed.metadata?.claim).toMatchObject({
      claimedAt: 1_000,
      lastHeartbeatAt: expiresAt + 1,
      expiresAt: expiresAt + 1 + 1_000,
    });
    clock.set(expiresAt + 501);
    const secondHeartbeat = await store.heartbeat(card.id, { ownerId: "original" });
    expect(secondHeartbeat.metadata?.claim).toMatchObject({
      claimedAt: 1_000,
      lastHeartbeatAt: expiresAt + 501,
      expiresAt: expiresAt + 1_501,
    });
    const renewedExpiresAt = secondHeartbeat.metadata?.claim?.expiresAt;
    if (renewedExpiresAt === undefined) {
      throw new Error("expected the worker heartbeat to renew its claim");
    }

    clock.set(renewedExpiresAt + 5 * 60_000);
    await expectRejected(
      store.claim(card.id, { ownerId: "replacement" }),
      "card already claimed by original.",
    );

    clock.set(renewedExpiresAt + 5 * 60_000 + 1);
    const replacement = await store.claim(card.id, { ownerId: "replacement" });
    expect(replacement.card.metadata?.claim?.ownerId).toBe("replacement");
  });

  it("caps claim expiry to a valid Date timestamp", async () => {
    using clock = fakeClock();
    clock.set(1_000);

    const store = createWorkboardSqliteTestStore();
    const card = await createCard(store, "Bound claim", { status: "todo" });
    const claimed = await store.claim(card.id, { ownerId: "main", ttlSeconds: Number.MAX_VALUE });
    expect(claimed.card.metadata?.claim?.expiresAt).toBe(MAX_DATE_TIMESTAMP_MS);
  });

  it("does not let invalid stored claim expiry block a fresh claim", async () => {
    const store = createStore();
    const card = await createCard(store, "Invalid claim expiry", {
      status: "todo",
      metadata: {
        claim: {
          ownerId: "stale-worker",
          token: "stale-token",
          claimedAt: 1,
          lastHeartbeatAt: 1,
          expiresAt: Number.MAX_VALUE,
        },
      },
    });

    const claimed = await store.claim(card.id, { ownerId: "main", token: "fresh-token" });

    expect(claimed.card.metadata?.claim).toMatchObject({ ownerId: "main", token: "fresh-token" });
  });

  it("accepts POSIX and Windows absolute directory workspaces", async () => {
    const store = createStore();

    for (const workspacePath of [
      "/Users/me/repo",
      String.raw`C:\Users\me\repo`,
      String.raw`\\server\share\repo`,
    ]) {
      const workspace = { kind: "dir", path: workspacePath };
      await expect(createCard(store, workspacePath, { workspace })).resolves.toMatchObject({
        metadata: { automation: { workspace } },
      });
    }
    await expectRejected(
      createCard(store, "Relative workspace", { workspace: { kind: "dir", path: "repo" } }),
      /absolute/,
    );
  });

  it("keeps future scheduled cards scheduled until their time arrives", async () => {
    using clock = fakeClock();
    clock.set(0);

    const store = createWorkboardSqliteTestStore();
    const card = await createCard(store, "Later", { status: "scheduled", scheduledAt: 10_000 });
    const manual = await createCard(store, "Manual scheduled", { status: "scheduled" });
    const implicit = await createCard(store, "Implicit later", { scheduledAt: 10_000 });
    const activeRequested = await createCard(store, "Active requested later", {
      status: "running",
      scheduledAt: 10_000,
      execution: codexExecution("exec-scheduled", 0),
    });
    const parent = await createCard(store, "Parent", { status: "running" });
    const dependent = await createCard(store, "Dependent later", {
      status: "scheduled",
      parents: [parent.id],
      scheduledAt: 10_000,
    });

    expect((await store.dispatch(1_000)).promoted).toEqual([]);
    await expectStored(store, card.id, { status: "scheduled" });
    await expectStored(store, manual.id, { status: "scheduled" });
    await expectStored(store, implicit.id, { status: "scheduled" });
    await expectStored(store, activeRequested.id, { status: "scheduled" });
    expect((await store.get(activeRequested.id))?.execution).toBeUndefined();
    expect((await store.get(activeRequested.id))?.metadata?.attempts).toBeUndefined();
    await expectStored(store, dependent.id, { status: "scheduled" });
    await expectRejected(store.claim(card.id, { ownerId: "main" }), /scheduled/);
    await expectRejected(store.claim(manual.id, { ownerId: "main" }), /scheduled/);
    await expectRejected(store.claim(implicit.id, { ownerId: "main" }), /scheduled/);
    await expectRejected(store.move(manual.id, "running", manual.position), /scheduled/);

    await store.complete(parent.id, { summary: "Parent done." });
    expect((await store.dispatch(5_000)).promoted).toEqual([]);
    await expectStored(store, dependent.id, { status: "scheduled" });

    expect((await store.dispatch(20_000)).promoted).toEqual([
      expect.objectContaining({ id: card.id, status: "ready" }),
      expect.objectContaining({ id: implicit.id, status: "ready" }),
      expect.objectContaining({ id: activeRequested.id, status: "ready" }),
      expect.objectContaining({ id: dependent.id, status: "ready" }),
    ]);
    await expectStored(store, manual.id, { status: "scheduled" });
  });

  it("holds dependent cards out of runnable statuses until parents finish", async () => {
    const store = createStore();
    const parent = await createCard(store, "Parent", { status: "running" });
    const automation = {
      tenant: "release",
      idempotencyKey: "fanout:1",
      skills: ["testing"],
      workspace: { kind: "scratch" },
    };
    const child = await createCard(store, "Child", {
      status: "running",
      parents: [parent.id],
      execution: codexExecution("exec-held", 1),
      ...automation,
    });

    expect(child.status).toBe("todo");
    expect(child.execution).toBeUndefined();
    expect(child.metadata?.attempts).toBeUndefined();
    expect(child.metadata?.links).toEqual(contains({ type: "parent", targetCardId: parent.id }));
    await expect(store.get(child.id)).resolves.toEqual(child);
    await expectRejected(store.claim(child.id, { ownerId: "main" }), /dependencies/);
    await expectRejected(store.move(child.id, "ready", child.position), /dependencies/);
    await expectRejected(store.move(child.id, "running", child.position), /dependencies/);
    await expectRejected(store.move(child.id, "done", child.position), /dependencies/);
    await expectRejected(store.update(child.id, { status: "ready" }), /dependencies/);
    await expectRejected(store.update(child.id, { status: "done" }), /dependencies/);
    await expectRejected(store.complete(child.id, { summary: "Too early." }), /dependencies/);

    const linked = await store.update(child.id, {
      metadata: {
        links: [
          {
            id: "ordinary-link",
            type: "relates_to",
            createdAt: Date.now(),
            url: "https://example.com/work",
            title: "Related work",
          },
        ],
      },
    });
    expect(linked.metadata?.links).toEqual(
      contains(
        { type: "parent", targetCardId: parent.id },
        { type: "relates_to", url: "https://example.com/work", title: "Related work" },
      ),
    );
    const blocked = await store.addLink(child.id, {
      type: "blocked_by",
      targetCardId: "card-upstream",
      title: "Upstream fix",
    });
    expect(blocked.metadata?.links).toEqual(
      contains({ type: "blocked_by", targetCardId: "card-upstream", title: "Upstream fix" }),
    );
    expect(blocked.events?.at(-1)).toMatchObject({ kind: "link_added" });
    await expectRejected(
      store.addLink(child.id, { type: "parent", targetCardId: parent.id }),
      /linkDependency/,
    );
    await expectRejected(store.claim(child.id, { ownerId: "main" }), /dependencies/);

    await store.complete(parent.id, { summary: "Parent done." });
    const dispatch = await store.dispatch();

    expect(dispatch.promoted).toMatchObject([
      { id: child.id, status: "ready", metadata: { automation } },
    ]);
    const claimed = await store.claim(child.id, { ownerId: "main" });
    expect(claimed.card.status).toBe("running");
    await expectRejected(
      store.claim(child.id, { ownerId: "other" }),
      "card already claimed by main.",
    );

    await store.update(parent.id, { status: "running" });
    await store.dispatch();
    await expectStored(store, child.id, {
      status: "running",
      metadata: { claim: { ownerId: "main" } },
    });
    await expectRejected(
      store.releaseClaim(child.id, { ownerId: "main", status: "done" }),
      /dependencies/,
    );
    await expectStored(store, child.id, {
      status: "running",
      metadata: { claim: { ownerId: "main" } },
    });

    const lateParent = await createCard(store, "Late parent");
    await expectRejected(store.linkCards(lateParent.id, child.id), /active child/);
  });

  it("lets a released review card be claimed again once its parents are done", async () => {
    const store = createStore();
    const parent = await createCard(store, "Parent");
    const child = await createCard(store, "Child", { parents: [parent.id] });
    await store.complete(parent.id, { summary: "Parent done." });
    await store.claim(child.id, { ownerId: "worker" });
    await store.releaseClaim(child.id, { ownerId: "worker", status: "review" });

    const reviewed = await store.claim(child.id, { ownerId: "reviewer" });
    expect(reviewed.card.status).toBe("review");
    await expect(
      store.complete(child.id, { summary: "Accepted.", ownerId: "reviewer" }),
    ).resolves.toMatchObject({ status: "done" });

    const reopened = await createCard(store, "Reopened parent");
    const dependent = await createCard(store, "Dependent", { parents: [reopened.id] });
    await store.complete(reopened.id, { summary: "Done." });
    await store.claim(dependent.id, { ownerId: "worker" });
    await store.releaseClaim(dependent.id, { ownerId: "worker", status: "review" });
    await store.update(reopened.id, { status: "running" });
    await expectRejected(
      store.claim(dependent.id, { ownerId: "reviewer" }),
      "card dependencies are not done.",
    );
  });

  it("resolves parent dependency status with targeted lookups instead of a full-corpus scan", async () => {
    const { store, stores } = createWorkboardSqliteTestHarness();
    const entriesSpy = vi.spyOn(stores.cards, "entries");

    const parent = await createCard(store, "Parent");
    const children = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        createCard(store, `Child ${i}`, { status: "todo", parents: [parent.id] }),
      ),
    );

    await store.complete(parent.id, { summary: "Parent done." });
    entriesSpy.mockClear();
    const dispatch = await store.dispatch();

    const idComparator = (left: string, right: string) => left.localeCompare(right);
    expect(dispatch.promoted.map((card) => card.id).toSorted(idComparator)).toEqual(
      children.map((child) => child.id).toSorted(idComparator),
    );
    // Regression guard for the dependencyTargetStatus N+1: before the fix, every
    // parented card being checked in this pass triggered its own additional
    // unscoped list() call (an extra full-corpus scan per child, here 8 of them).
    // Resolving parents via targeted get() calls keeps this flat regardless of
    // how many dependent cards are promoted together.
    expect(entriesSpy.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("rejects terminal children with incomplete dependency parents", async () => {
    const store = createStore();
    const runningParent = await createCard(store, "Running parent", { status: "running" });
    const doneChild = await createCard(store, "Done child", { status: "done" });

    await expectRejected(store.linkCards(runningParent.id, doneChild.id), /terminal child/);
    await expectRejected(
      createCard(store, "Already done", { status: "done", parents: [runningParent.id] }),
      /terminal child/,
    );

    const doneParent = await createCard(store, "Done parent", { status: "done" });
    await expect(store.linkCards(doneParent.id, doneChild.id)).resolves.toMatchObject({
      id: doneChild.id,
      status: "done",
    });
  });

  it("preserves dependency links across link caps and parent deletion", async () => {
    const store = createStore();
    const parent = await createCard(store, "Parent", { status: "running" });
    const child = await createCard(store, "Child", { parents: [parent.id] });

    for (let index = 0; index < 60; index += 1) {
      await store.addLink(child.id, {
        type: "relates_to",
        url: `https://example.com/${index}`,
      });
    }

    await expectRejected(store.claim(child.id, { ownerId: "main" }), /dependencies/);

    await store.delete(parent.id);
    const claimed = await store.claim(child.id, { ownerId: "main" });

    expect(claimed.card.status).toBe("running");
    expect(claimed.card.metadata?.links?.some((link) => link.targetCardId === parent.id)).toBe(
      false,
    );
  });

  it("keeps a created card visible when dependency link capacity rejects the parent", async () => {
    const store = createStore();
    const parent = await createCard(store, "Fanout parent");
    for (let index = 0; index < 50; index += 1) {
      await createCard(store, `Child ${index}`, { parents: [parent.id] });
    }

    await expectRejected(
      createCard(store, "Overflow child", { parents: [parent.id], idempotencyKey: "overflow" }),
      /link limit/,
    );

    expect((await store.list()).some((card) => card.title === "Overflow child")).toBe(true);
  });

  it("rejects invalid parent creates without persisting partial cards", async () => {
    const store = createStore();
    const parents: string[] = [];
    for (let index = 0; index < 21; index += 1) {
      parents.push((await createCard(store, `Parent ${index}`)).id);
    }

    await expectRejected(
      createCard(store, "Too many parents", { parents }),
      /parents supports at most 20 entries/,
    );
    await expectRejected(
      createCard(store, "Malformed parents", { parents: [parents[0], 123] }),
      /parents entries must be strings/,
    );

    await expectRejected(
      createCard(store, "Orphan child", {
        parents: ["missing-parent"],
        idempotencyKey: "fanout:missing",
      }),
      /card not found: missing-parent/,
    );

    expect((await store.list()).some((card) => card.title === "Too many parents")).toBe(false);
    expect((await store.list()).some((card) => card.title === "Malformed parents")).toBe(false);
    expect((await store.list()).some((card) => card.title === "Orphan child")).toBe(false);
  });

  it("rejects dependency cycles", async () => {
    const store = createStore();
    const first = await createCard(store, "First");
    const second = await createCard(store, "Second", { parents: [first.id] });

    await expectRejected(store.linkCards(second.id, first.id), /cycle/);
  });

  it.each(["execution", "card"] as const)(
    "rejects over-limit %s run IDs at admission without changing cards",
    async (association) => {
      const store = createStore();
      const card = await createCard(store, "Keep existing work", { status: "running" });
      const runId = "r".repeat(MAX_RUN_ID_LENGTH + 1);
      const input =
        association === "execution"
          ? { execution: codexExecution("exec-too-long", 1_000, { runId }) }
          : { runId };

      await expectRejected(
        createCard(store, "Reject oversized identity", { ...input }),
        "run id must be 512 characters or fewer (got 513).",
      );
      await expectRejected(
        store.update(card.id, input),
        "run id must be 512 characters or fewer (got 513).",
      );
      expect(await store.get(card.id)).toEqual(card);
      expect((await store.list()).map((entry) => entry.id)).toEqual([card.id]);
    },
  );

  it("keeps cards with historical oversized run IDs editable", async () => {
    const { store, stores } = createWorkboardSqliteTestHarness({
      createStores: createKernelStores,
    });
    const card = await createCard(store, "Existing run", {
      status: "running",
      runId: "original-run",
      execution: codexExecution("exec-legacy", 1_000, { runId: "original-run" }),
    });
    const legacyRunId = "r".repeat(MAX_RUN_ID_LENGTH + 1);
    const legacy = {
      ...card,
      runId: legacyRunId,
      execution: { ...card.execution!, runId: legacyRunId },
      events: card.events?.map((event) => ({ ...event, runId: legacyRunId })),
      metadata: {
        ...card.metadata,
        attempts: card.metadata?.attempts?.map((attempt) => ({
          ...attempt,
          id: legacyRunId,
          runId: legacyRunId,
        })),
      },
    };
    await stores.cards.register(card.id, { version: 1, card: legacy });

    await store.update(card.id, { title: "Resume existing work" });
    await store.addComment(card.id, { body: "Replace the oversized active identity." });
    await store.update(card.id, {
      runId: "replacement-run",
      execution: { ...legacy.execution, runId: "replacement-run" },
    });
    await store.complete(card.id, { proof: { status: "passed" } });

    expect(await store.get(card.id)).toMatchObject({
      title: "Resume existing work",
      status: "done",
      runId: "replacement-run",
      events: contains({ runId: legacyRunId }),
      metadata: {
        attempts: contains({ runId: legacyRunId }),
      },
    });
  });

  it.each([
    { runIdLength: 164, trimMetadata: false },
    { runIdLength: MAX_RUN_ID_LENGTH, trimMetadata: true },
  ])(
    "completes a $runIdLength-character run with trimMetadata=$trimMetadata",
    async ({ runIdLength, trimMetadata }) => {
      const store = createStore();
      const runId = "r".repeat(runIdLength);
      const card = await createCard(store, "Complete long run ID", {
        status: "running",
        execution: codexExecution("exec-long-run", 1_000, { runId }),
        ...(trimMetadata ? { metadata: metadataPressure() } : {}),
      });
      const logged = trimMetadata
        ? undefined
        : await store.addWorkerLog(card.id, { message: "Verification ready.", runId });
      const subscription = await store.subscribeNotifications({ runId });
      await store.complete(card.id, {
        ...(trimMetadata ? {} : { summary: "Verified." }),
        proof: {
          status: "passed",
          command: "test-command",
          ...(trimMetadata ? { note: "p".repeat(2000) } : {}),
        },
      });

      const completed = await store.get(card.id);
      expect(completed).toMatchObject({
        status: "done",
        execution: { status: "done", runId },
        metadata: { proof: [{ status: "passed", command: "test-command" }] },
      });
      if (!trimMetadata) {
        expect(logged).toBeDefined();
        expect(completed).toMatchObject({
          events: [...(logged?.events ?? []), { kind: "moved", toStatus: "done" }],
          metadata: {
            attempts: [{ status: "succeeded", runId }],
            workerLogs: [{ message: "Verification ready.", runId }],
            notifications: [{ kind: "completed", runId }],
          },
        });
      }
      if (trimMetadata) {
        expect(completed?.metadata?.artifacts?.length ?? 0).toBeLessThan(
          card.metadata?.artifacts?.length ?? 0,
        );
        expect(Buffer.byteLength(JSON.stringify(completed?.metadata), "utf8")).toBeLessThanOrEqual(
          MAX_CARD_METADATA_BYTES,
        );
      }
      expect(await store.notificationEvents({ subscriptionId: subscription.id })).toMatchObject({
        events: [{ kind: "completed", runId }],
      });
    },
  );

  it("leaves the card unchanged when completion notification validation fails", async () => {
    const store = createStore();
    const card = await createCard(store, "Reject invalid notification", {
      status: "running",
      execution: codexExecution("exec-invalid-notification", 1_000, {
        sessionKey: "s".repeat(241),
      }),
    });

    await expectRejected(
      store.complete(card.id, {
        summary: "Must not be committed.",
        proof: { status: "passed", command: "test-command" },
      }),
      "session key must be 240 characters or fewer (got 241).",
    );
    expect(await store.get(card.id)).toEqual(card);
  });

  it("completes and blocks claimed cards with structured handoff metadata", async () => {
    const store = createStore();
    const card = await createCard(store, "Ship child", {
      status: "running",
      execution: codexExecution("exec-complete", 1_000),
    });
    const child = await createCard(store, "Follow-up", { parents: [card.id] });
    const claimed = await store.claim(card.id, { ownerId: "main", token: "token-1" });

    const completed = await store.complete(claimed.card.id, {
      ownerId: "main",
      token: "token-1",
      summary: "Implemented and verified.",
      proof: { status: "passed", command: "pnpm test extensions/workboard" },
      artifacts: [{ path: "/tmp/log.txt", label: "log" }],
      createdCardIds: [child.id],
    });

    expect(completed).toMatchObject({
      status: "done",
      execution: { status: "done" },
      metadata: {
        attempts: [{ status: "succeeded", endedAt: expect.any(Number) }],
        comments: [{ body: "Implemented and verified." }],
        proof: [{ status: "passed" }],
        artifacts: [{ path: "/tmp/log.txt" }],
        automation: { summary: "Implemented and verified.", createdCardIds: [child.id] },
        notifications: [{ kind: "completed" }],
      },
    });
    expect(completed.metadata?.claim).toBeUndefined();

    const blockedCard = await createCard(store, "Blocked work", {
      status: "running",
      execution: {
        id: "exec-block",
        kind: "agent-session",
        engine: "claude",
        mode: "autonomous",
        status: "running",
        model: "anthropic/claude-sonnet-4.6",
        startedAt: 1_000,
        updatedAt: 1_000,
      },
    });
    await store.claim(blockedCard.id, { ownerId: "main", token: "token-2" });
    const blocked = await store.block(blockedCard.id, {
      ownerId: "main",
      token: "token-2",
      reason: "Needs owner decision.",
    });

    expect(blocked).toMatchObject({
      status: "blocked",
      execution: { status: "blocked" },
      metadata: {
        attempts: [
          { status: "blocked", endedAt: expect.any(Number), error: "Needs owner decision." },
        ],
        failureCount: 1,
        notifications: [{ kind: "failed", message: "Needs owner decision." }],
      },
    });
    expect(blocked.metadata?.claim).toBeUndefined();

    const recovered = await store.complete(
      (
        await createCard(store, "Recovered work", {
          status: "running",
          metadata: { failureCount: 2 },
        })
      ).id,
      { summary: "Recovered." },
    );
    expect(recovered.metadata?.failureCount).toBeUndefined();
  });

  test("heals oversized notifications during timeout recovery without rewriting ready siblings", async () => {
    const dbPath = path.join(tempDirs.make("openclaw-workboard-notification-"), "workboard.sqlite");
    await using store = openPersistentStore(dbPath);
    const poisoned = await createCard(store, "Oversized notification", {
      status: "running",
      startedAt: 1,
      maxRuntimeSeconds: 1,
    });
    const sibling = await createCard(store, "Unaffected sibling", { status: "ready" });
    const oversized = `${"x".repeat(238)}🦞${" tail".repeat(60)}`;
    {
      using raw = new DatabaseSync(dbPath);
      raw
        .prepare(
          "INSERT INTO workboard_card_notifications (id, card_id, ordinal, kind, message, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("oversized", poisoned.id, 0, "failed", oversized, Date.now());
    }
    expect((await store.get(poisoned.id))?.metadata?.notifications?.[0]?.message).toBe(oversized);
    await store.dispatch();
    const repaired = await store.get(poisoned.id);
    expect(repaired?.status).toBe("blocked");
    expect(repaired?.metadata?.notifications?.[0]?.message).toBe(`${"x".repeat(238)}…`);
    await expect(store.get(sibling.id)).resolves.toEqual(sibling);
    using raw = new DatabaseSync(dbPath, { readOnly: true });
    expect(
      raw.prepare("SELECT message FROM workboard_card_notifications WHERE id = ?").get("oversized"),
    ).toEqual({ message: `${"x".repeat(238)}…` });
  });

  it("dispatches ready cards and blocks expired or timed-out work", async () => {
    using clock = fakeClock();
    clock.set(1_000);

    const store = createWorkboardSqliteTestStore();
    const ready = await createCard(store, "Ready", { status: "ready" });
    const expired = await createCard(store, "Expired", { status: "running" });
    await store.claim(expired.id, { ownerId: "main", token: "token-1", ttlSeconds: 1 });
    const timed = await createCard(store, "Timed", {
      status: "running",
      maxRuntimeSeconds: 1,
      execution: codexExecution("exec-1", 1_000),
    });
    const claimedTimed = await createCard(store, "Claimed timed", {
      status: "ready",
      maxRuntimeSeconds: 1,
    });
    await store.claim(claimedTimed.id, {
      ownerId: "timed-worker",
      token: "token-2",
      ttlSeconds: 60,
    });
    const createdRunningTimed = await createCard(store, "Created running timed", {
      status: "running",
      maxRuntimeSeconds: 1,
    });

    const result = await store.dispatch(10 * 60 * 1000);

    expect(createdRunningTimed.startedAt).toBe(1_000);
    expect(result.count).toBe(4);
    const dispatchedReady = await store.get(ready.id);
    expect(dispatchedReady).toEqual(ready);
    const blockedExpired = await store.get(expired.id);
    expect(blockedExpired).toMatchObject({ status: "blocked" });
    expect(blockedExpired?.metadata?.claim).toBeUndefined();
    await expectStored(store, timed.id, {
      status: "blocked",
      execution: { status: "blocked" },
      metadata: { attempts: [{ status: "blocked", endedAt: 600_000 }] },
    });
    const blockedClaimed = await store.get(claimedTimed.id);
    expect(blockedClaimed).toMatchObject({ status: "blocked" });
    expect(blockedClaimed?.metadata?.claim).toBeUndefined();
    expect(blockedClaimed?.metadata?.notifications).toEqual(
      contains({ message: "Run exceeded the card max runtime." }),
    );
    await expectStored(store, createdRunningTimed.id, {
      status: "blocked",
      metadata: {
        notifications: contains({ message: "Run exceeded the card max runtime." }),
      },
    });
  });

  it("lets in-flight retries finish before enforcing the retry budget", async () => {
    const store = createStore();
    const retrying = await createCard(store, "Retrying", {
      status: "ready",
      maxRetries: 1,
      metadata: { failureCount: 1 },
    });
    await store.claim(retrying.id, { ownerId: "main", token: "token-1" });

    const retryDispatch = await store.dispatch();

    expect(retryDispatch.blocked).toEqual([]);
    await expectStored(store, retrying.id, { status: "running" });

    const exhausted = await createCard(store, "Exhausted", {
      status: "ready",
      maxRetries: 1,
      metadata: { failureCount: 2 },
    });
    const exhaustedTodo = await createCard(store, "Exhausted todo", {
      status: "todo",
      maxRetries: 1,
      metadata: { failureCount: 2 },
    });
    const exhaustedBacklog = await createCard(store, "Exhausted backlog", {
      status: "backlog",
      maxRetries: 1,
      metadata: { failureCount: 2 },
    });
    await expectRejected(store.claim(exhausted.id, { ownerId: "main" }), /retry budget/);

    const exhaustedDispatch = await store.dispatch();

    expect(exhaustedDispatch.blocked).toEqual(
      contains(
        { id: exhausted.id, status: "blocked" },
        { id: exhaustedTodo.id, status: "blocked" },
        { id: exhaustedBacklog.id, status: "blocked" },
      ),
    );
    await expectStored(store, exhausted.id, {
      status: "blocked",
      metadata: { notifications: [{ message: "Card exhausted its retry budget." }] },
    });

    const parent = await createCard(store, "Parent retry gate", { status: "running" });
    const dependent = await createCard(store, "Dependent exhausted", {
      parents: [parent.id],
      maxRetries: 1,
      metadata: { failureCount: 2 },
    });
    await store.complete(parent.id, { summary: "Parent done." });

    const dependentDispatch = await store.dispatch();

    expect(dependentDispatch.promoted.some((card) => card.id === dependent.id)).toBe(false);
    expect(dependentDispatch.blocked).toEqual([
      expect.objectContaining({ id: dependent.id, status: "blocked" }),
    ]);
  });

  it("checks mutation claim scope inside queued card writes", async () => {
    const store = createStore();
    const card = await createCard(store, "Scoped mutation");
    await store.claim(card.id, { ownerId: "main", token: "token-1" });

    await expectRejected(
      store.addComment(card.id, { body: "stale write" }, { ownerId: "other" }),
      /claimed by main/,
    );
    await expect(store.get(card.id)).resolves.not.toMatchObject({
      metadata: { comments: [{ body: "stale write" }] },
    });

    await expectRejected(
      store.addComment(card.id, { body: "rejected token" }, { ownerId: "other", token: "wrong" }),
      /claimed by main/,
    );
    await expect(
      store.addComment(card.id, { body: "token write" }, { ownerId: "other", token: "token-1" }),
    ).resolves.toMatchObject({ metadata: { comments: [{ body: "token write" }] } });
    await expect(
      store.addComment(card.id, { body: "owner write" }, { ownerId: "main" }),
    ).resolves.toMatchObject({
      metadata: { comments: [{ body: "token write" }, { body: "owner write" }] },
    });
    expect((await store.get(card.id))?.events?.at(-1)).toMatchObject({ kind: "comment_added" });
  });

  it("lets operators override claims while enforcing agent-scoped moves", async () => {
    const store = createStore();
    const card = await createCard(store, "Scoped move", { status: "todo" });
    await store.claim(card.id, { ownerId: "agent-a", token: "test-auth-token" });

    await expectRejected(
      store.move(card.id, "review", undefined, { ownerId: "agent-b" }),
      "card is claimed by agent-a",
    );
    await expectStored(store, card.id, { status: "running" });

    await expect(store.move(card.id, "review", undefined)).resolves.toMatchObject({
      status: "review",
    });
  });

  it("does not commit proof when proof artifact validation fails", async () => {
    const store = createStore();
    const card = await createCard(store, "Atomic proof");

    await expectRejected(
      store.addProofWithArtifact(
        card.id,
        { status: "passed", label: "CI" },
        { path: "x".repeat(2001) },
      ),
      /artifact path/,
    );

    await expect(store.get(card.id)).resolves.not.toMatchObject({
      metadata: { proof: [{ label: "CI" }] },
    });
  });

  it("computes and refreshes card diagnostics", async () => {
    const store = createStore();
    const ready = await createCard(store, "Ready too long", { agentId: "main", position: 10 });
    const running = await createCard(store, "Loose run", { status: "running", sessionKey: "s1" });
    const failed = await createCard(store, "Failed twice", {
      status: "blocked",
      metadata: { failureCount: 2 },
    });
    const doneWithAttachment = await createCard(store, "Done with attachment", { status: "done" });
    await store.addAttachment(doneWithAttachment.id, {
      fileName: "result.log",
      contentBase64: Buffer.from("x").toString("base64"),
    });

    const now = Date.now() + 2 * 24 * 60 * 60 * 1000;
    const diagnostics = await store.refreshDiagnostics(now);

    expect(diagnostics.count).toBeGreaterThanOrEqual(4);
    const diagnosedReady = await store.get(ready.id);
    expect(diagnosedReady?.updatedAt).toBeGreaterThan(ready.updatedAt);
    expect(diagnosedReady).toMatchObject({
      metadata: { diagnostics: [{ kind: "stranded_ready" }] },
    });
    await expectStored(store, running.id, {
      metadata: {
        diagnostics: contains({ kind: "running_without_heartbeat" }, { kind: "orphaned_session" }),
      },
    });
    await expectStored(store, failed.id, {
      metadata: {
        diagnostics: contains({ kind: "blocked_too_long" }, { kind: "repeated_failures" }),
      },
    });
    await expect(store.get(doneWithAttachment.id)).resolves.not.toMatchObject({
      metadata: {
        diagnostics: contains({ kind: "missing_proof" }),
      },
    });
  });

  it.each(["done", "ready"] as const)(
    "keeps archived %s diagnostics transient without rewriting history",
    async (status) => {
      const store = createStore();
      const card = await createCard(store, "Archived work", { status });
      const now = Date.now();
      const missingProof = {
        diagnostics: [
          expect.objectContaining({
            card: expect.objectContaining({ id: card.id }),
            diagnostics: [expect.objectContaining({ kind: "missing_proof" })],
          }),
        ],
        count: 1,
      };
      if (status === "done") {
        await expect(store.refreshDiagnostics(now)).resolves.toMatchObject(missingProof);
      }
      const archived = await store.archive(card.id, true);
      const changes = vi.fn();
      store.onChange = changes;
      await expect(store.refreshDiagnostics(now + 1)).resolves.toEqual({
        diagnostics: [],
        count: 0,
      });
      if (status === "done") {
        await expect(store.diagnostics(now + 1)).resolves.toEqual({ diagnostics: [], count: 0 });
      } else {
        await expect(store.get(card.id)).resolves.not.toHaveProperty("metadata.diagnostics");
        await expect(store.diagnostics(now + 1)).resolves.toMatchObject({
          diagnostics: [
            {
              card: { id: card.id },
              diagnostics: [{ kind: "archived_but_active", severity: "warning", actions: [] }],
            },
          ],
          count: 1,
        });
      }
      await expect(store.get(card.id)).resolves.toEqual(archived);
      await expect(store.list()).resolves.toEqual([archived]);
      expect(changes).not.toHaveBeenCalled();
      store.onChange = undefined;
      await store.archive(card.id, false);
      if (status === "done") {
        await expect(store.diagnostics(now + 2)).resolves.toMatchObject(missingProof);
      } else {
        await expect(store.diagnostics(now + 2)).resolves.toEqual({ diagnostics: [], count: 0 });
        await store.archive(card.id, true);
        await store.move(card.id, "done", undefined);
        await expect(store.diagnostics(now + 3)).resolves.toEqual({ diagnostics: [], count: 0 });
      }
    },
  );

  it("builds bounded worker context from card metadata", async () => {
    const store = createStore();
    const card = await createCard(store, "Write docs", {
      notes: "Acceptance:\n- mention tools",
      agentId: "main",
      metadata: {
        comments: [{ id: "comment-1", body: `${"x".repeat(398)}🚀tail`, createdAt: 10 }],
        proof: [{ id: "proof-1", status: "passed", command: "pnpm test", createdAt: 12 }],
        artifacts: [
          { id: "artifact-1", label: "Failure screenshot", path: "/tmp/fail.png", createdAt: 13 },
        ],
      },
    });

    await expect(store.buildWorkerContext(card.id)).resolves.toContain(`- ${"x".repeat(398)}…`);
    await expect(store.buildWorkerContext(card.id)).resolves.toContain("pnpm test");
    await expect(store.buildWorkerContext(card.id)).resolves.toContain("Failure screenshot");
  });

  it("scopes idempotent creates and stats by board", async () => {
    const store = createStore();
    await expect(store.stats()).resolves.toEqual({
      id: "all",
      total: 0,
      active: 0,
      archived: 0,
      byStatus: {},
      byAgent: {},
    });
    const ops = await createCard(store, "Ops work", { boardId: "ops", idempotencyKey: "same" });
    const product = await createCard(store, "Product work", {
      boardId: "product",
      idempotencyKey: "same",
    });
    const repeatedOps = await createCard(store, "Duplicate ops", {
      boardId: "ops",
      idempotencyKey: "same",
    });

    expect(repeatedOps.id).toBe(ops.id);
    expect(product.id).not.toBe(ops.id);
    expect(ops.position).toBe(1000);
    expect(product.position).toBe(1000);
    await expect(store.list({ boardId: "ops" })).resolves.toHaveLength(1);
    await expect(store.listBoards()).resolves.toMatchObject({
      boards: contains({ id: "ops", total: 1 }, { id: "product", total: 1 }),
    });
    await expect(store.stats({ boardId: "product" })).resolves.toMatchObject({
      id: "product",
      total: 1,
      byStatus: { todo: 1 },
    });
    const prototypeAgentId = ["__", "proto__"].join("");
    const secondProduct = await createCard(store, "Prototype safe", {
      boardId: "product",
      agentId: prototypeAgentId,
    });
    expect(secondProduct.position).toBe(2000);
    const stats = await store.stats({ boardId: "product" });
    expect(stats.byAgent[prototypeAgentId]).toBe(1);
    expect(stats.byAgent["(default)"]).toBe(1);
    await expect(store.stats({ boardId: " PRODUCT " })).resolves.toEqual(stats);
    await expectRejected(store.stats({ boardId: "bad/id" }), "board id must match");
    await expect(store.stats({ boardId: "missing" })).resolves.toEqual({
      id: "missing",
      total: 0,
      active: 0,
      archived: 0,
      byStatus: {},
      byAgent: {},
    });
    const metadataBoardFirst = await createCard(store, "Metadata board first", {
      metadata: { automation: { boardId: "metadata-board" } },
    });
    const metadataBoardSecond = await createCard(store, "Metadata board second", {
      metadata: { automation: { boardId: "metadata-board" } },
    });
    expect(metadataBoardFirst.position).toBe(1000);
    expect(metadataBoardSecond.position).toBe(2000);
    const defaultCard = await createCard(store, "Default board");
    await expect(store.stats({ boardId: "default" })).resolves.toMatchObject({
      id: "default",
      total: 1,
      byStatus: { todo: 1 },
      byAgent: { "(default)": 1 },
      updatedAt: defaultCard.updatedAt,
    });
    await expect(store.stats({ boardId: "metadata-board" })).resolves.toMatchObject({ total: 2 });
    await expect(store.stats()).resolves.toMatchObject({
      id: "all",
      total: 6,
      active: 6,
      archived: 0,
      byStatus: { todo: 6 },
      byAgent: { "(default)": 5, [prototypeAgentId]: 1 },
    });
    await expect(store.stats({ boardId: " " })).resolves.toEqual(await store.stats());
  });

  it("excludes archived ready cards from active queue-age statistics", async () => {
    using clock = fakeClock();
    clock.set(1_000);

    const { store, stores } = createWorkboardSqliteTestHarness();
    const oldReady = await createCard(store, "Archived ready work", {
      boardId: "ops",
      status: "ready",
    });
    clock.set(2_000);
    await store.archive(oldReady.id, true);

    await expect(store.stats({ boardId: "ops" }, 5_000)).resolves.toMatchObject({
      total: 1,
      active: 0,
      archived: 1,
      byStatus: { ready: 1 },
    });
    await expect(store.stats({ boardId: "ops" }, 5_000)).resolves.not.toHaveProperty(
      "oldestReadyAgeMs",
    );

    clock.set(3_000);
    await createCard(store, "Active ready work", { boardId: "ops", status: "ready" });
    await expect(store.stats({ boardId: "ops" }, 5_000)).resolves.toMatchObject({
      total: 2,
      active: 1,
      archived: 1,
      byStatus: { ready: 2 },
      oldestReadyAgeMs: 2_000,
      updatedAt: 3_000,
    });
    await expect(store.stats({ boardId: "ops" }, 1_000)).resolves.toMatchObject({
      oldestReadyAgeMs: 0,
    });
    const epochReady = await createCard(store, "Epoch ready", {
      boardId: "epoch",
      status: "ready",
    });
    await stores.cards.register(epochReady.id, {
      version: 1,
      card: {
        ...epochReady,
        agentId: "",
        updatedAt: 0,
        metadata: { ...epochReady.metadata, archivedAt: 0 },
      },
    });
    await expect(store.stats({ boardId: "epoch" }, 5_000)).resolves.toEqual({
      id: "epoch",
      total: 1,
      active: 1,
      archived: 0,
      byStatus: { ready: 1 },
      byAgent: { "(default)": 1 },
    });
  });

  it("rejects completed manifests for cards not created from the parent", async () => {
    const store = createStore();
    const parent = await createCard(store, "Parent", { status: "running" });
    const unrelated = await createCard(store, "Unrelated");

    await expectRejected(
      store.complete(parent.id, { createdCardIds: [unrelated.id] }, null),
      /not linked/,
    );
    const spoofed = await createCard(store, "Spoofed", { createdByCardId: parent.id });

    await expectRejected(
      store.complete(parent.id, { createdCardIds: [spoofed.id] }, null),
      /not linked/,
    );

    const child = await createCard(store, "Child", { parents: [parent.id] });

    await expect(
      store.complete(parent.id, { createdCardIds: [child.id], summary: "done" }, null),
    ).resolves.toMatchObject({
      status: "done",
      metadata: { automation: { createdCardIds: [child.id] } },
    });
  });

  it("promotes, reassigns, and reclaims cards for operator recovery", async () => {
    const store = createStore();
    const card = await createCard(store, "Recover me", {
      status: "blocked",
      agentId: "old-agent",
      metadata: { failureCount: 2 },
    });
    await store.refreshDiagnostics(Date.now() + 2 * 24 * 60 * 60 * 1000);

    const reassigned = await store.reassign(card.id, {
      agentId: "new-agent",
      status: "todo",
      reason: "route to fresh agent",
    });
    expect(reassigned).toMatchObject({ agentId: "new-agent", status: "todo" });
    expect(reassigned.metadata?.failureCount).toBeUndefined();
    expect(reassigned.metadata?.diagnostics?.map((entry) => entry.kind) ?? []).not.toContain(
      "repeated_failures",
    );

    await expect(store.promote(card.id)).resolves.toMatchObject({ status: "ready" });
    const claimed = await store.claim(card.id, { ownerId: "new-agent" });

    const reclaimed = await store.reclaim(claimed.card.id, { reason: "stale session" }, null);
    expect(reclaimed).toMatchObject({ status: "ready" });
    expect(reclaimed.metadata?.claim).toBeUndefined();
    await expect(store.get(reclaimed.id)).resolves.toEqual(reclaimed);

    const running = await createCard(store, "Running recovery", {
      status: "running",
      execution: codexExecution("exec-reclaim", 100),
    });
    const stopped = await store.reclaim(running.id, { reason: "replace worker" }, null);
    expect(stopped.execution).toBeUndefined();
    expect(stopped.metadata?.attempts).toEqual([expect.objectContaining({ status: "stopped" })]);
    expect(stopped.metadata?.failureCount).toBeUndefined();
    await expect(store.get(stopped.id)).resolves.toEqual(stopped);
  });

  it("excludes archived cards from notification replay without discarding their history", async () => {
    const {
      store,
      stores: { subscriptions },
    } = createWorkboardSqliteTestHarness({ createStores: createKernelStores });
    const historical = await createCard(store, "Archived notifications", {
      boardId: "ops",
      status: "done",
      metadata: {
        notifications: [
          { id: "archived-completed", kind: "completed", createdAt: 101, message: "Done" },
          { id: "archived-failed", kind: "failed", createdAt: 102, message: "Failed" },
        ],
        stale: { detectedAt: 103, reason: "Previous worker stopped" },
      },
    });
    const archived = await store.archive(historical.id, true);
    const active = await createCard(store, "Active notifications", { boardId: "ops" });
    await store.complete(active.id, { summary: "Still active." });
    const boardSubscription = await store.subscribeNotifications({
      boardId: "ops",
      target: "session:operator",
    });
    const archivedSubscription = await store.subscribeNotifications({
      cardId: archived.id,
      target: "session:operator",
    });

    await expect(
      store.notificationEvents({ subscriptionId: boardSubscription.id }),
    ).resolves.toMatchObject({ events: [{ kind: "completed", message: "Still active." }] });
    await expect(
      store.notificationEvents({ subscriptionId: archivedSubscription.id }),
    ).resolves.toMatchObject({ events: [] });
    await expect(
      store.advanceNotificationEvents({ subscriptionId: archivedSubscription.id }),
    ).resolves.toMatchObject({ events: [] });
    const storedSubscription = await subscriptions.lookup(archivedSubscription.id);
    expect(storedSubscription?.subscription).not.toHaveProperty("lastEventAt");
    expect(storedSubscription?.subscription).not.toHaveProperty("lastEventId");
    expect(storedSubscription?.subscription).not.toHaveProperty("lastEventSequence");
    await expect(store.get(archived.id)).resolves.toEqual(archived);

    await store.archive(archived.id, false);
    const restored = await store.notificationEvents({ subscriptionId: archivedSubscription.id });
    expect(restored.events).toHaveLength(3);
    expect(restored.events).toEqual(
      contains(
        { id: "archived-completed", kind: "completed" },
        { id: "archived-failed", kind: "failed" },
        { kind: "stale" },
      ),
    );
  });

  it("does not resurrect a subscription deleted during cursor advancement", async () => {
    const cursorWriteStarted = createDeferred<void>();
    const cursorWriteReleased = createDeferred<void>();
    const {
      store,
      stores: { subscriptions },
    } = createWorkboardSqliteTestHarness();
    const registerSubscription = subscriptions.register.bind(subscriptions);
    subscriptions.register = async (key, value) => {
      if (value.subscription.lastEventId) {
        cursorWriteStarted.resolve();
        await cursorWriteReleased.promise;
      }
      await registerSubscription(key, value);
    };
    const card = await createCard(store, "Delete in-flight notification", { boardId: "ops" });
    const subscription = await store.subscribeNotifications({
      boardId: "ops",
      target: "session:operator",
      eventKinds: ["completed"],
    });
    await store.complete(card.id, { summary: "Done." });

    const advancing = store.advanceNotificationEvents({ subscriptionId: subscription.id });
    await cursorWriteStarted.promise;
    const deleting = store.deleteNotificationSubscription(subscription.id);
    cursorWriteReleased.resolve();

    await expect(Promise.all([advancing, deleting])).resolves.toEqual([
      expect.objectContaining({ events: [expect.objectContaining({ kind: "completed" })] }),
      { deleted: true },
    ]);
    await expect(subscriptions.lookup(subscription.id)).resolves.toBeUndefined();
    await expect(store.listNotificationSubscriptions()).resolves.toEqual({ subscriptions: [] });
  });

  it("advances through mixed-sequence same-millisecond notifications without skips or replays", async () => {
    const { store, stores } = createWorkboardSqliteTestHarness({
      createStores: createKernelStores,
    });
    for (const [id, sequence] of [
      ["z-event", 1234000],
      ["a-event", 1234001],
      ["0-event", undefined],
    ] as const) {
      await createCard(store, id, {
        boardId: "ops",
        metadata: {
          notifications: [{ id, kind: "completed", createdAt: 1234, sequence, message: id }],
        },
      });
    }
    const subscription = await store.subscribeNotifications({
      boardId: "ops",
      target: "session:operator",
      eventKinds: ["completed"],
    });
    expect(
      (await store.notificationEvents({ subscriptionId: subscription.id })).events.map(
        (event) => event.id,
      ),
    ).toEqual(["z-event", "a-event", "0-event"]);
    expect((await stores.subscriptions.lookup(subscription.id))?.subscription).toEqual(
      subscription,
    );
    for (const id of ["z-event", "a-event", "0-event"]) {
      const page = await store.advanceNotificationEvents({
        subscriptionId: subscription.id,
        limit: 1,
      });
      expect(page.events).toEqual([expect.objectContaining({ id })]);
      await expect(stores.subscriptions.lookup(subscription.id)).resolves.toMatchObject({
        subscription: { lastEventAt: 1234, lastEventId: id },
      });
    }
    await expect(store.notificationEvents({ subscriptionId: subscription.id })).resolves.toEqual({
      subscription: expect.objectContaining({ id: subscription.id }),
      events: [],
    });
    await expectRejected(
      store.notificationEvents({ subscriptionId: "missing" }),
      /subscription not found/,
    );
    await expectRejected(
      store.advanceNotificationEvents({ boardId: "ops" }),
      /subscriptionId is required/,
    );
  });

  it("filters replayed notification events by session and run subscriptions", async () => {
    const store = createStore();
    const matching = await createCard(store, "Matching session", {
      boardId: "ops",
      sessionKey: "session-1",
      runId: "run-1",
    });
    const unrelated = await createCard(store, "Other session", {
      boardId: "ops",
      sessionKey: "session-2",
      runId: "run-2",
    });
    await createCard(store, "Card-scoped failed notification", {
      boardId: "ops",
      sessionKey: "session-1",
      runId: "run-1",
      metadata: {
        notifications: [
          {
            id: "card-scoped-failed",
            kind: "failed",
            createdAt: 1234,
            message: "Dispatch failed before stamping event scope.",
          },
        ],
      },
    });
    const subscription = await store.subscribeNotifications({
      boardId: "ops",
      sessionKey: "session-1",
      runId: "run-1",
      target: "session:operator",
    });

    await store.complete(unrelated.id, { summary: "Other done." });
    await store.complete(matching.id, { summary: "Matching done." });

    await expect(store.notificationEvents({ subscriptionId: subscription.id })).resolves.toEqual({
      subscription: expect.objectContaining({ id: subscription.id }),
      events: [
        expect.objectContaining({ id: "card-scoped-failed" }),
        expect.objectContaining({ sessionKey: "session-1", runId: "run-1" }),
      ],
    });
  });

  it("uses the default orchestration cap and skips already considered cards", async () => {
    const store = createStore();
    const cap = 3;
    await store.upsertBoard({ id: "planning", orchestration: { autoDecompose: true } });
    const cards: WorkboardCard[] = [];
    for (let index = 0; index <= cap; index++) {
      cards.push(
        await createCard(store, "Break down flow " + index, {
          status: "triage",
          boardId: "planning",
          position: index,
        }),
      );
    }
    const archived = await createCard(store, "Archived import flow", {
      status: "triage",
      boardId: "planning",
    });
    await store.archive(archived.id, true);

    const dispatch = await store.dispatch(10);

    expect(dispatch.orchestrated.map((card) => card.id)).toEqual(
      cards.slice(0, cap).map((card) => card.id),
    );
    expect(dispatch.count).toBe(cap);
    for (const card of cards.slice(0, cap)) {
      await expectStored(store, card.id, {
        status: "triage",
        metadata: {
          workerProtocol: {
            state: "idle",
            detail: "Awaiting workboard_specify or workboard_decompose.",
          },
          workerLogs: [{ level: "info" }],
        },
        events: contains({ kind: "orchestration" }),
      });
    }
    for (const card of [...cards.slice(cap), archived]) {
      await expect(store.get(card.id)).resolves.not.toMatchObject({
        metadata: { workerProtocol: expect.any(Object) },
      });
    }

    const next = await store.dispatch(11);
    expect(next.orchestrated.map((card) => card.id)).toEqual(
      cards.slice(cap).map((card) => card.id),
    );
    expect((await store.dispatch(12)).orchestrated).toEqual([]);
  });

  it.each([
    { name: "raised cap", autoDecompose: true, cap: 2, includeSecond: true },
    { name: "disabled orchestration", autoDecompose: false, cap: 2, includeSecond: false },
  ])("applies current per-board orchestration settings between cards: $name", async (scenario) => {
    await using harness = createConcurrentSqliteHarness("openclaw-workboard-orchestration-");
    let resume = () => {};
    let pending: ReturnType<WorkboardStore["dispatch"]> | undefined;
    try {
      const store = harness.operation;
      await store.upsertBoard({
        id: "ops",
        orchestration: { autoDecompose: true, autoDecomposePerDispatch: 1 },
      });
      await store.upsertBoard({
        id: "product",
        orchestration: { autoDecompose: true, autoDecomposePerDispatch: 1 },
      });
      const ops = await createCard(store, "Ops rough", {
        status: "triage",
        boardId: "ops",
        position: 0,
      });
      const second = await createCard(store, "More ops work", {
        status: "triage",
        boardId: "ops",
        position: 1,
      });
      const product = await createCard(store, "Product rough", {
        status: "triage",
        boardId: "product",
        position: 2,
      });
      const pause = harness.paused.pauseAfterMatchingWrite(
        (key, value) => key === ops.id && value?.card.metadata?.workerProtocol?.state === "idle",
      );
      resume = pause.resume;
      pending = store.dispatch(10);
      await pause.reached;
      await harness.host.upsertBoard({
        id: "ops",
        orchestration: {
          autoDecompose: scenario.autoDecompose,
          autoDecomposePerDispatch: scenario.cap,
        },
      });
      await harness.host.update(second.id, { title: "Updated between card decisions" });
      resume();
      const dispatch = await pending;

      expect(dispatch.orchestrated.map((card) => card.id)).toEqual(
        scenario.includeSecond ? [ops.id, second.id, product.id] : [ops.id, product.id],
      );
      await expectStored(store, second.id, {
        title: "Updated between card decisions",
      });
      if (!scenario.includeSecond) {
        await expect(store.get(second.id)).resolves.not.toMatchObject({
          metadata: { workerProtocol: expect.any(Object) },
        });
      }
    } finally {
      resume();
      await pending?.catch(() => undefined);
    }
  });

  it("scopes dispatch mutations by board", async () => {
    const store = createStore();
    await store.upsertBoard({
      id: "ops",
      orchestration: { autoDecompose: true, autoDecomposePerDispatch: 1 },
    });
    await store.upsertBoard({
      id: "product",
      orchestration: { autoDecompose: true, autoDecomposePerDispatch: 1 },
    });
    const ops = await createCard(store, "Ops rough", { status: "triage", boardId: "ops" });
    const product = await createCard(store, "Product rough", {
      status: "triage",
      boardId: "product",
    });

    const dispatch = await store.dispatch({ now: 10, boardId: "ops" });

    expect(dispatch.orchestrated.map((card) => card.id)).toEqual([ops.id]);
    await expectStored(store, ops.id, {
      metadata: { workerProtocol: expect.any(Object) },
    });
    await expect(store.get(product.id)).resolves.not.toMatchObject({
      metadata: { workerProtocol: expect.any(Object) },
    });
  });

  // Injects a failing SQLite trigger through a native file handle.
  test("rolls back attachment deletion when the card deletion fails", async () => {
    const { store, dbPath } = createWorkboardSqliteTestHarness();
    const card = await createCard(store, "Atomic deletion");
    const attached = await store.addAttachment(card.id, {
      fileName: "retained.txt",
      contentBase64: Buffer.from("keep on rollback").toString("base64"),
    });
    const raw = new DatabaseSync(dbPath);
    try {
      const before = raw.prepare("SELECT * FROM workboard_attachment_blobs").all();
      raw.exec(`CREATE TRIGGER reject_card_delete BEFORE DELETE ON workboard_cards
        BEGIN SELECT RAISE(ABORT, 'test card delete failure'); END`);

      await expectRejected(store.delete(card.id), "test card delete failure");
      await expect(store.get(card.id)).resolves.toEqual(attached);
      expect(raw.prepare("SELECT * FROM workboard_attachment_blobs").all()).toEqual(before);

      raw.exec("DROP TRIGGER reject_card_delete");
      await expect(store.delete(card.id)).resolves.toEqual({ deleted: true });
      expect(raw.prepare("SELECT * FROM workboard_attachment_blobs").all()).toEqual([]);
    } finally {
      raw.close();
    }
  });

  it("preserves new attachments when a deleted session card is recreated concurrently", async () => {
    await using harness = createConcurrentSqliteHarness("openclaw-workboard-delete-recreation-");
    const { operation, host, paused } = harness;
    let deletion: Promise<{ deleted: boolean }> | undefined;
    let resume: (() => void) | undefined;
    try {
      const input = { title: "Captured session", sessionKey: "agent:main:captured-delete" };
      const original = await operation.captureSession(input);
      const pause = paused.pauseAfterMatchingWrite((key, value) => key === original.id && !value);
      resume = pause.resume;
      deletion = operation.delete(original.id);
      await pause.reached;

      const recreated = await host.captureSession(input);
      expect(recreated.id).toBe(original.id);
      const attached = await host.addAttachment(recreated.id, {
        fileName: "new-generation.txt",
        contentBase64: Buffer.from("new generation bytes").toString("base64"),
      });
      const attachmentId = attached.metadata!.attachments![0]!.id;
      const expected = await host.getAttachment(attachmentId);
      expect(expected).toBeDefined();
      pause.resume();

      await expect(deletion).resolves.toEqual({ deleted: true });
      await expect(host.getAttachment(attachmentId)).resolves.toEqual(expected);
      await expect(host.get(recreated.id)).resolves.toEqual(attached);
    } finally {
      resume?.();
      await deletion?.catch(() => undefined);
    }
  });

  it("deletes card notification subscriptions with the card", async () => {
    const store = createStore();
    const card = await createCard(store, "Notify me");
    await store.subscribeNotifications({
      cardId: card.id,
      target: "session:operator",
      eventKinds: ["completed"],
    });

    await expect(store.delete(card.id)).resolves.toEqual({ deleted: true });
    await expect(store.listNotificationSubscriptions({ cardId: card.id })).resolves.toEqual({
      subscriptions: [],
    });
  });

  it.each([
    { parentKey: "planning:rough", childKey: "planning:rough:child:1" },
    { parentKey: "p".repeat(160), childKey: undefined },
  ])(
    "specifies and decomposes rough cards with parent key $parentKey",
    async ({ parentKey, childKey }) => {
      const store = createStore();
      const parent = await createCard(store, "Rough idea", {
        status: "triage",
        boardId: "planning",
        tenant: "qa",
        idempotencyKey: parentKey,
      });

      const specified = await store.specify(parent.id, {
        title: "Clarified plan",
        notes: "Acceptance: two concrete follow-up cards.",
        summary: "Clarified the outcome and acceptance criteria.",
        labels: ["planning"],
      });
      expect(specified).toMatchObject({
        title: "Clarified plan",
        status: "todo",
        notes: "Acceptance: two concrete follow-up cards.",
        labels: ["planning"],
        metadata: { comments: [{ body: "Clarified the outcome and acceptance criteria." }] },
      });
      expect(specified.events?.at(-1)).toMatchObject({ kind: "specified" });

      const result = await store.decompose(specified.id, {
        summary: "Split into implementation and review.",
        children: [
          { title: "Implement SQLite persistence", priority: "high" },
          { title: "Review Workboard flows", agentId: "reviewer" },
        ],
      });

      expect(result.parent.status).toBe("done");
      expect(result.parent.events?.at(-1)).toMatchObject({ kind: "decomposed" });
      expect(result.parent.metadata?.automation?.createdCardIds).toEqual(
        result.children.map((child) => child.id),
      );
      expect(result.children).toEqual([
        expect.objectContaining({
          title: "Implement SQLite persistence",
          priority: "high",
          metadata: {
            automation: expect.objectContaining({
              boardId: "planning",
              tenant: "qa",
              createdByCardId: parent.id,
            }),
            links: contains({ type: "parent", targetCardId: parent.id }),
          },
        }),
        expect.objectContaining({ title: "Review Workboard flows", agentId: "reviewer" }),
      ]);
      expect(result.children[0]?.metadata?.automation?.idempotencyKey).toBe(childKey);
      await expect(store.runs(parent.id)).resolves.toMatchObject({
        card: { id: parent.id },
        attempts: [],
      });
    },
  );

  it("keeps completed decomposition steps visible when a later child is invalid", async () => {
    const store = createStore();
    const parent = await createCard(store, "Parent");

    await expectRejected(
      store.decompose(parent.id, {
        children: [{ title: "Valid child" }, { notes: "Missing title" }],
      }),
      "title is required.",
    );

    const children = (await store.list()).filter((card) => card.id !== parent.id);
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      title: "Valid child",
      metadata: { links: [{ type: "parent", targetCardId: parent.id }] },
    });
    expect((await store.get(parent.id))?.metadata?.links).toEqual([
      expect.objectContaining({ type: "child", targetCardId: children[0]?.id }),
    ]);
  });

  it("keeps specify as a todo-only clarification step", async () => {
    const store = createStore();
    const card = await createCard(store, "Rough idea", { status: "triage" });
    const blocked = await createCard(store, "Blocked idea", { status: "blocked" });

    await expectRejected(store.specify(card.id, { status: "done" }), /must move to todo/);
    await expectRejected(store.specify(card.id, { status: "running" }), /must move to todo/);
    await expectRejected(
      store.specify(blocked.id, { title: "Specified" }),
      /only triage, backlog, or todo/,
    );
    await expect(store.specify(card.id, { title: "Specified" })).resolves.toMatchObject({
      title: "Specified",
      status: "todo",
    });
  });

  it("preserves parent child links when decomposition leaves the parent open", async () => {
    const store = createStore();
    const parent = await createCard(store, "Parent", { status: "triage" });
    await store.addLink(parent.id, { type: "relates_to", url: "https://example.com/context" });

    const result = await store.decompose(parent.id, {
      completeParent: false,
      summary: "Split and keep parent open.",
      children: [{ title: "Child" }],
    });

    expect(result.parent.status).toBe("todo");
    expect(result.parent.metadata?.links).toEqual(
      contains(
        { type: "relates_to", url: "https://example.com/context" },
        { type: "child", targetCardId: result.children[0]?.id },
      ),
    );
    await expect(
      store.complete(parent.id, {
        createdCardIds: result.children.map((child) => child.id),
        summary: "Children recorded.",
      }),
    ).resolves.toMatchObject({ status: "done" });
  });
});

describe("WorkboardStore attachments", () => {
  it("stores attachments in SQLite and adds worker context", async () => {
    const { store, stores } = createWorkboardSqliteTestHarness({
      createStores: createKernelStores,
    });
    const card = await createCard(store, "Review attached log");

    const attached = await store.addAttachment(card.id, {
      fileName: "failure.log",
      mimeType: "text/plain",
      note: "Captured failing run",
      contentBase64: Buffer.from("stack trace").toString("base64"),
    });

    expect(attached.metadata?.attachments?.[0]).toMatchObject({
      fileName: "failure.log",
      byteSize: "stack trace".length,
      mimeType: "text/plain",
    });
    expect(attached.events?.at(-1)).toMatchObject({ kind: "attachment_added" });
    const attachment = attached.metadata?.attachments?.[0];
    if (!attachment) {
      throw new Error("expected attachment metadata");
    }
    const persisted = await store.getAttachment(attachment.id);
    if (!persisted) {
      throw new Error("expected persisted attachment");
    }
    expect(Buffer.from(persisted.contentBase64, "base64").toString("utf8")).toBe("stack trace");
    await expectRejected(
      store.addAttachment(card.id, {
        fileName: "huge.bin",
        contentBase64: Buffer.alloc(256 * 1024 + 1).toString("base64"),
      }),
      /attachment must be/,
    );
    await expect(
      store.addAttachment(card.id, {
        fileName: "sqlite-sized.bin",
        contentBase64: Buffer.alloc(70 * 1024).toString("base64"),
      }),
    ).resolves.toMatchObject({
      metadata: {
        attachments: contains({ fileName: "sqlite-sized.bin" }),
      },
    });
    await expectRejected(
      store.addAttachment(card.id, {
        fileName: "padded.txt",
        contentBase64: `${Buffer.from("ok").toString("base64")}\n`,
      }),
      /canonical base64/,
    );

    const context = await store.buildWorkerContext(card.id);
    expect(context).toContain("failure.log");

    const deleted = await store.deleteAttachment(card.id, attachment.id);
    expect(deleted.metadata?.attachments).toEqual([
      expect.objectContaining({ fileName: "sqlite-sized.bin" }),
    ]);
    expect(deleted.events?.at(-1)).toMatchObject({ kind: "edited" });
    expect(await store.getAttachment(attachment.id)).toBeUndefined();

    const budgetCard = await createCard(store, "Attachment budget boundary", {
      metadata: {
        comments: Array.from({ length: 12 }, (_, index) => ({
          id: `comment-${index}`,
          body: "x".repeat(1970),
          createdAt: 1,
        })),
      },
    });
    expect(budgetCard.metadata?.comments).toHaveLength(12);
    const deleteBlob = stores.attachments.delete.bind(stores.attachments);
    let rejectedAttachmentId: string | undefined;
    using deletion = vi.spyOn(stores.attachments, "delete").mockImplementation(async (id) => {
      if (rejectedAttachmentId) {
        throw new Error("attachment was already deleted");
      }
      rejectedAttachmentId = id;
      return deleteBlob(id);
    });
    await expectRejected(
      store.addAttachment(budgetCard.id, {
        fileName: "f".repeat(240),
        note: "n".repeat(400),
        mimeType: "m".repeat(160),
        contentBase64: Buffer.from("proof").toString("base64"),
      }),
      "attachment metadata was trimmed before it could be indexed.",
    );
    expect(deletion).toHaveBeenCalledTimes(1);
    expect(rejectedAttachmentId).toBeDefined();
    expect(await store.getAttachment(rejectedAttachmentId!)).toBeUndefined();
    await expectStored(store, budgetCard.id, {
      metadata: { comments: budgetCard.metadata?.comments },
    });
  });

  // Inspects pruned physical blob rows through a native SQLite file handle.
  test("removes attachment blobs when the card attachment index prunes old entries", async () => {
    const { store, dbPath } = createWorkboardSqliteTestHarness();
    const card = await createCard(store, "Many attachments", { templateId: "docs" });
    let firstAttachmentId = "";

    for (let index = 0; index < 21; index += 1) {
      const updated = await store.addAttachment(card.id, {
        fileName: `log-${index}.txt`,
        contentBase64: Buffer.from(`log ${index}`).toString("base64"),
      });
      firstAttachmentId ||= updated.metadata?.attachments?.[0]?.id ?? "";
    }

    const saved = await store.get(card.id);
    expect(saved?.metadata?.attachments).toHaveLength(20);
    expect(await store.getAttachment(firstAttachmentId)).toBeUndefined();
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(
        db
          .prepare("SELECT attachment_id FROM workboard_attachment_blobs WHERE attachment_id = ?")
          .get(firstAttachmentId),
      ).toBeUndefined();
      expect(db.prepare("SELECT COUNT(*) AS count FROM workboard_attachment_blobs").get()).toEqual({
        count: 20,
      });
    } finally {
      db.close();
    }
    const exported = await store.exportCards();
    expect(exported.cards).toEqual([
      expect.objectContaining({
        id: card.id,
        metadata: expect.objectContaining({ templateId: "docs" }),
      }),
    ]);
    expect(exported.exportedAt).toEqual(expect.any(Number));
    expect(exported.attachments).toHaveLength(20);
    expect(exported.attachments[0]).not.toHaveProperty("contentBase64");
  });
});

describe("Workboard dependency and scheduled promotion", () => {
  it("scopes idempotent creates by tenant", async () => {
    const store = createStore();
    const input = { tenant: "release", idempotencyKey: "fanout:1" };
    const card = await createCard(store, "Tenant work", input);
    expect((await createCard(store, "Duplicate", input)).id).toBe(card.id);
    const ids = [card.id];
    for (const tenant of ["qa", undefined]) {
      const distinct = await createCard(store, "Other tenant", { ...input, tenant });
      ids.push(distinct.id);
    }
    expect(new Set(ids).size).toBe(3);
  });

  it("does not promote or claim an archived scheduled card", async () => {
    using clock = fakeClock();
    clock.set(1_000);

    const store = createWorkboardSqliteTestStore();
    const card = await createCard(store, "Archived scheduled work", {
      status: "scheduled",
      scheduledAt: 2_000,
      metadata: { archivedAt: Date.now() },
    });
    expect(card.metadata?.archivedAt).toBeUndefined();
    expect(card.events?.map((event) => event.kind)).toEqual(["created"]);
    const archived = await store.archive(card.id, true);
    expect(archived.metadata?.archivedAt).toBeGreaterThan(0);
    expect(archived.events?.at(-1)).toMatchObject({ kind: "archived" });
    const changes = vi.fn();
    store.onChange = changes;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(store.dispatch(3_000 + attempt)).resolves.toEqual({
        promoted: [],
        reclaimed: [],
        blocked: [],
        orchestrated: [],
        count: 0,
      });
    }
    await expectRejected(store.claim(card.id, { ownerId: "worker" }), /archived/);
    await expect(store.get(card.id)).resolves.toEqual(archived);
    expect(changes).not.toHaveBeenCalled();

    clock.set(3_000);
    const restored = await store.archive(card.id, false);
    expect(restored.metadata?.archivedAt).toBeUndefined();
    expect(restored.events?.at(-1)).toMatchObject({ kind: "unarchived" });
    await expect(store.claim(card.id, { ownerId: "worker" })).resolves.toMatchObject({
      card: { id: card.id, status: "running" },
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
