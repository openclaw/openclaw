import {
  createHookRunner,
  createMockPluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkboardAutomationNudgeService } from "./automation-nudge.js";
import {
  execution,
  lifecycleSession,
  lifecycleSnapshot,
  serviceContext,
  type LifecycleSnapshot,
} from "./lifecycle-sync-fixtures.test-support.js";
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

type ServiceContext = ReturnType<typeof serviceContext>;
type ServiceCron = NonNullable<ReturnType<NonNullable<ServiceContext["getCron"]>>>;

function nudgeContext(
  enqueueRun: NonNullable<ServiceCron["enqueueRun"]>,
  logger: ServiceContext["logger"] = { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
): ServiceContext {
  const unused = () => {
    throw new Error("Unexpected scheduler mutation");
  };
  return {
    ...serviceContext(logger),
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

type Session = LifecycleSnapshot["sessions"][number];
let store: WorkboardStore;
const resetStore = () => {
  store = createWorkboardSqliteTestStore();
};
async function linked(options: Parameters<typeof createLinkedCard>[1] = {}) {
  const card = await createLinkedCard(store, options);
  const end = (event: Partial<Parameters<typeof syncWorkboardSubagentEnded>[0]["event"]> = {}) =>
    syncWorkboardSubagentEnded({
      store,
      event: {
        targetSessionKey: card.sessionKey ?? workboardSessionKeyForCard(card),
        endedAt: card.updatedAt + 1,
        outcome: "ok",
        ...event,
      },
    });
  return {
    card,
    end,
    read: () => store.get(card.id),
    sweep: (
      sessions: Parameters<typeof runSessionSweep>[0]["sessions"],
      sweepOptions: Omit<Parameters<typeof runSessionSweep>[0], "sessions"> = {},
    ) => runSessionSweep({ sessions, ...sweepOptions }),
  };
}

async function runningCard(sessionKey: string, runId = "run-agent") {
  return linked({ sessionKey, runId, execution: execution(sessionKey, runId) });
}

async function sweepService(service: ReturnType<typeof createWorkboardLifecycleService>) {
  const runOperation = vi.spyOn(store, "runOperation");
  try {
    await service.start(serviceContext());
    service.onGatewayStart();
    // The admitted operation spans the full sweep, including SQLite worker writes.
    expect(runOperation).toHaveBeenCalled();
    await runOperation.mock.results[0]?.value;
  } finally {
    service.onGatewayStop();
    await service.stop?.(serviceContext());
    runOperation.mockRestore();
  }
}

async function runSessionSweep(params: {
  sessions: (Session & { title?: string })[];
  now?: number;
  onMatched?: Parameters<typeof createWorkboardLifecycleService>[0]["onMatched"];
}) {
  const readSessions = vi.fn(async (options: { sessionKey: string }) => {
    return await readWorkboardLifecycleSessions(
      {
        isAvailable: async () => true,
        request: async (method, query = {}) => {
          const rows = params.sessions;
          if (method === "agents.list") {
            return {
              agents: Array.from(new Set(rows.map((row) => row.key.split(":")[1])), (id) => ({
                id,
              })),
            };
          }
          if (method === "sessions.describe") {
            return { session: rows.find((row) => row.key === query.key) ?? null };
          }
          const search = String(query.search);
          return {
            sessions: rows
              .filter((row) => row.key.includes(search) || row.title?.includes(search))
              .slice(0, Number(query.limit)),
          };
        },
      },
      options,
    );
  });
  using clock = vi.spyOn(Date, "now");
  clock.mockReturnValue(params.now ?? Date.now());
  const service = createWorkboardLifecycleService({
    store,
    readSessions,
    ...(params.onMatched ? { onMatched: params.onMatched } : {}),
  });
  await sweepService(service);
}

async function nudgeFixture(
  request = vi.fn().mockResolvedValue({ ok: true, ran: true }),
  options: {
    sessionKey?: string;
    automationJobId?: string | null;
    logger?: ServiceContext["logger"];
  } = {},
) {
  await store.upsertBoard({
    id: "planning",
    ...(options.automationJobId === null
      ? {}
      : { automationJobId: options.automationJobId ?? "job-categorize-planning" }),
  });
  const sessionKey = options.sessionKey ?? "agent:main:subagent:workboard-planning-card";
  const card = await createLinkedCard(store, { boardId: "planning", sessionKey });
  const service = createWorkboardAutomationNudgeService({ store });
  const context = nudgeContext(request, options.logger);
  await service.start(context);
  const event = {
    targetSessionKey: sessionKey,
    endedAt: card.updatedAt + 1,
    outcome: "ok" as const,
  };
  return {
    card,
    service,
    context,
    request,
    sync: (onMatched = service.nudge) => syncWorkboardSubagentEnded({ store, event, onMatched }),
    stop: () => service.stop?.(context),
  };
}

describe("Workboard gateway lifecycle sync", () => {
  beforeEach(resetStore);
  it("uses the active service owner from a prepared plugin generation", async () => {
    const info = vi.fn();
    const { request, sync, stop } = await nudgeFixture(undefined, {
      logger: { info, warn: vi.fn(), error: vi.fn() },
    });
    const generationService = createWorkboardAutomationNudgeService({ store });
    await sync(generationService.nudge);
    await stop();
    expect(info).toHaveBeenCalledWith(
      "workboard automation nudge requested for board planning: job job-categorize-planning",
    );
    expect(request).toHaveBeenCalledExactlyOnceWith("job-categorize-planning", "if-enabled");
  });

  it.each([
    ["agent:main:dashboard:deferred-completion", 1],
    ["agent:main:cron:deferred-completion", 0],
  ] as const)("nudges deferred completion for %s exactly %s times", async (sessionKey, calls) => {
    const enqueueRun = vi.fn().mockResolvedValue({ ok: true, queued: true });
    const { card, service: automation } = await nudgeFixture(enqueueRun, {
      sessionKey,
      automationJobId: "job-planning",
    });
    try {
      await syncWorkboardAgentEnded({
        store,
        event: { success: true },
        context: { sessionKey },
        readSessions: async () =>
          lifecycleSnapshot(lifecycleSession(sessionKey, "running", undefined, true)),
        onMatched: automation.nudge,
      });
      expect((await store.get(card.id))?.status).toBe("running");
      expect(enqueueRun).not.toHaveBeenCalled();
      for (let sweep = 0; sweep < 2; sweep += 1) {
        await runSessionSweep({
          sessions: [lifecycleSession(sessionKey, "done", card.updatedAt + 1)],
          onMatched: automation.nudge,
        });
      }
      expect((await store.get(card.id))?.status).toBe("review");
      expect(enqueueRun).toHaveBeenCalledTimes(calls);
      if (calls) {
        expect(enqueueRun).toHaveBeenCalledWith("job-planning", "if-enabled");
      }
    } finally {
      automation.stop();
    }
  });

  it("fences a board lookup across service restart", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, queued: true, runId: "nudge" });
    const { card, service, context } = await nudgeFixture(request);
    const boards = await store.listBoards();
    const lookup = Promise.withResolvers<typeof boards>();
    vi.spyOn(store, "listBoards").mockReturnValueOnce(lookup.promise);
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
    const { request, sync, stop } = await nudgeFixture(vi.fn(), { automationJobId: null });
    await sync();
    await stop();
    expect(request).not.toHaveBeenCalled();
  });

  it("coalesces repeated board nudges within the debounce window", async () => {
    const run =
      Promise.withResolvers<Awaited<ReturnType<NonNullable<ServiceCron["enqueueRun"]>>>>();
    const entered = Promise.withResolvers<void>();
    const request = vi.fn(() => {
      entered.resolve();
      return run.promise;
    });
    const { sync, stop } = await nudgeFixture(request);

    const first = sync();
    await entered.promise;
    await sync();
    run.resolve({ ok: true, ran: true });
    await first;
    await sync();
    await stop();

    expect(request).toHaveBeenCalledOnce();
  });

  it.each(["failure", "disabled"] as const)(
    "handles %s automation without affecting lifecycle sync",
    async (outcome) => {
      const warn = vi.fn();
      const request =
        outcome === "failure"
          ? vi.fn().mockRejectedValue(new Error("gateway unavailable"))
          : vi.fn().mockResolvedValue({ ok: true, ran: false, reason: "disabled" });
      const { card, sync, stop } = await nudgeFixture(request, {
        logger: { info: vi.fn(), warn, error: vi.fn() },
      });
      await expect(sync()).resolves.toBe(1);
      await stop();
      expect((await store.get(card.id))?.status).toBe("review");
      expect(warn).toHaveBeenCalledWith(
        outcome === "failure"
          ? expect.stringContaining("workboard automation nudge failed")
          : "workboard automation nudge skipped for board planning: job job-categorize-planning disabled",
      );
    },
  );

  it("updates execution attempts once when duplicate failure hooks arrive", async () => {
    const sessionKey = "agent:main:subagent:workboard-default-failure";
    const { end, read } = await runningCard(sessionKey, "run-failure");
    const event = { runId: "run-failure", outcome: "error" as const };

    await end(event);
    await end(event);

    await expect(read()).resolves.toMatchObject({
      metadata: { failureCount: 1, attempts: [expect.objectContaining({ status: "blocked" })] },
    });
  });

  it("settles a running execution without reopening a manually completed card", async () => {
    const sessionKey = "agent:main:dashboard:done";
    const { card, read, sweep } = await linked({
      status: "done",
      sessionKey,
      execution: execution(sessionKey, "manually-completed"),
    });

    await sweep([lifecycleSession(sessionKey, "done", card.updatedAt + 1)]);

    expect(await read()).toMatchObject({ status: "done", execution: { status: "review" } });
  });

  it("keeps backlog cards in place after a terminal session event", async () => {
    const sessionKey = "agent:main:dashboard:terminal-backlog";
    const { end, read } = await linked({ status: "backlog", sessionKey });

    await end();

    expect((await read())?.status).toBe("backlog");
  });

  it("matches cards by run id", async () => {
    const { end, read } = await linked({ runId: "run-linked" });
    await end({ targetSessionKey: "agent:main:dashboard:other", runId: "run-linked" });

    expect((await read())?.status).toBe("review");
  });

  it("defers incognito failure until its session settles without exposing private content", async () => {
    const sessionKey = "agent:main:dashboard:incognito-agent-end";
    const { card, read } = await runningCard(sessionKey);
    let active = true;
    const request = vi.fn().mockImplementation(async (method: string) =>
      method === "sessions.list"
        ? { sessions: [] }
        : {
            session: lifecycleSession(
              sessionKey,
              active ? "running" : "failed",
              card.updatedAt + 1,
              active,
            ),
          },
    );
    const gateway = { isAvailable: async () => true, request };

    const handler = vi.fn(async (...args: unknown[]) =>
      syncWorkboardAgentEnded({
        store,
        event: args[0] as Parameters<typeof syncWorkboardAgentEnded>[0]["event"],
        context: args[1] as Parameters<typeof syncWorkboardAgentEnded>[0]["context"],
        readSessions: (options) => readWorkboardLifecycleSessions(gateway, options),
        now: card.updatedAt + 1,
      }),
    );
    const runner = createHookRunner(createMockPluginRegistry([{ hookName: "agent_end", handler }]));
    await runner.runAgentEnd(
      {
        messages: [{ role: "user", content: "PRIVATE_INPUT" }],
        error: "PRIVATE_ERROR",
        success: false,
      },
      { runId: "run-agent", sessionKey },
    );
    const vetoed = await read();
    expect(vetoed).toMatchObject({ status: "running", execution: { status: "running" } });
    expect(vetoed?.metadata?.failureCount).toBeUndefined();
    expect(
      vetoed?.events?.some((event) => event.kind === "moved" && event.toStatus === "blocked"),
    ).toBe(false);
    active = false;
    const onMatched = vi.fn();
    const service = createWorkboardLifecycleService({
      store,
      readSessions: (options) => readWorkboardLifecycleSessions(gateway, options),
      onMatched,
    });
    await sweepService(service);
    expect(onMatched).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(
      "sessions.describe",
      { key: sessionKey, includeDerivedTitles: false, includeLastMessage: false },
      { scopes: ["operator.read"] },
    );
    await expect(read()).resolves.toMatchObject({
      status: "blocked",
      execution: { status: "blocked" },
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(JSON.stringify(handler.mock.calls)).not.toContain("PRIVATE_");
  });

  it.each([true, false])(
    "uses an exact event session rather than another agent's suffix (exact=%s)",
    async (exact) => {
      const sessionKey = "subagent:workboard-ops-card";
      const { card, read } = await runningCard(sessionKey);
      const alphaKey = `agent:alpha:${sessionKey}`;
      const updatedAt = exact ? card.updatedAt + 1 : undefined;
      const sessions = [
        lifecycleSession(alphaKey, "failed", updatedAt),
        lifecycleSession(`agent:beta:${sessionKey}`, "running", updatedAt, true),
      ];
      const readSessions = vi.fn().mockResolvedValue(lifecycleSnapshot(...sessions));
      await syncWorkboardAgentEnded({
        store,
        event: { runId: "run-agent", success: false },
        context: { runId: "run-agent", ...(exact ? { sessionKey: alphaKey } : {}) },
        now: card.updatedAt + 2,
        readSessions,
      });
      await expect(read()).resolves.toMatchObject(
        exact
          ? { status: "blocked", execution: { status: "blocked" }, metadata: { failureCount: 1 } }
          : { status: "running", execution: { status: "running" } },
      );
    },
  );

  it("marks an inactive running session stale and clears it after recovery", async () => {
    const sessionKey = "agent:main:dashboard:stale";
    const { card, read, sweep } = await linked({ status: "todo", sessionKey });
    const staleUpdatedAt = card.updatedAt + 1;
    const now = staleUpdatedAt + 31 * 60 * 1000;

    await sweep([lifecycleSession(sessionKey, "running", staleUpdatedAt)], { now });
    await expect(read()).resolves.toMatchObject({
      status: "running",
      metadata: {
        lifecycleStatusSourceUpdatedAt: staleUpdatedAt,
        stale: { lastSessionUpdatedAt: staleUpdatedAt },
      },
    });

    await sweep([lifecycleSession(sessionKey, "running", now + 1, true)], {
      now: now + 1,
    });

    expect((await read())?.metadata?.stale).toBeUndefined();
  });

  it("skips session discovery when no unarchived card needs lifecycle reconciliation", async () => {
    await store.create({ title: "Not dispatched", status: "ready" });
    await createLinkedCard(store, {
      status: "done",
      sessionKey: "agent:main:settled",
      execution: execution("agent:main:settled", "settled", "done"),
    });
    const archived = await createLinkedCard(store, {
      sessionKey: "agent:retired:subagent:workboard-default-archived",
    });
    await store.archive(archived.id, true);
    const readSessions = vi.fn().mockResolvedValue(lifecycleSnapshot());
    const service = createWorkboardLifecycleService({ store, readSessions });
    await sweepService(service);

    expect(readSessions).not.toHaveBeenCalled();
  });

  it("reconciles a captured unknown session when agent ownership is unambiguous", async () => {
    const { card, read } = await linked({ sessionKey: "unknown" });
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === "agents.list") {
        return { selectionRequired: false };
      }
      return {
        sessions: [lifecycleSession("unknown", "done", card.updatedAt + 1)],
      };
    });
    const readSessions = vi.fn(
      async (options: { sessionKey: string }) =>
        await readWorkboardLifecycleSessions({ isAvailable: async () => true, request }, options),
    );
    const service = createWorkboardLifecycleService({ store, readSessions });

    await sweepService(service);
    expect((await read())?.status).toBe("review");

    expect(readSessions).toHaveBeenCalledWith(expect.objectContaining({ sessionKey: "unknown" }));
    expect(request).toHaveBeenNthCalledWith(1, "agents.list", {}, { scopes: ["operator.read"] });
    expect(request).toHaveBeenNthCalledWith(
      2,
      "sessions.list",
      expect.objectContaining({ includeGlobal: false, includeUnknown: true }),
      { scopes: ["operator.read"] },
    );
  });

  it("does not suffix-match a uniquely wrong agent for an explicit target", async () => {
    const { card, read, sweep } = await linked({ agentId: "worker", boardId: "ops" });
    const sessionKey = workboardSessionKeyForCard(card);
    const suffix = sessionKey.slice(sessionKey.indexOf("subagent:workboard-"));

    await sweep([lifecycleSession(`agent:other:${suffix}`, "done", card.updatedAt + 1)]);

    expect((await read())?.status).toBe("running");
  });

  it("does not backfill over a newer attempt after lifecycle matching", async () => {
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
    const sessionKey = "agent:worker:subagent:workboard-default-retried";
    const { end, read } = await runningCard(sessionKey, "current-run");

    const updated = await end({ runId: "older-run" });

    expect(updated).toBe(0);
    await expect(read()).resolves.toMatchObject({
      status: "running",
      runId: "current-run",
      execution: { runId: "current-run", status: "running" },
    });
  });

  it.each([false, true])(
    "recovers an unlinked dispatcher claim only with a unique owner (ambiguous=%s)",
    async (ambiguous) => {
      const card = await store.create({ title: "Ambiguous accepted run", status: "ready" });
      const acceptedSessionKey = workboardSessionKeyForCard(card);
      const claimed = await store.claim(card.id, { ownerId: "workboard-dispatcher" });

      const observedSession = (agent: string, status: Session["status"]) => ({
        key: `agent:${agent}:${acceptedSessionKey}`,
        status,
        updatedAt: claimed.card.updatedAt + 1,
      });
      await runSessionSweep({
        sessions: [
          observedSession("alpha", "done"),
          ...(ambiguous ? [observedSession("beta", "failed")] : []),
        ],
      });

      expect((await store.get(card.id))?.status).toBe(ambiguous ? "running" : "review");
    },
  );

  it("suffix-matches an agentless linked card to an agent-prefixed Workboard session", async () => {
    const { card, read, sweep } = await linked({ boardId: "ops" });
    const sessionKey = `agent:worker:${workboardSessionKeyForCard(card)}`;

    await sweep([lifecycleSession(sessionKey, "done", card.updatedAt + 1)]);

    expect((await read())?.status).toBe("review");
  });

  it("recovers an exact legacy link from a full page with an unrelated title match", async () => {
    const sessionKey = "legacy-card";
    const { card, read, sweep } = await linked({ sessionKey });

    await sweep([
      {
        key: "agent:main:unrelated",
        title: `Discuss ${sessionKey}`,
        status: "running",
        updatedAt: card.updatedAt + 2,
      },
      lifecycleSession(sessionKey, "done", card.updatedAt + 1),
    ]);

    expect((await read())?.status).toBe("review");
  });
});

function createSessionReader(sessionKey: string, updatedAt: number) {
  return vi
    .fn()
    .mockResolvedValueOnce(
      lifecycleSnapshot(lifecycleSession(sessionKey, "running", updatedAt + 1, true)),
    )
    .mockResolvedValueOnce(lifecycleSnapshot(lifecycleSession(sessionKey, "done", updatedAt + 2)));
}

describe("Workboard lifecycle service", () => {
  beforeEach(resetStore);
  it("uses the active service reader from prepared hooks across replacement", async () => {
    const original = createWorkboardLifecycleService({
      store,
      readSessions: async () => lifecycleSnapshot(),
    });
    const readReplacement = vi.fn(async () => lifecycleSnapshot());
    const replacement = createWorkboardLifecycleService({ store, readSessions: readReplacement });
    const preparedReader = vi.fn(async () => lifecycleSnapshot());
    const prepared = createWorkboardLifecycleService({ store, readSessions: preparedReader });
    const readPrepared = () => prepared.readSessions({ sessionKey: "agent:main:card" });
    const context = serviceContext();
    try {
      await original.start(context);
      await expect(readPrepared()).resolves.toEqual(lifecycleSnapshot());
      original.stop();
      await replacement.start(context);
      original.stop();
      await expect(readPrepared()).resolves.toEqual(lifecycleSnapshot());
      expect(readReplacement).toHaveBeenCalledOnce();
      expect(preparedReader).not.toHaveBeenCalled();
      replacement.stop();
      await expect(readPrepared()).resolves.toEqual({ sessions: [], complete: false });
      expect(readReplacement).toHaveBeenCalledOnce();
    } finally {
      original.stop();
      replacement.onGatewayStop();
    }
  });

  it.each(["interval", "plugin reload"] as const)(
    "waits for Gateway readiness and reconciles again after %s until drain",
    async (trigger) => {
      const sessionKey = "agent:main:dashboard:startup-ready";
      const card = await createLinkedCard(store, { status: "todo", sessionKey });
      const readSessions = createSessionReader(sessionKey, card.updatedAt);
      const warn = vi.fn();
      const original = createWorkboardLifecycleService({ store, readSessions });
      const replacement = createWorkboardLifecycleService({ store, readSessions });
      const context = serviceContext({ info: vi.fn(), warn, error: vi.fn() });
      const lifetime = new AbortController();
      const runOperation = vi.spyOn(store, "runOperation");
      vi.useFakeTimers();
      try {
        await original.start(context);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(readSessions).not.toHaveBeenCalled();

        original.onGatewayStart(lifetime.signal);
        expect(runOperation).toHaveBeenCalled();
        await runOperation.mock.results[0]?.value;
        expect((await store.get(card.id))?.status).toBe("running");
        expect(readSessions).toHaveBeenCalledOnce();

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
      await service.start(serviceContext({ info: vi.fn(), warn, error: vi.fn() }));
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

describe("Workboard lifecycle session discovery", () => {
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
        { sessionKey: "unknown" },
      ),
    ).resolves.toEqual({ sessions: [], complete: true });
  });

  it("returns an incomplete empty snapshot without requesting while Gateway is unavailable", async () => {
    const request = vi.fn();

    await expect(
      readWorkboardLifecycleSessions(
        { isAvailable: async () => false, request },
        { sessionKey: "agent:main:missing" },
      ),
    ).resolves.toEqual({ sessions: [], complete: false });
    expect(request).not.toHaveBeenCalled();
  });

  it("treats a full legacy lookup page as possibly ambiguous", async () => {
    // Keep a full page conservative even when a mock or older peer omits pagination
    // metadata, or absent sessions could be marked missing.
    const request = vi.fn().mockResolvedValue({
      sessions: Array.from({ length: 2 }, (_, index) => ({
        key: `agent:main:dashboard:${index}`,
        status: "done",
      })),
    });

    const snapshot = await readWorkboardLifecycleSessions(
      { isAvailable: async () => true, request },
      { sessionKey: "legacy-card" },
    );
    expect(snapshot.complete).toBe(false);
    expect(snapshot.sessions).toHaveLength(2);
  });
});
