import type { WorkboardExecution } from "@openclaw/workboard-contract";
import {
  createHookRunner,
  createMockPluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginService } from "../api.js";
import { createWorkboardAutomationNudgeService } from "./automation-nudge.js";
import {
  createWorkboardLifecycleService,
  readWorkboardLifecycleSessions,
  syncWorkboardAgentEnded,
  syncWorkboardSubagentEnded,
} from "./lifecycle-sync.js";
import { createDeferred, createLinkedCard } from "./lifecycle-sync.test-support.js";
import { workboardSessionKeyForCard } from "./session-link.js";
import type { WorkboardStore } from "./store.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

type ServiceContext = Parameters<OpenClawPluginService["start"]>[0];
type ServiceCron = NonNullable<ReturnType<NonNullable<ServiceContext["getCron"]>>>;

function nudgeContext(
  enqueueRun: NonNullable<ServiceCron["enqueueRun"]>,
  logger: ServiceContext["logger"] = { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
): ServiceContext {
  const unused = () => {
    throw new Error("Unexpected scheduler mutation");
  };
  return {
    config: {},
    stateDir: "unused",
    logger,
    getCron: () => ({
      enqueueRun,
      list: unused,
      add: unused,
      update: unused,
      remove: unused,
      removeStaleJobFamily: unused,
    }),
  };
}

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

async function runSessionSweep(params: {
  store: WorkboardStore;
  sessions: Array<{
    key: string;
    updatedAt?: number;
    status?: "running" | "done" | "failed" | "killed" | "timeout";
    hasActiveRun?: boolean;
    abortedLastRun?: boolean;
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

describe("Workboard gateway lifecycle sync", () => {
  it("uses the active service owner from a prepared plugin generation", async () => {
    const store = createWorkboardSqliteTestStore();
    await store.upsertBoard({ id: "planning", automationJobId: "job-categorize-planning" });
    const sessionKey = "agent:main:subagent:workboard-planning-card-generation";
    const card = await createLinkedCard(store, { boardId: "planning", sessionKey });
    const request = vi.fn().mockResolvedValue({ ok: true, ran: true });
    const activeService = createWorkboardAutomationNudgeService({ store });
    const generationService = createWorkboardAutomationNudgeService({ store });
    const info = vi.fn();
    const context = nudgeContext(request, { info, warn: vi.fn(), error: vi.fn() });
    await activeService.start(context);

    await syncWorkboardSubagentEnded({
      store,
      event: { targetSessionKey: sessionKey, endedAt: card.updatedAt + 1, outcome: "ok" },
      onMatched: generationService.nudge,
    });
    await activeService.stop?.(context);

    expect(info).toHaveBeenCalledWith(
      "workboard automation nudge requested for board planning: job job-categorize-planning",
    );
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("job-categorize-planning", "if-enabled");
  });

  it("fences a board lookup across service restart", async () => {
    const store = createWorkboardSqliteTestStore();
    await store.upsertBoard({ id: "planning", automationJobId: "job-categorize-planning" });
    const card = await createLinkedCard(store, { boardId: "planning" });
    const boards = await store.listBoards();
    const lookup = Promise.withResolvers<typeof boards>();
    vi.spyOn(store, "listBoards").mockReturnValueOnce(lookup.promise);
    const request = vi.fn().mockResolvedValue({ ok: true, queued: true, runId: "nudge" });
    const service = createWorkboardAutomationNudgeService({ store });
    const context = nudgeContext(request);
    await service.start(context);
    try {
      const pending = service.nudge({ cards: [card] });
      service.stop();
      await service.start(context);
      lookup.resolve(boards);
      await pending;
      expect(request).not.toHaveBeenCalled();

      await service.nudge({ cards: [card] });
      expect(request).toHaveBeenCalledExactlyOnceWith("job-categorize-planning", "if-enabled");
    } finally {
      lookup.resolve(boards);
      service.stop();
    }
  });

  it("does not nudge a matching card whose board has no automation", async () => {
    const store = createWorkboardSqliteTestStore();
    await store.upsertBoard({ id: "planning" });
    const sessionKey = "agent:main:subagent:workboard-planning-card-2";
    const card = await createLinkedCard(store, { boardId: "planning", sessionKey });
    const request = vi.fn();
    const service = createWorkboardAutomationNudgeService({ store });
    const context = nudgeContext(request);
    await service.start(context);

    await syncWorkboardSubagentEnded({
      store,
      event: { targetSessionKey: sessionKey, endedAt: card.updatedAt + 1, outcome: "ok" },
      onMatched: service.nudge,
    });
    await service.stop?.(context);

    expect(request).not.toHaveBeenCalled();
  });

  it("does not nudge from a cron-originated session", async () => {
    const sessionKey = "agent:main:cron:job-categorize-planning:run:run-1";
    const store = createWorkboardSqliteTestStore();
    await store.upsertBoard({ id: "planning", automationJobId: "job-categorize-planning" });
    const card = await createLinkedCard(store, { boardId: "planning", sessionKey });
    const request = vi.fn();
    const service = createWorkboardAutomationNudgeService({ store });
    const context = nudgeContext(request);
    await service.start(context);

    await syncWorkboardSubagentEnded({
      store,
      event: { targetSessionKey: sessionKey, endedAt: card.updatedAt + 1, outcome: "ok" },
      onMatched: service.nudge,
    });
    await service.stop?.(context);

    expect(request).not.toHaveBeenCalled();
  });

  it("coalesces repeated board nudges within the debounce window", async () => {
    const store = createWorkboardSqliteTestStore();
    await store.upsertBoard({ id: "planning", automationJobId: "job-categorize-planning" });
    const sessionKey = "agent:main:subagent:workboard-planning-card-3";
    const card = await createLinkedCard(store, { boardId: "planning", sessionKey });
    let resolveRun: (
      value: Awaited<ReturnType<NonNullable<ServiceCron["enqueueRun"]>>>,
    ) => void = () => undefined;
    const run = new Promise<Awaited<ReturnType<NonNullable<ServiceCron["enqueueRun"]>>>>(
      (resolve) => {
        resolveRun = resolve;
      },
    );
    const entered = Promise.withResolvers<void>();
    const request = vi.fn(() => {
      entered.resolve();
      return run;
    });
    const service = createWorkboardAutomationNudgeService({ store });
    const context = nudgeContext(request);
    await service.start(context);
    const event = {
      targetSessionKey: sessionKey,
      endedAt: card.updatedAt + 1,
      outcome: "ok" as const,
    };

    const first = syncWorkboardSubagentEnded({ store, event, onMatched: service.nudge });
    await entered.promise;
    await syncWorkboardSubagentEnded({ store, event, onMatched: service.nudge });
    resolveRun({ ok: true, ran: true });
    await first;
    await syncWorkboardSubagentEnded({ store, event, onMatched: service.nudge });
    await service.stop?.(context);

    expect(request).toHaveBeenCalledOnce();
  });

  it("swallows nudge failures without affecting lifecycle sync", async () => {
    const store = createWorkboardSqliteTestStore();
    await store.upsertBoard({ id: "planning", automationJobId: "job-categorize-planning" });
    const sessionKey = "agent:main:subagent:workboard-planning-card-4";
    const card = await createLinkedCard(store, { boardId: "planning", sessionKey });
    const request = vi.fn().mockRejectedValue(new Error("gateway unavailable"));
    const warn = vi.fn();
    const service = createWorkboardAutomationNudgeService({ store });
    const context = nudgeContext(request, { info: vi.fn(), warn, error: vi.fn() });
    await service.start(context);

    await expect(
      syncWorkboardSubagentEnded({
        store,
        event: { targetSessionKey: sessionKey, endedAt: card.updatedAt + 1, outcome: "ok" },
        onMatched: service.nudge,
      }),
    ).resolves.toBe(1);
    await service.stop?.(context);

    await expect(store.get(card.id)).resolves.toMatchObject({ status: "review" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("workboard automation nudge failed"));
  });

  it("logs disabled automation skips without affecting lifecycle sync", async () => {
    const store = createWorkboardSqliteTestStore();
    await store.upsertBoard({ id: "planning", automationJobId: "job-categorize-planning" });
    const sessionKey = "agent:main:subagent:workboard-planning-card-disabled";
    const card = await createLinkedCard(store, { boardId: "planning", sessionKey });
    const request = vi.fn().mockResolvedValue({ ok: true, ran: false, reason: "disabled" });
    const warn = vi.fn();
    const service = createWorkboardAutomationNudgeService({ store });
    const context = nudgeContext(request, { info: vi.fn(), warn, error: vi.fn() });
    await service.start(context);

    await expect(
      syncWorkboardSubagentEnded({
        store,
        event: { targetSessionKey: sessionKey, endedAt: card.updatedAt + 1, outcome: "ok" },
        onMatched: service.nudge,
      }),
    ).resolves.toBe(1);
    await service.stop?.(context);

    await expect(store.get(card.id)).resolves.toMatchObject({ status: "review" });
    expect(warn).toHaveBeenCalledWith(
      "workboard automation nudge skipped for board planning: job job-categorize-planning disabled",
    );
  });

  it("updates execution attempts once when duplicate failure hooks arrive", async () => {
    const store = createWorkboardSqliteTestStore();
    const sessionKey = "agent:main:subagent:workboard-default-failure";
    const card = await createLinkedCard(store, {
      sessionKey,
      runId: "run-failure",
      execution: execution(sessionKey, "run-failure"),
    });
    const event = {
      targetSessionKey: sessionKey,
      runId: "run-failure",
      endedAt: card.updatedAt + 1,
      outcome: "error" as const,
    };

    await syncWorkboardSubagentEnded({ store, event });
    await syncWorkboardSubagentEnded({ store, event });

    await expect(store.get(card.id)).resolves.toMatchObject({
      metadata: { failureCount: 1, attempts: [expect.objectContaining({ status: "blocked" })] },
    });
  });

  it("keeps completed cards done when their session is running", async () => {
    const status = "done";
    const store = createWorkboardSqliteTestStore();
    const sessionKey = `agent:main:dashboard:${status}`;
    const card = await createLinkedCard(store, { status, sessionKey });

    await runSessionSweep({
      store,
      sessions: [
        { key: sessionKey, status: "running", hasActiveRun: true, updatedAt: card.updatedAt + 1 },
      ],
      complete: true,
    });

    expect((await store.get(card.id))?.status).toBe("done");
  });

  it("keeps backlog cards in place after a terminal session event", async () => {
    const status = "backlog";
    const store = createWorkboardSqliteTestStore();
    const sessionKey = `agent:main:dashboard:terminal-${status}`;
    const card = await createLinkedCard(store, { status, sessionKey });

    await syncWorkboardSubagentEnded({
      store,
      event: { targetSessionKey: sessionKey, endedAt: card.updatedAt + 1, outcome: "ok" },
    });

    expect((await store.get(card.id))?.status).toBe("backlog");
  });

  it("matches cards by run id", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await createLinkedCard(store, { runId: "run-linked" });
    const sessionKey = "agent:main:dashboard:other";
    const runId = "run-linked";

    await syncWorkboardSubagentEnded({
      store,
      event: { targetSessionKey: sessionKey, runId, endedAt: card.updatedAt + 1, outcome: "ok" },
    });

    expect((await store.get(card.id))?.status).toBe("review");
  });

  it("does not let a stale dispatcher event override an explicit session link", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await createLinkedCard(store, {
      sessionKey: "agent:main:dashboard:replacement",
      agentId: "worker",
      boardId: "ops",
    });

    await syncWorkboardSubagentEnded({
      store,
      event: {
        targetSessionKey: workboardSessionKeyForCard(card),
        endedAt: card.updatedAt + 1,
        outcome: "ok",
      },
    });

    expect((await store.get(card.id))?.status).toBe("running");
  });

  it.each([
    ["agent:main:dashboard:incognito-agent-end", false, "blocked"],
    ["agent:main:dashboard:incognito-agent-end", true, "review"],
  ] as const)("settles %s after agent_end success=%s", async (sessionKey, success, status) => {
    const store = createWorkboardSqliteTestStore();
    const card = await createLinkedCard(store, {
      sessionKey,
      runId: "run-agent",
      execution: execution(sessionKey, "run-agent"),
    });

    const handler = vi.fn(async (...args: unknown[]) =>
      syncWorkboardAgentEnded({
        store,
        event: args[0] as Parameters<typeof syncWorkboardAgentEnded>[0]["event"],
        context: args[1] as Parameters<typeof syncWorkboardAgentEnded>[0]["context"],
        now: card.updatedAt + 1,
      }),
    );
    const runner = createHookRunner(createMockPluginRegistry([{ hookName: "agent_end", handler }]));
    await runner.runAgentEnd(
      { messages: [{ role: "user", content: "PRIVATE_INPUT" }], error: "PRIVATE_ERROR", success },
      { runId: "run-agent", sessionKey },
    );
    await expect(store.get(card.id)).resolves.toMatchObject({
      status,
      execution: { status },
    });
    expect(handler).toHaveBeenCalledOnce();
    if (sessionKey.includes("incognito-")) {
      expect(JSON.stringify(handler.mock.calls)).not.toContain("PRIVATE_");
    }
  });

  it("marks an inactive running session stale and clears it after recovery", async () => {
    const store = createWorkboardSqliteTestStore();
    const sessionKey = "agent:main:dashboard:stale";
    const card = await createLinkedCard(store, { status: "todo", sessionKey });
    const staleUpdatedAt = card.updatedAt + 1;
    const now = staleUpdatedAt + 31 * 60 * 1000;

    await runSessionSweep({
      store,
      sessions: [
        { key: sessionKey, status: "running", hasActiveRun: false, updatedAt: staleUpdatedAt },
      ],
      complete: true,
      now,
    });
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "running",
      metadata: {
        lifecycleStatusSourceUpdatedAt: staleUpdatedAt,
        stale: { lastSessionUpdatedAt: staleUpdatedAt },
      },
    });

    await runSessionSweep({
      store,
      sessions: [{ key: sessionKey, status: "running", hasActiveRun: true, updatedAt: now + 1 }],
      complete: true,
      now: now + 1,
    });

    expect((await store.get(card.id))?.metadata?.stale).toBeUndefined();
  });

  it("skips session discovery when no unarchived card needs lifecycle reconciliation", async () => {
    const store = createWorkboardSqliteTestStore();
    await store.create({ title: "Not dispatched", status: "ready" });
    const archived = await createLinkedCard(store, {
      sessionKey: "agent:retired:subagent:workboard-default-archived",
    });
    await store.archive(archived.id, true);
    const readSessions = vi.fn().mockResolvedValue({ sessions: [], complete: true });
    const context = { logger: { warn: vi.fn() } } as never;
    const service = createWorkboardLifecycleService({ store, readSessions });

    await service.start(context);
    service.onGatewayStart();
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    service.onGatewayStop();
    await service.stop?.(context);

    expect(readSessions).not.toHaveBeenCalled();
  });

  it("reconciles a captured unknown session when agent ownership is unambiguous", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await createLinkedCard(store, { sessionKey: "unknown" });
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === "agents.list") {
        return { selectionRequired: false };
      }
      return {
        sessions: [
          {
            key: "unknown",
            status: "done",
            hasActiveRun: false,
            updatedAt: card.updatedAt + 1,
          },
        ],
      };
    });
    const readSessions = vi.fn(
      async (options: { includeUnknown: boolean }) =>
        await readWorkboardLifecycleSessions({ isAvailable: async () => true, request }, options),
    );
    const context = { logger: { warn: vi.fn() } } as never;
    const service = createWorkboardLifecycleService({ store, readSessions });

    await service.start(context);
    service.onGatewayStart();
    await vi.waitFor(async () => expect((await store.get(card.id))?.status).toBe("review"));
    service.onGatewayStop();
    await service.stop?.(context);

    expect(readSessions).toHaveBeenCalledWith({ includeUnknown: true });
    expect(request).toHaveBeenNthCalledWith(1, "agents.list", {}, { scopes: ["operator.read"] });
    expect(request).toHaveBeenNthCalledWith(
      2,
      "sessions.list",
      expect.objectContaining({ includeGlobal: false, includeUnknown: true }),
      { scopes: ["operator.read"] },
    );
  });

  it("does not suffix-match a uniquely wrong agent for an explicit target", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await createLinkedCard(store, { agentId: "worker", boardId: "ops" });
    const sessionKey = workboardSessionKeyForCard(card);
    const suffix = sessionKey.slice(sessionKey.indexOf("subagent:workboard-"));

    await runSessionSweep({
      store,
      sessions: [
        {
          key: `agent:other:${suffix}`,
          status: "done",
          hasActiveRun: false,
          updatedAt: card.updatedAt + 1,
        },
      ],
    });

    expect((await store.get(card.id))?.status).toBe("running");
  });

  it("does not backfill over a newer attempt after lifecycle matching", async () => {
    const store = createWorkboardSqliteTestStore();
    const provisionalSessionKey = "subagent:workboard-default-match-race";
    const created = await createLinkedCard(store, { sessionKey: provisionalSessionKey });
    const provisionalRunId = `workboard:${created.id}:${created.updatedAt}`;
    const card = await store.update(created.id, {
      runId: provisionalRunId,
      execution: execution(provisionalSessionKey, provisionalRunId),
    });
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
        targetSessionKey: `agent:worker:${provisionalSessionKey}`,
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

  it("does not apply a delayed terminal event from an older accepted run", async () => {
    const store = createWorkboardSqliteTestStore();
    const sessionKey = "agent:worker:subagent:workboard-default-retried";
    const card = await createLinkedCard(store, {
      sessionKey,
      runId: "current-run",
      execution: execution(sessionKey, "current-run"),
    });

    const updated = await syncWorkboardSubagentEnded({
      store,
      event: {
        targetSessionKey: sessionKey,
        runId: "older-run",
        endedAt: card.updatedAt + 1,
        outcome: "ok",
      },
    });

    expect(updated).toBe(0);
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "running",
      runId: "current-run",
      execution: { runId: "current-run", status: "running" },
    });
  });

  it("does not suffix-match an agentless card when configured-agent sessions are ambiguous", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({ title: "Ambiguous accepted run", status: "ready" });
    const acceptedSessionKey = workboardSessionKeyForCard(card);
    const claimed = await store.claim(card.id, { ownerId: "workboard-dispatcher" });

    await runSessionSweep({
      store,
      sessions: [
        {
          key: `agent:alpha:${acceptedSessionKey}`,
          status: "done",
          updatedAt: claimed.card.updatedAt + 1,
        },
        {
          key: `agent:beta:${acceptedSessionKey}`,
          status: "failed",
          updatedAt: claimed.card.updatedAt + 1,
        },
      ],
    });

    expect((await store.get(card.id))?.status).toBe("running");
  });

  it("suffix-matches an agentless linked card to an agent-prefixed Workboard session", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await createLinkedCard(store, { boardId: "ops" });
    const sessionKey = `agent:worker:${workboardSessionKeyForCard(card)}`;

    await runSessionSweep({
      store,
      sessions: [
        { key: sessionKey, status: "done", hasActiveRun: false, updatedAt: card.updatedAt + 1 },
      ],
    });

    expect((await store.get(card.id))?.status).toBe("review");
  });

  it("keeps unknown excluded when explicit ownership requires agent selection", async () => {
    const request = vi.fn().mockImplementation(async (method: string, options: object) => {
      if (method === "agents.list") {
        return { selectionRequired: true };
      }
      expect(method).toBe("sessions.list");
      expect(options).toMatchObject({ includeGlobal: false, includeUnknown: false });
      return { sessions: [] };
    });

    await expect(
      readWorkboardLifecycleSessions(
        { isAvailable: async () => true, request },
        { includeUnknown: true },
      ),
    ).resolves.toEqual({ sessions: [], complete: true });
  });

  it("returns an incomplete empty snapshot without requesting while Gateway is unavailable", async () => {
    const request = vi.fn();

    await expect(
      readWorkboardLifecycleSessions({ isAvailable: async () => false, request }),
    ).resolves.toEqual({ sessions: [], complete: false });
    expect(request).not.toHaveBeenCalled();
  });

  it("treats a full sessions.list page as possibly truncated", async () => {
    // Keep a full page conservative even when a mock or older peer omits pagination
    // metadata, or absent sessions could be marked missing.
    const request = vi.fn().mockResolvedValue({
      sessions: Array.from({ length: 10_000 }, (_, index) => ({
        key: `agent:main:dashboard:${index}`,
        status: "done",
      })),
    });

    const snapshot = await readWorkboardLifecycleSessions({
      isAvailable: async () => true,
      request,
    });
    expect(snapshot.complete).toBe(false);
    expect(snapshot.sessions).toHaveLength(10_000);
  });
});

function createSessionReader(sessionKey: string, updatedAt: number) {
  return vi
    .fn()
    .mockResolvedValueOnce({
      sessions: [
        { key: sessionKey, status: "running", hasActiveRun: true, updatedAt: updatedAt + 1 },
      ],
      complete: true,
    })
    .mockResolvedValueOnce({
      sessions: [
        { key: sessionKey, status: "done", hasActiveRun: false, updatedAt: updatedAt + 2 },
      ],
      complete: true,
    });
}

describe("Workboard lifecycle service", () => {
  it.each(["interval", "plugin reload"] as const)(
    "waits for Gateway readiness and reconciles again after %s until drain",
    async (trigger) => {
      const store = createWorkboardSqliteTestStore();
      const sessionKey = "agent:main:dashboard:startup-ready";
      const card = await createLinkedCard(store, { status: "todo", sessionKey });
      const readReadySessions = createSessionReader(sessionKey, card.updatedAt);
      let gatewayReady = false;
      const readSessions = vi.fn(async () => {
        if (!gatewayReady) {
          throw new Error("sessions.list unavailable during gateway startup");
        }
        return readReadySessions();
      });
      const warn = vi.fn();
      const original = createWorkboardLifecycleService({ store, readSessions });
      const replacement = createWorkboardLifecycleService({ store, readSessions });
      const context = { logger: { warn } } as never;
      const lifetime = new AbortController();
      const runOperation = vi.spyOn(store, "runOperation");
      vi.useFakeTimers();
      try {
        await original.start(context);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(readSessions).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();

        gatewayReady = true;
        original.onGatewayStart(lifetime.signal);
        expect(runOperation).toHaveBeenCalled();
        await runOperation.mock.results[0]?.value;
        expect((await store.get(card.id))?.status).toBe("running");
        expect(readSessions).toHaveBeenCalledOnce();
        expect(warn).not.toHaveBeenCalled();

        runOperation.mockClear();
        if (trigger === "plugin reload") {
          original.stop();
          await replacement.start(context);
        } else {
          // The interval is armed only after the admitted sweep settles.
          await vi.advanceTimersByTimeAsync(60_000);
        }
        expect(runOperation).toHaveBeenCalled();
        await runOperation.mock.results[0]?.value;
        expect((await store.get(card.id))?.status).toBe("review");
        const admittedSweeps = runOperation.mock.calls.length;
        lifetime.abort();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(runOperation).toHaveBeenCalledTimes(admittedSweeps);
        expect(readSessions).toHaveBeenCalledTimes(2);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        original.stop();
        replacement.onGatewayStop();
        await runOperation.mock.results[0]?.value;
        runOperation.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it("fences an in-flight session read as soon as the Gateway drains", async () => {
    const store = createWorkboardSqliteTestStore();
    await createLinkedCard(store, { sessionKey: "agent:main:dashboard:draining" });
    const runOperation = vi.spyOn(store, "runOperation");
    const lifetime = new AbortController();
    const readEntered = createDeferred<void>();
    const readResult = createDeferred<{ sessions: []; complete: boolean }>();
    const readSessions = vi.fn(async () => {
      readEntered.resolve();
      return await readResult.promise;
    });
    const warn = vi.fn();
    const service = createWorkboardLifecycleService({ store, readSessions });
    vi.useFakeTimers();
    try {
      await service.start({ logger: { warn } } as never);
      service.onGatewayStart(lifetime.signal);
      await readEntered.promise;
      lifetime.abort();
      readResult.reject(new Error("Gateway request entry is closed"));
      await runOperation.mock.results[0]?.value;
      const admittedSweeps = runOperation.mock.calls.length;
      await vi.advanceTimersByTimeAsync(3 * 60_000);

      expect(runOperation).toHaveBeenCalledTimes(admittedSweeps);
      expect(readSessions).toHaveBeenCalledOnce();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      readResult.resolve({ sessions: [], complete: true });
      service.onGatewayStop();
      await runOperation.mock.results[0]?.value;
      runOperation.mockRestore();
      vi.useRealTimers();
    }
  });
});
