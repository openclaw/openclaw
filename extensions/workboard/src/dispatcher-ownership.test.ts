import { describe, expect, it, vi } from "vitest";
import * as dispatcherWorkspace from "./dispatcher-workspace.js";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import {
  createWorkboardSqliteTestHarness,
  createWorkboardSqliteTestStore,
} from "./test/sqlite-store.js";
import * as workspaceAccess from "./workspace-access.js";

const CLAIM_RECLAIM_MS = 5 * 60 * 1000;

describe("Workboard dispatcher ownership", () => {
  it("falls back to one default owner for persisted blank and unassigned agents", async () => {
    const { store, stores } = createWorkboardSqliteTestHarness();
    const keyed = stores.cards;
    const blankAgent = await store.create({
      title: "Blank agent worker",
      status: "ready",
      priority: "urgent",
      workspaceAccess: { unrestricted: true },
    });
    await keyed.register(blankAgent.id, {
      version: 1,
      card: { ...blankAgent, agentId: "" },
    });
    const unassigned = await store.create({
      title: "Unassigned worker",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-default-owner" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 3 },
    });

    expect(result.started).toEqual([
      expect.objectContaining({ cardId: blankAgent.id, runId: "run-default-owner" }),
    ]);
    expect(run).toHaveBeenCalledOnce();
    await expect(store.get(blankAgent.id)).resolves.toMatchObject({
      status: "running",
      metadata: { claim: { ownerId: "workboard-dispatcher" } },
    });
    await expect(store.get(unassigned.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("keeps an active blank-assignment card in the default worker slot", async () => {
    const { store, stores } = createWorkboardSqliteTestHarness();
    const keyed = stores.cards;
    const active = await store.create({
      title: "Active default worker",
      status: "running",
      workspaceAccess: { unrestricted: true },
    });
    await keyed.register(active.id, {
      version: 1,
      card: { ...active, agentId: "" },
    });
    const queued = await store.create({
      title: "Queued default worker",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "unexpected-second-worker" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 1 },
    });

    expect(result.started).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    await expect(store.get(queued.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("bounds failed worker attempts without draining the ready queue", async () => {
    const store = createWorkboardSqliteTestStore();
    const cards = [];
    for (let index = 0; index < 5; index += 1) {
      cards.push(
        await store.create({
          title: `Queued worker ${index + 1}`,
          status: "ready",
          agentId: `worker-${index + 1}`,
          workspaceAccess: { unrestricted: true },
        }),
      );
    }
    const run = vi.fn().mockRejectedValue(new Error("provider unavailable"));

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 1 },
    });

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
    const store = createWorkboardSqliteTestStore();
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
    const healthy = await store.create({
      title: "Healthy worker",
      status: "ready",
      agentId: "healthy-worker",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-healthy-worker" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 1 },
    });

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

  it.each([
    { stage: "authority", error: "workspace authority unavailable" },
    { stage: "implicit", error: "implicit workspace denied" },
    { stage: "explicit", error: "explicit workspace denied" },
    {
      stage: "missing-target",
      error: "target agent workspace is unavailable for restricted dispatch",
    },
    { stage: "non-error", error: "non-Error authority failure" },
  ])(
    "keeps $stage preflight failures unclaimed and continues to a healthy card",
    async ({ stage, error }) => {
      const store = createWorkboardSqliteTestStore();
      const rejected = [];
      const workspace: Parameters<typeof store.create>[0]["workspace"] =
        stage === "explicit" ? { kind: "dir", path: "/workspace/denied" } : undefined;
      for (const [index, priority] of (["urgent", "high"] as const).entries()) {
        rejected.push(
          await store.create({
            title: `Rejected worker ${index + 1}`,
            status: "ready",
            priority,
            agentId: `rejected-worker-${index + 1}`,
            workspaceAccess: { unrestricted: true },
            ...(workspace ? { workspace } : {}),
          }),
        );
      }
      const healthy = await store.create({
        title: "Healthy worker",
        status: "ready",
        agentId: "healthy-worker",
        workspaceAccess: { unrestricted: true },
      });
      const rejectedIds = new Set(rejected.map((card) => card.id));
      const before = await Promise.all(rejected.map((card) => store.get(card.id)));
      const resolveAccess = dispatcherWorkspace.resolveDispatchWorkspaceAccess;
      const resolve = vi
        .spyOn(dispatcherWorkspace, "resolveDispatchWorkspaceAccess")
        .mockImplementation(async (params) => {
          if (!rejectedIds.has(params.card.id)) {
            return await resolveAccess(params);
          }
          if (stage === "authority") {
            throw new Error("workspace authority unavailable");
          }
          if (stage === "non-error") {
            return await vi
              .fn<() => Promise<never>>()
              .mockRejectedValue("non-Error authority failure")();
          }
          return {
            workspaceAccess: {
              unrestricted: false,
              roots: ["/workspace/denied"],
              writable: true,
            },
            ...(stage === "missing-target" ? {} : { targetWorkspace: "/workspace/denied" }),
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
      const run = vi.fn().mockResolvedValue({ runId: "run-healthy-worker" });

      try {
        const result = await dispatchAndStartWorkboardCards({
          store,
          subagent: { run },
          options: { now: 10, maxStarts: 1 },
        });

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
    },
  );

  it("tries a healthy owner before retrying a failed owner's queued cards", async () => {
    const store = createWorkboardSqliteTestStore();
    const failed = await store.create({
      title: "Failing urgent worker",
      status: "ready",
      priority: "urgent",
      agentId: "unavailable-worker",
      workspaceAccess: { unrestricted: true },
    });
    const deferred = await store.create({
      title: "Another unavailable worker card",
      status: "ready",
      priority: "high",
      agentId: "unavailable-worker",
      workspaceAccess: { unrestricted: true },
    });
    const healthy = await store.create({
      title: "Healthy independent worker",
      status: "ready",
      agentId: "healthy-worker",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValueOnce({ runId: "run-healthy-owner" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 1 },
    });

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

  it.each([
    { name: "matching", agentId: "shared-worker" },
    { name: "different", agentId: "assigned-worker" },
  ])(
    "keeps a cross-board running worker slot for a $name assigned agent until its heartbeat grace expires",
    async ({ agentId }) => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(10_000);
        const store = createWorkboardSqliteTestStore();
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
        const ready = await store.create({
          title: "Ready operations recovery",
          status: "ready",
          agentId: "shared-worker",
          boardId: "ops",
          workspaceAccess: { unrestricted: true },
        });
        const run = vi.fn().mockResolvedValue({ runId: "run-after-grace" });
        const expiresAt = claimed.card.metadata?.claim?.expiresAt;
        expect(expiresAt).toBeDefined();

        vi.setSystemTime(expiresAt! + CLAIM_RECLAIM_MS);
        const withinGrace = await dispatchAndStartWorkboardCards({
          store,
          subagent: { run },
          options: {
            maxStarts: 1,
            boardId: "ops",
          },
        });

        expect(withinGrace.started).toEqual([]);
        expect(run).not.toHaveBeenCalled();
        await expect(store.get(stale.id)).resolves.toMatchObject({
          status: "running",
          execution: { status: "running" },
          metadata: { claim: { ownerId: "shared-worker" } },
        });

        vi.setSystemTime(expiresAt! + CLAIM_RECLAIM_MS + 1);
        const reclaimed = await dispatchAndStartWorkboardCards({
          store,
          subagent: { run },
          options: {
            maxStarts: 1,
            boardId: "ops",
          },
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
    },
  );

  it.each([
    { wallClock: 10_000, dispatchNow: 50_000, expectedClaimAttempts: 1 },
    { wallClock: 50_000, dispatchNow: 10_000, expectedClaimAttempts: 0 },
  ])(
    "selects at the dispatch snapshot while claiming at current time ($wallClock, $dispatchNow)",
    async ({ wallClock, dispatchNow, expectedClaimAttempts }) => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(wallClock);
        const store = createWorkboardSqliteTestStore();
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
        const ready = await store.create({
          title: "Worker using dispatch-time capacity",
          status: "ready",
          agentId: "shared-worker",
          workspaceAccess: { unrestricted: true },
        });
        const run = vi.fn().mockResolvedValue({ runId: "run-at-dispatch-time" });
        const claim = vi.spyOn(store, "claim");

        const result = await dispatchAndStartWorkboardCards({
          store,
          subagent: { run },
          options: { now: dispatchNow, maxStarts: 1 },
        });

        expect(claim.mock.calls.map(([id]) => id)).toEqual(
          expectedClaimAttempts === 1 ? [ready.id] : [],
        );
        expect(run).not.toHaveBeenCalled();
        expect(result.started).toEqual([]);
        expect(result.startFailures).toEqual(
          expectedClaimAttempts === 1
            ? [
                expect.objectContaining({
                  cardId: ready.id,
                  error: "Owner shared-worker already has active Workboard work.",
                }),
              ]
            : [],
        );
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
    },
  );

  it.each([
    { agentId: "shared-worker", ownerId: "shared-worker" },
    { agentId: undefined, ownerId: "workboard-dispatcher" },
  ])(
    "replaces an expired ready-card claim with the $ownerId slot",
    async ({ agentId, ownerId }) => {
      const store = createWorkboardSqliteTestStore();
      const now = Date.now();
      const card = await store.create({
        title: "Ready with an expired lease",
        status: "ready",
        agentId,
        workspaceAccess: { unrestricted: true },
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
      const run = vi.fn().mockResolvedValue({ runId: "run-reclaimed" });

      const result = await dispatchAndStartWorkboardCards({
        store,
        subagent: { run },
        options: { maxStarts: 1 },
      });

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
    },
  );

  it("serializes concurrent board dispatches for the same worker", async () => {
    const store = createWorkboardSqliteTestStore();
    const ops = await store.create({
      title: "Ops shared worker",
      status: "ready",
      boardId: "ops",
      agentId: "shared-worker",
      workspaceAccess: { unrestricted: true },
    });
    const product = await store.create({
      title: "Product shared worker",
      status: "ready",
      boardId: "product",
      agentId: "shared-worker",
      workspaceAccess: { unrestricted: true },
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
    const run = vi.fn().mockResolvedValue({ runId: "run-shared-board" });

    const results = await Promise.all([
      dispatchAndStartWorkboardCards({
        store,
        subagent: { run },
        options: { boardId: "ops", maxStarts: 1 },
      }),
      dispatchAndStartWorkboardCards({
        store,
        subagent: { run },
        options: { boardId: "product", maxStarts: 1 },
      }),
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

  it.each(["scheduled dispatch", "dashboard exact-card start"] as const)(
    "persists launch association before %s and keeps accepted runs visible",
    async (origin) => {
      const store = createWorkboardSqliteTestStore();
      const card = await store.create({
        title: "Worker with unavailable execution persistence",
        status: "ready",
        workspaceAccess: { unrestricted: true },
      });
      vi.spyOn(store, "acceptExecutionLaunch").mockRejectedValue(
        new Error("execution enrichment unavailable"),
      );
      let provisionalRunId = "";
      const canonicalSessionKey = `agent:worker:subagent:workboard-default-${card.id}`;
      const run = vi.fn().mockImplementation(async (input) => {
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

      const result = await dispatchAndStartWorkboardCards({
        store,
        subagent: { run },
        options: {
          maxStarts: 1,
          ...(origin === "dashboard exact-card start" ? { cardId: card.id } : {}),
        },
      });

      expect(run).toHaveBeenCalledOnce();
      expect(result.started).toEqual([
        expect.objectContaining({
          cardId: card.id,
          sessionKey: canonicalSessionKey,
          runId: "accepted-run",
          ...(origin === "dashboard exact-card start"
            ? {
                card: expect.objectContaining({
                  sessionKey: canonicalSessionKey,
                  runId: "accepted-run",
                }),
              }
            : {}),
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

      const retry = await dispatchAndStartWorkboardCards({
        store,
        subagent: { run },
        options: { maxStarts: 1 },
      });

      expect(retry.started).toEqual([]);
      expect(retry.startFailures).toEqual([]);
      expect(run).toHaveBeenCalledOnce();
    },
  );

  it("marks a prepared launch accepted after Gateway acceptance", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Worker with durable acceptance",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });
    const canonicalSessionKey = `agent:worker:subagent:workboard-default-${card.id}`;
    let provisionalRunId = "";
    const run = vi.fn().mockImplementation(async (input) => {
      provisionalRunId = input.idempotencyKey;
      await expect(store.get(card.id)).resolves.toMatchObject({
        sessionKey: input.sessionKey,
        runId: provisionalRunId,
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

    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { maxStarts: 1 },
    });

    await expect(store.get(card.id)).resolves.toMatchObject({
      sessionKey: canonicalSessionKey,
      runId: "accepted-run",
      metadata: {
        automation: {
          launch: {
            phase: "accepted",
            requestedSessionKey: expect.any(String),
            provisionalRunId,
            acceptedSessionKey: canonicalSessionKey,
            acceptedRunId: "accepted-run",
          },
        },
      },
    });
  });

  it.each(["backlog", "todo", "ready"] as const)(
    "starts an exact dashboard card from %s",
    async (status) => {
      const store = createWorkboardSqliteTestStore();
      const card = await store.create({
        title: `Exact ${status}`,
        status,
        agentId: `worker-${status}`,
        workspaceAccess: { unrestricted: true },
      });
      const run = vi.fn().mockResolvedValue({ runId: `run-${status}` });

      const result = await dispatchAndStartWorkboardCards({
        store,
        subagent: { run },
        options: { cardId: card.id, maxStarts: 1 },
      });

      expect(result.started).toEqual([expect.objectContaining({ cardId: card.id })]);
      expect(result.startFailures).toEqual([]);
      expect((await store.get(card.id))?.status).toBe("running");
    },
  );

  it("rejects an exact dashboard card in blocked status", async () => {
    const status = "blocked";
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: `Invalid exact ${status}`,
      status,
      agentId: `worker-${status}`,
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { cardId: card.id, maxStarts: 1 },
    });

    expect(run).not.toHaveBeenCalled();
    expect(result.started).toEqual([]);
    expect(result.startFailures).toEqual([
      expect.objectContaining({
        cardId: card.id,
        error: expect.stringContaining(status),
      }),
    ]);
    await expect(store.get(card.id)).resolves.toMatchObject({
      status,
      metadata: expect.not.objectContaining({ claim: expect.anything() }),
    });
  });

  it.each([
    { label: "due", offsetMs: -1_000, starts: true },
    { label: "future", offsetMs: 60_000, starts: false },
  ])("handles a $label scheduled exact dashboard card", async ({ offsetMs, starts }) => {
    const store = createWorkboardSqliteTestStore();
    const now = Date.now();
    const card = await store.create({
      title: "Scheduled exact",
      status: "scheduled",
      scheduledAt: now + offsetMs,
      agentId: "scheduled-worker",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "scheduled-run" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { cardId: card.id, maxStarts: 1, now },
    });

    expect(run).toHaveBeenCalledTimes(starts ? 1 : 0);
    expect(result.started).toHaveLength(starts ? 1 : 0);
    expect(result.startFailures).toHaveLength(starts ? 0 : 1);
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: starts ? "running" : "scheduled",
    });
  });

  it("keeps global owner capacity for exact dashboard starts across boards", async () => {
    const store = createWorkboardSqliteTestStore();
    const active = await store.create({
      title: "Active owner",
      status: "ready",
      boardId: "ops",
      agentId: "shared-owner",
      workspaceAccess: { unrestricted: true },
    });
    await store.claim(active.id, { ownerId: "shared-owner" });
    const target = await store.create({
      title: "Blocked exact owner",
      status: "todo",
      boardId: "product",
      agentId: "shared-owner",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { cardId: target.id, maxStarts: 1 },
    });

    expect(run).not.toHaveBeenCalled();
    expect(result.startFailures).toEqual([
      expect.objectContaining({ error: expect.stringContaining("shared-owner") }),
    ]);
    await expect(store.get(target.id)).resolves.toMatchObject({ status: "todo" });
  });

  it("starts the exact lower-priority card without selecting a sibling", async () => {
    const store = createWorkboardSqliteTestStore();
    const urgent = await store.create({
      title: "Urgent sibling",
      status: "ready",
      priority: "urgent",
      agentId: "urgent-owner",
      workspaceAccess: { unrestricted: true },
    });
    const target = await store.create({
      title: "Exact low priority",
      status: "todo",
      priority: "low",
      agentId: "target-owner",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "target-run" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { cardId: target.id, maxStarts: 1 },
    });

    expect(result.started).toEqual([expect.objectContaining({ cardId: target.id })]);
    await expect(store.get(urgent.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("keeps an accepted worker running when its worker log cannot be recorded", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Worker with unavailable logging",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-without-log" });
    vi.spyOn(store, "addWorkerLog").mockRejectedValueOnce(new Error("logger unavailable"));

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { maxStarts: 1 },
    });

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
