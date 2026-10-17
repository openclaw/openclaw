import { beforeEach, describe, expect, it, vi } from "vitest";
import * as dispatcherWorkspace from "./dispatcher-workspace.js";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import type { WorkboardStore } from "./store.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import * as workspaceAccess from "./workspace-access.js";

const CLAIM_RECLAIM_MS = 5 * 60 * 1000;

describe("Workboard dispatcher ownership", () => {
  let store: WorkboardStore;
  let run = vi.fn();
  beforeEach(() => {
    run = vi.fn();
  });
  const dispatch = (options: Parameters<typeof dispatchAndStartWorkboardCards>[0]["options"]) =>
    dispatchAndStartWorkboardCards({ store, subagent: { run }, options });
  const createReady = (input: Parameters<WorkboardStore["create"]>[0]) =>
    store.create({ status: "ready", workspaceAccess: { unrestricted: true }, ...input });
  it("bounds failed worker attempts without draining the ready queue", async () => {
    store = createWorkboardSqliteTestStore();

    const cards = [];
    for (let index = 0; index < 5; index += 1) {
      cards.push(
        await createReady({ title: `Queued worker ${index + 1}`, agentId: `worker-${index + 1}` }),
      );
    }
    run = vi.fn().mockRejectedValue(new Error("provider unavailable"));

    const result = await dispatch({ now: 10, maxStarts: 1 });

    expect(run).toHaveBeenCalledTimes(2);
    expect(result.started).toEqual([]);
    expect(result.startFailures.map((failure) => failure.cardId)).toEqual([
      cards[0]?.id,
      cards[1]?.id,
    ]);
    const persisted = await Promise.all(cards.map((card) => store.get(card.id)));
    expect(persisted).toMatchObject([
      { status: "blocked" },
      { status: "blocked" },
      { status: "ready" },
      { status: "ready" },
      { status: "ready" },
    ]);
    for (const rejected of persisted.slice(0, 2)) {
      expect(rejected).not.toHaveProperty("metadata.claim");
      expect(rejected).not.toHaveProperty("sessionKey");
      expect(rejected).not.toHaveProperty("runId");
      expect(rejected).not.toHaveProperty("execution");
    }
  });

  it("does not spend worker attempts on cards that fail workspace preflight", async () => {
    store = createWorkboardSqliteTestStore();

    const inaccessible = [];
    for (const [index, priority] of (["urgent", "high"] as const).entries()) {
      inaccessible.push(
        await store.create({
          title: `Inaccessible worker ${index + 1}`,
          status: "ready",
          priority,
          agentId: `inaccessible-worker-${index + 1}`,
          workspace: { kind: "worktree", path: "/repo" },
        }),
      );
    }
    const healthy = await createReady({ title: "Healthy worker", agentId: "healthy-worker" });
    run = vi.fn().mockResolvedValue({ runId: "run-healthy-worker" });

    const result = await dispatch({ now: 10, maxStarts: 1 });

    expect(result.startFailures.map((failure) => failure.cardId)).toEqual(
      inaccessible.map((card) => card.id),
    );
    expect(result.started).toEqual([
      expect.objectContaining({ cardId: healthy.id, runId: "run-healthy-worker" }),
    ]);
    expect(run).toHaveBeenCalledOnce();
    for (const card of inaccessible) {
      await expect(store.get(card.id)).resolves.toMatchObject({ status: "ready" });
    }
  });

  it("keeps missing-target preflight failures unclaimed and continues to a healthy card", async () => {
    store = createWorkboardSqliteTestStore();

    const error = "target agent workspace is unavailable for restricted dispatch";

    const rejected = [];
    for (const [index, priority] of (["urgent", "high"] as const).entries()) {
      rejected.push(
        await createReady({
          title: `Rejected worker ${index + 1}`,
          priority,
          agentId: `rejected-worker-${index + 1}`,
        }),
      );
    }
    const healthy = await createReady({ title: "Healthy worker", agentId: "healthy-worker" });
    const rejectedIds = new Set(rejected.map((card) => card.id));
    const before = await Promise.all(rejected.map((card) => store.get(card.id)));
    const resolveAccess = dispatcherWorkspace.resolveDispatchWorkspaceAccess;
    const resolve = vi
      .spyOn(dispatcherWorkspace, "resolveDispatchWorkspaceAccess")
      .mockImplementation(async (params) => {
        if (!rejectedIds.has(params.card.id)) {
          return await resolveAccess(params);
        }
        return {
          workspaceAccess: {
            unrestricted: false,
            roots: ["/workspace/denied"],
            writable: true,
          },
          persistWorkspaceAccess: false,
        };
      });
    const implicit = vi
      .spyOn(workspaceAccess, "assertCanonicalWorkboardRootAccess")
      .mockRejectedValue(new Error("implicit workspace denied"));
    const explicit = vi
      .spyOn(workspaceAccess, "assertWorkboardWorkspaceSourceAccess")
      .mockRejectedValue(new Error("explicit workspace denied"));
    const claim = vi.spyOn(store, "claim");
    const prepare = vi.spyOn(store, "prepareExecutionLaunch");
    const block = vi.spyOn(store, "block");
    const fail = vi.spyOn(store, "failPreparedLaunch");
    run = vi.fn().mockResolvedValue({ runId: "run-healthy-worker" });

    try {
      const result = await dispatch({ now: 10, maxStarts: 1 });

      expect(result.startFailures).toEqual(
        rejected.map((card) => ({ cardId: card.id, title: card.title, error })),
      );
      expect(result.started).toEqual([
        {
          cardId: healthy.id,
          title: healthy.title,
          sessionKey: expect.any(String),
          runId: "run-healthy-worker",
        },
      ]);
      expect(claim.mock.calls.map(([cardId]) => cardId)).toEqual([healthy.id]);
      expect(prepare.mock.calls.map(([cardId]) => cardId)).toEqual([healthy.id]);
      expect(run).toHaveBeenCalledOnce();
      expect(block).not.toHaveBeenCalled();
      expect(fail).not.toHaveBeenCalled();
      const after = await Promise.all(rejected.map((card) => store.get(card.id)));
      expect(after).toEqual(before);
      await expect(store.get(healthy.id)).resolves.toMatchObject({
        status: "running",
        execution: { runId: "run-healthy-worker" },
      });
    } finally {
      for (const spy of [resolve, implicit, explicit, claim, prepare, block, fail]) {
        spy.mockRestore();
      }
    }
  });

  it("tries a healthy owner before retrying a failed owner's queued cards", async () => {
    store = createWorkboardSqliteTestStore();

    const failed = await createReady({
      title: "Failing urgent worker",
      priority: "urgent",
      agentId: "unavailable-worker",
    });
    const deferred = await createReady({
      title: "Another unavailable worker card",
      priority: "high",
      agentId: "unavailable-worker",
    });
    const healthy = await createReady({
      title: "Healthy independent worker",
      agentId: "healthy-worker",
    });
    run = vi
      .fn()
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValueOnce({ runId: "run-healthy-owner" });

    const result = await dispatch({ now: 10, maxStarts: 1 });

    expect(run).toHaveBeenCalledTimes(2);
    expect(result.started).toEqual([
      expect.objectContaining({ cardId: healthy.id, runId: "run-healthy-owner" }),
    ]);
    expect(result.startFailures).toEqual([
      expect.objectContaining({ cardId: failed.id, error: "provider unavailable" }),
    ]);
    await expect(store.get(failed.id)).resolves.toMatchObject({ status: "blocked" });
    await expect(store.get(deferred.id)).resolves.toMatchObject({ status: "ready" });
    await expect(store.get(healthy.id)).resolves.toMatchObject({ status: "running" });
  });

  it("keeps a cross-board running worker slot for a different assigned agent until its heartbeat grace expires", async () => {
    const agentId = "assigned-worker";

    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      store = createWorkboardSqliteTestStore();

      const stale = await store.create({
        title: "Abandoned product worker",
        status: "running",
        agentId,
        boardId: "product",
        execution: {
          id: "stale-execution",
          kind: "agent-session",
          mode: "autonomous",
          status: "running",
          startedAt: 1,
          updatedAt: 1,
        },
      });
      const claimed = await store.claim(stale.id, {
        ownerId: "shared-worker",
        token: "stale-token",
        ttlSeconds: 1,
      });
      const ready = await createReady({
        title: "Ready operations recovery",
        agentId: "shared-worker",
        boardId: "ops",
      });
      run = vi.fn().mockResolvedValue({ runId: "run-after-grace" });
      const expiresAt = claimed.card.metadata?.claim?.expiresAt;
      expect(expiresAt).toBeDefined();

      vi.setSystemTime(expiresAt! + CLAIM_RECLAIM_MS);
      const withinGrace = await dispatch({
        maxStarts: 1,
        boardId: "ops",
      });

      expect(withinGrace.started).toEqual([]);
      expect(run).not.toHaveBeenCalled();
      await expect(store.get(stale.id)).resolves.toMatchObject({
        status: "running",
        execution: { status: "running" },
        metadata: { claim: { ownerId: "shared-worker" } },
      });

      vi.setSystemTime(expiresAt! + CLAIM_RECLAIM_MS + 1);
      const reclaimed = await dispatch({
        maxStarts: 1,
        boardId: "ops",
      });

      expect(reclaimed.started).toEqual([
        expect.objectContaining({ cardId: ready.id, runId: "run-after-grace" }),
      ]);
      expect(run).toHaveBeenCalledOnce();
      await expect(store.get(stale.id)).resolves.toMatchObject({
        status: "running",
        execution: { status: "running" },
        metadata: { claim: { ownerId: "shared-worker" } },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("selects at the dispatch snapshot while claiming at current time (10000, 50000)", async () => {
    const wallClock = 10_000;
    const dispatchNow = 50_000;

    vi.useFakeTimers();
    try {
      vi.setSystemTime(wallClock);
      store = createWorkboardSqliteTestStore();

      const review = await store.create({
        title: "Review claim with a deterministic expiry",
        status: "review",
        agentId: "shared-worker",
        metadata: {
          claim: {
            ownerId: "shared-worker",
            token: "timed-token",
            claimedAt: 1_000,
            lastHeartbeatAt: 1_000,
            expiresAt: 20_000,
          },
        },
      });
      const ready = await createReady({
        title: "Worker using dispatch-time capacity",
        agentId: "shared-worker",
      });
      run = vi.fn().mockResolvedValue({ runId: "run-at-dispatch-time" });
      const claim = vi.spyOn(store, "claim");

      const result = await dispatch({ now: dispatchNow, maxStarts: 1 });

      expect(claim.mock.calls.map(([id]) => id)).toEqual([ready.id]);
      expect(run).not.toHaveBeenCalled();
      expect(result.started).toEqual([]);
      expect(result.startFailures).toEqual([
        expect.objectContaining({
          cardId: ready.id,
          error: "Owner shared-worker already has active Workboard work.",
        }),
      ]);
      const unchangedReady = await store.get(ready.id);
      expect(unchangedReady?.status).toBe("ready");
      expect(unchangedReady?.metadata?.claim).toBeUndefined();
      await expect(store.get(review.id)).resolves.toMatchObject({
        status: "review",
        metadata: { claim: review.metadata?.claim },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("replaces an expired ready-card claim with the workboard-dispatcher slot", async () => {
    store = createWorkboardSqliteTestStore();

    const { agentId, ownerId } = { agentId: undefined, ownerId: "workboard-dispatcher" };

    const now = Date.now();
    const card = await createReady({
      title: "Ready with an expired lease",
      agentId,
      metadata: {
        claim: {
          ownerId: "retired-worker",
          token: "expired-token",
          claimedAt: now - 60_000,
          lastHeartbeatAt: now - 60_000,
          expiresAt: now - 1_000,
        },
      },
    });
    run = vi.fn().mockResolvedValue({ runId: "run-reclaimed" });

    const result = await dispatch({ maxStarts: 1 });

    expect(result.started).toEqual([
      expect.objectContaining({ cardId: card.id, runId: "run-reclaimed" }),
    ]);
    expect(run).toHaveBeenCalledOnce();
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "running",
      metadata: { claim: { ownerId } },
    });
    expect((await store.get(card.id))?.agentId).toBe(agentId);
    expect((await store.get(card.id))?.metadata?.claim?.token).not.toBe("expired-token");
  });

  it("serializes concurrent board dispatches for the same worker", async () => {
    store = createWorkboardSqliteTestStore();

    const ops = await createReady({
      title: "Ops shared worker",
      boardId: "ops",
      agentId: "shared-worker",
    });
    const product = await createReady({
      title: "Product shared worker",
      boardId: "product",
      agentId: "shared-worker",
    });
    const originalList = store.list.bind(store);
    let snapshotCount = 0;
    let releaseSnapshots: (() => void) | undefined;
    const snapshotsReleased = new Promise<void>((resolve) => {
      releaseSnapshots = resolve;
    });
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;
    vi.spyOn(store, "list").mockImplementation(async (options) => {
      const cards = await originalList(options);
      if (options === undefined && snapshotCount < 2) {
        snapshotCount += 1;
        if (snapshotCount === 1) {
          releaseTimer = setTimeout(() => releaseSnapshots?.(), 0);
        } else {
          if (releaseTimer !== undefined) {
            clearTimeout(releaseTimer);
          }
          releaseSnapshots?.();
        }
        await snapshotsReleased;
      }
      return cards;
    });
    run = vi.fn().mockResolvedValue({ runId: "run-shared-board" });

    const results = await Promise.all([
      dispatch({ boardId: "ops", maxStarts: 1 }),
      dispatch({ boardId: "product", maxStarts: 1 }),
    ]);

    expect(run).toHaveBeenCalledOnce();
    expect(results.flatMap((result) => result.started)).toEqual([
      expect.objectContaining({ cardId: ops.id, runId: "run-shared-board" }),
    ]);
    await expect(store.get(ops.id)).resolves.toMatchObject({
      status: "running",
      metadata: { claim: { ownerId: "shared-worker" } },
    });
    await expect(store.get(product.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("persists launch association before dashboard exact-card start and keeps accepted runs visible", async () => {
    store = createWorkboardSqliteTestStore();

    const card = await createReady({ title: "Worker with unavailable execution persistence" });
    vi.spyOn(store, "acceptExecutionLaunch").mockRejectedValue(
      new Error("execution enrichment unavailable"),
    );
    let provisionalRunId = "";
    const canonicalSessionKey = `agent:worker:subagent:workboard-default-${card.id}`;
    run = vi.fn().mockImplementation(async (input) => {
      provisionalRunId = input.idempotencyKey;
      const persisted = await store.get(card.id);
      expect(persisted).toMatchObject({
        status: "running",
        sessionKey: input.sessionKey,
        runId: provisionalRunId,
        execution: {
          status: "running",
          sessionKey: input.sessionKey,
          runId: provisionalRunId,
        },
        metadata: {
          automation: {
            launch: {
              phase: "prepared",
              requestedSessionKey: input.sessionKey,
              provisionalRunId,
            },
          },
        },
      });
      return { sessionKey: canonicalSessionKey, runId: "accepted-run" };
    });

    const result = await dispatch({
      maxStarts: 1,
      cardId: card.id,
    });

    expect(run).toHaveBeenCalledOnce();
    expect(result.started).toEqual([
      expect.objectContaining({
        cardId: card.id,
        sessionKey: canonicalSessionKey,
        runId: "accepted-run",
        card: expect.objectContaining({ sessionKey: canonicalSessionKey, runId: "accepted-run" }),
      }),
    ]);
    expect(result.startFailures).toEqual([]);
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "running",
      runId: provisionalRunId,
      execution: { status: "running", runId: provisionalRunId },
      metadata: {
        automation: { launch: { phase: "prepared", provisionalRunId } },
        claim: { ownerId: "workboard-dispatcher" },
        workerLogs: [expect.objectContaining({ runId: "accepted-run" })],
      },
    });
    await expect(
      store.heartbeat(card.id, { ownerId: "workboard-dispatcher" }),
    ).resolves.toMatchObject({
      status: "running",
      metadata: { claim: { ownerId: "workboard-dispatcher" } },
    });

    const retry = await dispatch({ maxStarts: 1 });

    expect(retry.started).toEqual([]);
    expect(retry.startFailures).toEqual([]);
    expect(run).toHaveBeenCalledOnce();
  });

  it("handles a future scheduled exact dashboard card", async () => {
    store = createWorkboardSqliteTestStore();

    const offsetMs = 60_000;

    const now = Date.now();
    const card = await store.create({
      title: "Scheduled exact",
      status: "scheduled",
      scheduledAt: now + offsetMs,
      agentId: "scheduled-worker",
      workspaceAccess: { unrestricted: true },
    });
    run = vi.fn().mockResolvedValue({ runId: "scheduled-run" });

    const result = await dispatch({ cardId: card.id, maxStarts: 1, now });

    expect(run).toHaveBeenCalledTimes(0);
    expect(result.started).toHaveLength(0);
    expect(result.startFailures).toHaveLength(1);
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "scheduled",
    });
  });

  it("starts the exact lower-priority card without selecting a sibling", async () => {
    store = createWorkboardSqliteTestStore();

    const urgent = await createReady({
      title: "Urgent sibling",
      priority: "urgent",
      agentId: "urgent-owner",
    });
    const target = await store.create({
      title: "Exact low priority",
      status: "todo",
      priority: "low",
      agentId: "target-owner",
      workspaceAccess: { unrestricted: true },
    });
    run = vi.fn().mockResolvedValue({ runId: "target-run" });

    const result = await dispatch({ cardId: target.id, maxStarts: 1 });

    expect(result.started).toEqual([expect.objectContaining({ cardId: target.id })]);
    await expect(store.get(urgent.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("keeps an accepted worker running when its worker log cannot be recorded", async () => {
    store = createWorkboardSqliteTestStore();

    const card = await createReady({ title: "Worker with unavailable logging" });
    run = vi.fn().mockResolvedValue({ runId: "run-without-log" });
    vi.spyOn(store, "addWorkerLog").mockRejectedValueOnce(new Error("logger unavailable"));

    const result = await dispatch({ maxStarts: 1 });

    expect(run).toHaveBeenCalledOnce();
    expect(result.started).toEqual([
      expect.objectContaining({ cardId: card.id, runId: "run-without-log" }),
    ]);
    expect(result.startFailures).toEqual([]);
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "running",
      runId: "run-without-log",
      execution: { status: "running", runId: "run-without-log" },
      metadata: { claim: { ownerId: "workboard-dispatcher" } },
    });
  });
});
