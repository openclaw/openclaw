import type { WorkboardExecution } from "@openclaw/workboard-contract";
import { describe, expect, it, vi } from "vitest";
import { createWorkboardLifecycleService, syncWorkboardSubagentEnded } from "./lifecycle-sync.js";
import type { WorkboardStore } from "./store.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

function execution(
  sessionKey: string,
  runId = "run-1",
  status: WorkboardExecution["status"] = "running",
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

async function createAcceptedClaimedCard(
  store: WorkboardStore,
  options: {
    ownerId: string;
    sessionKey: string;
    runId: string;
    requestedSessionKey?: string;
    agentId?: string;
  },
) {
  const card = await store.create({
    title: "Accepted claimed lifecycle",
    status: "ready",
    agentId: options.agentId,
  });
  const claimed = await store.claim(card.id, { ownerId: options.ownerId });
  const requestedSessionKey = options.requestedSessionKey ?? options.sessionKey;
  const prepared = await store.prepareExecutionLaunch(card.id, {
    requestedSessionKey,
    now: claimed.card.updatedAt + 1,
    scope: { ownerId: options.ownerId, token: claimed.token },
  });
  const accepted = await store.acceptExecutionLaunch(card.id, {
    expectedLaunch: prepared.launch,
    acceptedAt: prepared.card.updatedAt + 1,
    expectedSessionKey: requestedSessionKey,
    expectedRunId: prepared.launch.provisionalRunId,
    sessionKey: options.sessionKey,
    runId: options.runId,
    execution: execution(options.sessionKey, options.runId),
  });
  if (!accepted) {
    throw new Error("expected claimed launch acceptance");
  }
  return { card: accepted, token: claimed.token };
}

async function runSessionSweep(params: {
  store: WorkboardStore;
  sessions: Array<{
    key: string;
    updatedAt?: number;
    status?: "running" | "done" | "failed" | "killed" | "timeout";
    hasActiveRun?: boolean;
    abortedLastRun?: boolean;
    lastRunId?: string;
  }>;
  complete?: boolean;
  now?: number;
}) {
  const readSessions = vi.fn().mockResolvedValue({
    sessions: params.sessions,
    complete: params.complete ?? true,
  });
  const now = params.now;
  const service = createWorkboardLifecycleService({
    store: params.store,
    readSessions,
    ...(now === undefined ? {} : { now: () => now }),
  });
  const runOperation = vi.spyOn(params.store, "runOperation");
  try {
    await service.start({ logger: { warn: vi.fn() } } as never);
    service.onGatewayStart();
    // The admitted operation spans the full sweep, including SQLite worker writes.
    expect(runOperation).toHaveBeenCalled();
    await runOperation.mock.results[0]?.value;
    expect(readSessions).toHaveBeenCalledOnce();
  } finally {
    service.onGatewayStop();
    await service.stop?.({ logger: { warn: vi.fn() } } as never);
    runOperation.mockRestore();
  }
}

describe("Workboard terminal claim lifecycle", () => {
  it("releases an exact terminal claim from its accepted worker run", async () => {
    const store = createWorkboardSqliteTestStore();
    const sessionKey = "agent:le-commis:subagent:workboard-openclaw-terminal-claim";
    const runId = "workboard:terminal-claim:1789467554383";
    const accepted = await createAcceptedClaimedCard(store, {
      agentId: "le-commis",
      ownerId: "agent:le-commis:main",
      sessionKey,
      runId,
    });

    await syncWorkboardSubagentEnded({
      store,
      event: {
        targetSessionKey: sessionKey,
        runId,
        endedAt: accepted.card.updatedAt + 1,
        outcome: "ok",
      },
    });

    await expect(store.get(accepted.card.id)).resolves.toMatchObject({
      status: "review",
      execution: { status: "review", sessionKey, runId },
    });
    expect((await store.get(accepted.card.id))?.metadata?.claim).toBeUndefined();
  });

  it("ignores a prior launch's terminal event after a newer replacement claim", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const store = createWorkboardSqliteTestStore();
      const sessionKey = "agent:worker:subagent:workboard-openclaw-owner-mismatch";
      const runId = "run-owner-mismatch";
      const accepted = await createAcceptedClaimedCard(store, {
        ownerId: "agent:worker:main",
        sessionKey,
        runId,
      });
      await store.reclaim(
        accepted.card.id,
        { status: "todo", reason: "replace the accepted worker" },
        null,
      );
      const replacement = await store.claim(accepted.card.id, {
        ownerId: "agent:other:main",
        ttlSeconds: 60,
      });
      expect(replacement.card.execution).toBeUndefined();

      await syncWorkboardSubagentEnded({
        store,
        event: {
          targetSessionKey: sessionKey,
          runId,
          endedAt: replacement.card.updatedAt + 1,
          outcome: "ok",
        },
      });

      const current = await store.get(accepted.card.id);
      expect(current).toMatchObject({
        status: "running",
        metadata: { claim: { ownerId: "agent:other:main" } },
      });
      expect(current?.execution).toBeUndefined();
      vi.setSystemTime(31_000);
      const heartbeat = await store.heartbeat(accepted.card.id, { ownerId: "agent:other:main" });
      expect(heartbeat.metadata?.claim?.expiresAt).toBe(91_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains a terminal claim when the lifecycle event has no exact run identity", async () => {
    const store = createWorkboardSqliteTestStore();
    const sessionKey = "agent:worker:subagent:workboard-openclaw-run-missing";
    const runId = "run-current";
    const accepted = await createAcceptedClaimedCard(store, {
      ownerId: sessionKey,
      sessionKey,
      runId,
    });

    await syncWorkboardSubagentEnded({
      store,
      event: {
        targetSessionKey: sessionKey,
        endedAt: accepted.card.updatedAt + 1,
        outcome: "ok",
      },
    });

    await expect(store.get(accepted.card.id)).resolves.toMatchObject({
      status: "review",
      metadata: { claim: { ownerId: sessionKey } },
    });
  });

  it("retains an accepted claim while its worker session remains active", async () => {
    const store = createWorkboardSqliteTestStore();
    const sessionKey = "agent:worker:subagent:workboard-openclaw-live";
    const runId = "run-live";
    const accepted = await createAcceptedClaimedCard(store, {
      ownerId: sessionKey,
      sessionKey,
      runId,
    });

    await runSessionSweep({
      store,
      sessions: [
        {
          key: sessionKey,
          status: "running",
          hasActiveRun: true,
          updatedAt: accepted.card.updatedAt + 1,
        },
      ],
    });

    await expect(store.get(accepted.card.id)).resolves.toMatchObject({
      status: "running",
      execution: { status: "running", sessionKey, runId },
      metadata: { claim: { ownerId: sessionKey } },
    });
  });

  it("retains a terminal claim during restart recovery without exact run evidence", async () => {
    const store = createWorkboardSqliteTestStore();
    const sessionKey = "agent:worker:subagent:workboard-openclaw-restart-terminal";
    const runId = "run-restart-terminal";
    const accepted = await createAcceptedClaimedCard(store, {
      ownerId: sessionKey,
      sessionKey,
      runId,
    });

    await runSessionSweep({
      store,
      sessions: [
        {
          key: sessionKey,
          status: "done",
          hasActiveRun: false,
          updatedAt: accepted.card.updatedAt + 1,
        },
      ],
    });

    await expect(store.get(accepted.card.id)).resolves.toMatchObject({
      status: "review",
      metadata: { claim: { ownerId: sessionKey } },
    });
  });

  it("releases an exact terminal claim during restart recovery with exact run evidence", async () => {
    const store = createWorkboardSqliteTestStore();
    const sessionKey = "agent:worker:subagent:workboard-openclaw-restart-exact";
    const runId = "run-restart-exact";
    const accepted = await createAcceptedClaimedCard(store, {
      ownerId: sessionKey,
      sessionKey,
      runId,
    });

    await runSessionSweep({
      store,
      sessions: [
        {
          key: sessionKey,
          status: "done",
          hasActiveRun: false,
          lastRunId: runId,
          updatedAt: accepted.card.updatedAt + 1,
        },
      ],
    });

    await expect(store.get(accepted.card.id)).resolves.toMatchObject({
      status: "review",
      execution: { status: "review", sessionKey, runId },
    });
    expect((await store.get(accepted.card.id))?.metadata?.claim).toBeUndefined();
  });

  it("ignores a prior terminal session during restart recovery after a replacement claim", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const store = createWorkboardSqliteTestStore();
      const sessionKey = "agent:worker:subagent:workboard-openclaw-restart-replaced";
      const runId = "run-restart-replaced";
      const accepted = await createAcceptedClaimedCard(store, {
        ownerId: sessionKey,
        sessionKey,
        runId,
      });
      await store.reclaim(
        accepted.card.id,
        { status: "todo", reason: "replace the accepted worker" },
        null,
      );
      const replacement = await store.claim(accepted.card.id, {
        ownerId: "agent:other:main",
        ttlSeconds: 60,
      });

      await runSessionSweep({
        store,
        sessions: [
          {
            key: sessionKey,
            status: "done",
            hasActiveRun: false,
            lastRunId: runId,
            updatedAt: replacement.card.updatedAt + 1,
          },
        ],
      });

      const current = await store.get(accepted.card.id);
      expect(current).toMatchObject({
        status: "running",
        metadata: { claim: { ownerId: "agent:other:main" } },
      });
      expect(current?.execution).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a prior terminal hook while a replacement launch is prepared", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const store = createWorkboardSqliteTestStore();
      const sessionKey = "agent:worker:subagent:workboard-openclaw-prepared-replacement";
      const priorRunId = "run-prepared-replacement-prior";
      const accepted = await createAcceptedClaimedCard(store, {
        ownerId: sessionKey,
        sessionKey,
        runId: priorRunId,
      });
      await store.reclaim(
        accepted.card.id,
        { status: "todo", reason: "replace the accepted worker" },
        null,
      );
      const replacement = await store.claim(accepted.card.id, {
        ownerId: "agent:other:main",
        ttlSeconds: 60,
      });
      const prepared = await store.prepareExecutionLaunch(accepted.card.id, {
        requestedSessionKey: sessionKey,
        now: replacement.card.updatedAt + 1,
        scope: { ownerId: "agent:other:main", token: replacement.token },
      });

      const updated = await syncWorkboardSubagentEnded({
        store,
        event: {
          targetSessionKey: sessionKey,
          runId: priorRunId,
          endedAt: prepared.card.updatedAt + 1,
          outcome: "ok",
        },
      });

      expect(updated).toBe(0);
      await expect(store.get(accepted.card.id)).resolves.toMatchObject({
        status: "running",
        execution: { status: "running", runId: prepared.launch.provisionalRunId },
        metadata: {
          claim: { ownerId: "agent:other:main" },
          automation: { launch: { phase: "prepared" } },
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a prior terminal session while a replacement launch is prepared", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const store = createWorkboardSqliteTestStore();
      const sessionKey = "agent:worker:subagent:workboard-openclaw-restart-prepared-replacement";
      const priorRunId = "run-restart-prepared-replacement-prior";
      const accepted = await createAcceptedClaimedCard(store, {
        ownerId: sessionKey,
        sessionKey,
        runId: priorRunId,
      });
      await store.reclaim(
        accepted.card.id,
        { status: "todo", reason: "replace the accepted worker" },
        null,
      );
      const replacement = await store.claim(accepted.card.id, {
        ownerId: "agent:other:main",
        ttlSeconds: 60,
      });
      const prepared = await store.prepareExecutionLaunch(accepted.card.id, {
        requestedSessionKey: sessionKey,
        now: replacement.card.updatedAt + 1,
        scope: { ownerId: "agent:other:main", token: replacement.token },
      });

      await runSessionSweep({
        store,
        sessions: [
          {
            key: sessionKey,
            status: "done",
            hasActiveRun: false,
            lastRunId: priorRunId,
            updatedAt: prepared.card.updatedAt + 1,
          },
        ],
      });

      await expect(store.get(accepted.card.id)).resolves.toMatchObject({
        status: "running",
        execution: { status: "running", runId: prepared.launch.provisionalRunId },
        metadata: {
          claim: { ownerId: "agent:other:main" },
          automation: { launch: { phase: "prepared" } },
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores an older terminal run during restart recovery", async () => {
    const store = createWorkboardSqliteTestStore();
    const sessionKey = "agent:worker:subagent:workboard-openclaw-restart-older";
    const runId = "run-restart-current";
    const accepted = await createAcceptedClaimedCard(store, {
      ownerId: sessionKey,
      sessionKey,
      runId,
    });

    await runSessionSweep({
      store,
      sessions: [
        {
          key: sessionKey,
          status: "done",
          hasActiveRun: false,
          lastRunId: "run-restart-older",
          updatedAt: accepted.card.updatedAt + 1,
        },
      ],
    });

    await expect(store.get(accepted.card.id)).resolves.toMatchObject({
      status: "running",
      runId,
      execution: { status: "running", sessionKey, runId },
      metadata: { claim: { ownerId: sessionKey } },
    });
  });

  it.each(["error", "timeout", "killed"] as const)(
    "moves a linked running card to blocked for subagent outcome %s",
    async (outcome) => {
      const store = createWorkboardSqliteTestStore();
      const sessionKey = `agent:main:subagent:workboard-default-${outcome}`;
      const accepted = await createAcceptedClaimedCard(store, {
        ownerId: sessionKey,
        sessionKey,
        runId: `run-${outcome}`,
      });

      await syncWorkboardSubagentEnded({
        store,
        event: {
          targetSessionKey: sessionKey,
          runId: `run-${outcome}`,
          endedAt: accepted.card.updatedAt + 1,
          outcome,
        },
      });

      await expect(store.get(accepted.card.id)).resolves.toMatchObject({
        status: "blocked",
        execution: { status: "blocked" },
        metadata: { failureCount: 1 },
      });
      expect((await store.get(accepted.card.id))?.metadata?.claim).toBeUndefined();
    },
  );

  it("releases a claim and updates attempts once when duplicate failure hooks arrive", async () => {
    const store = createWorkboardSqliteTestStore();
    const sessionKey = "agent:main:subagent:workboard-default-failure";
    const runId = "run-failure";
    const accepted = await createAcceptedClaimedCard(store, {
      ownerId: sessionKey,
      sessionKey,
      runId,
    });
    const event = {
      targetSessionKey: sessionKey,
      runId,
      endedAt: accepted.card.updatedAt + 1,
      outcome: "error" as const,
    };

    await syncWorkboardSubagentEnded({ store, event });
    await syncWorkboardSubagentEnded({ store, event });

    const terminal = await store.get(accepted.card.id);
    expect(terminal).toMatchObject({
      metadata: { failureCount: 1, attempts: [expect.objectContaining({ status: "blocked" })] },
    });
    expect(terminal?.metadata?.claim).toBeUndefined();
  });

  it("backfills the exact terminal run identity without duplicating its attempt", async () => {
    const store = createWorkboardSqliteTestStore();
    const provisionalSessionKey = "subagent:workboard-default-terminal-backfill";
    const canonicalSessionKey = `agent:worker:${provisionalSessionKey}`;
    const created = await store.create({ title: "Terminal backfill", status: "ready" });
    const claimed = await store.claim(created.id, { ownerId: canonicalSessionKey });
    const prepared = await store.prepareExecutionLaunch(created.id, {
      requestedSessionKey: provisionalSessionKey,
      now: claimed.card.updatedAt + 1,
      scope: { ownerId: canonicalSessionKey, token: claimed.token },
    });
    const card = prepared.card;

    await syncWorkboardSubagentEnded({
      store,
      event: {
        targetSessionKey: canonicalSessionKey,
        runId: "accepted-run",
        endedAt: card.updatedAt + 1,
        outcome: "ok",
      },
    });

    const recovered = await store.get(card.id);
    expect(recovered).toMatchObject({
      status: "review",
      sessionKey: canonicalSessionKey,
      runId: "accepted-run",
      execution: {
        sessionKey: canonicalSessionKey,
        runId: "accepted-run",
        status: "review",
      },
    });
    expect(recovered?.metadata?.attempts).toEqual([
      expect.objectContaining({
        sessionKey: canonicalSessionKey,
        runId: "accepted-run",
        status: "succeeded",
      }),
    ]);
    expect(recovered?.metadata?.claim).toBeUndefined();
  });

  it("does not backfill over a newer attempt after lifecycle matching", async () => {
    const store = createWorkboardSqliteTestStore();
    const provisionalSessionKey = "subagent:workboard-default-match-race";
    const canonicalSessionKey = `agent:worker:${provisionalSessionKey}`;
    const created = await store.create({ title: "Match race", status: "ready" });
    const claimed = await store.claim(created.id, { ownerId: canonicalSessionKey });
    const prepared = await store.prepareExecutionLaunch(created.id, {
      requestedSessionKey: provisionalSessionKey,
      now: claimed.card.updatedAt + 1,
      scope: { ownerId: canonicalSessionKey, token: claimed.token },
    });
    const card = prepared.card;
    const newerSessionKey = "agent:newer:subagent:workboard-default-match-race";
    const originalSync = store.syncLifecycle.bind(store);
    vi.spyOn(store, "syncLifecycle").mockImplementationOnce(async (id, input) => {
      await store.update(id, {
        sessionKey: newerSessionKey,
        runId: "newer-run",
        execution: execution(newerSessionKey, "newer-run"),
      });
      return await originalSync(id, input);
    });

    await syncWorkboardSubagentEnded({
      store,
      event: {
        targetSessionKey: canonicalSessionKey,
        runId: "accepted-run",
        endedAt: card.updatedAt + 1,
        outcome: "ok",
      },
    });

    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "running",
      sessionKey: newerSessionKey,
      runId: "newer-run",
      execution: { status: "running", sessionKey: newerSessionKey, runId: "newer-run" },
    });
  });

  it("does not apply a delayed terminal event from an older accepted Workboard run", async () => {
    const store = createWorkboardSqliteTestStore();
    const requestedSessionKey = "subagent:workboard-default-retried";
    const sessionKey = `agent:worker:${requestedSessionKey}`;
    const created = await store.create({ title: "Retried accepted run", status: "ready" });
    const claimed = await store.claim(created.id, { ownerId: sessionKey });
    const prepared = await store.prepareExecutionLaunch(created.id, {
      requestedSessionKey,
      now: claimed.card.updatedAt + 1,
      scope: { ownerId: sessionKey, token: claimed.token },
    });
    const currentRunId = `workboard:${created.id}:200`;
    const accepted = await store.acceptExecutionLaunch(created.id, {
      expectedLaunch: prepared.launch,
      acceptedAt: prepared.card.updatedAt + 1,
      expectedSessionKey: requestedSessionKey,
      expectedRunId: prepared.launch.provisionalRunId,
      sessionKey,
      runId: currentRunId,
      execution: execution(sessionKey, currentRunId),
    });
    expect(accepted).toBeDefined();

    const updated = await syncWorkboardSubagentEnded({
      store,
      event: {
        targetSessionKey: sessionKey,
        runId: `workboard:${created.id}:100`,
        endedAt: (accepted?.updatedAt ?? prepared.card.updatedAt) + 1,
        outcome: "ok",
      },
    });

    expect(updated).toBe(0);
    await expect(store.get(created.id)).resolves.toMatchObject({
      status: "running",
      runId: currentRunId,
      execution: { runId: currentRunId, status: "running" },
      metadata: { claim: { ownerId: sessionKey } },
    });
  });
});
