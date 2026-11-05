import {
  createHookRunner,
  createMockPluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkboardAutomationNudgeService } from "./automation-nudge.js";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
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
import { createLinkedCard } from "./lifecycle-sync.test-support.js";
import { workboardSessionKeyForCard } from "./session-link.js";
import { WorkboardStore } from "./store.js";
import {
  createWorkboardSqliteTestHarness,
  createWorkboardSqliteTestStore,
  sqliteTestAuxStores,
} from "./test/sqlite-store.js";

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
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).toReversed()) {
    await stop();
  }
});
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

type Gateway = Parameters<typeof readWorkboardLifecycleSessions>[0];
const sessionReader = (request: Gateway["request"]) => (options: { sessionKey: string }) =>
  readWorkboardLifecycleSessions({ isAvailable: async () => true, request }, options);

function sessionFixture(rows: () => (Session & { title?: string })[]) {
  const request = vi.fn<Gateway["request"]>(async (method, query = {}) => {
    const sessions = rows();
    if (method === "agents.list") {
      return {
        agents: [...new Set(sessions.map((row) => row.key.split(":")[1]))].map((id) => ({ id })),
      };
    }
    if (method === "sessions.describe") {
      return { session: sessions.find((row) => row.key === query.key) ?? null };
    }
    return {
      sessions: sessions
        .filter(
          (row) =>
            row.key.includes(String(query.search)) || row.title?.includes(String(query.search)),
        )
        .slice(0, Number(query.limit)),
    };
  });
  return { request, readSessions: sessionReader(request) };
}

async function sweepService(service: ReturnType<typeof createWorkboardLifecycleService>) {
  using runOperation = vi.spyOn(store, "runOperation");
  try {
    await service.start(serviceContext());
    service.onGatewayStart();
    expect(runOperation).toHaveBeenCalled();
    await runOperation.mock.results[0]?.value;
  } finally {
    service.onGatewayStop();
  }
}

async function runSessionSweep(params: {
  sessions: (Session & { title?: string })[];
  now?: number;
  onMatched?: Parameters<typeof createWorkboardLifecycleService>[0]["onMatched"];
}) {
  const { readSessions } = sessionFixture(() => params.sessions);
  using clock = vi.spyOn(Date, "now");
  clock.mockReturnValue(params.now ?? Date.now());
  const service = createWorkboardLifecycleService({
    store,
    readSessions,
    onMatched: params.onMatched,
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
  cleanup.push(() => service.stop());
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
  };
}

describe("Workboard gateway lifecycle sync", () => {
  beforeEach(resetStore);
  it("uses the active service owner from a prepared plugin generation", async () => {
    const { request, sync } = await nudgeFixture();
    const generationService = createWorkboardAutomationNudgeService({ store });
    await sync(generationService.nudge);
    expect(request).toHaveBeenCalledExactlyOnceWith("job-categorize-planning", "if-enabled");
  });

  it.each([
    ["agent:main:dashboard:deferred-completion", 1],
    ["agent:main:cron:deferred-completion", 0],
  ] as const)("nudges settled %s exactly %s times", async (sessionKey, calls) => {
    const enqueueRun = vi.fn().mockResolvedValue({ ok: true, queued: true });
    const { card, service: automation } = await nudgeFixture(enqueueRun, {
      sessionKey,
      automationJobId: "job-planning",
    });
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
  });

  it("fences a board lookup across service restart", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, queued: true, runId: "nudge" });
    const { card, service, context } = await nudgeFixture(request);
    const boards = await store.listBoards();
    const lookup = Promise.withResolvers<typeof boards>();
    cleanup.push(() => lookup.resolve(boards));
    vi.spyOn(store, "listBoards").mockReturnValueOnce(lookup.promise);
    const pending = service.nudge({ cards: [card] });
    service.stop();
    await service.start(context);
    lookup.resolve(boards);
    await pending;
    expect(request).not.toHaveBeenCalled();

    await service.nudge({ cards: [card] });
    expect(request).toHaveBeenCalledExactlyOnceWith("job-categorize-planning", "if-enabled");
  });

  it("does not nudge a matching card whose board has no automation", async () => {
    const { request, sync } = await nudgeFixture(vi.fn(), { automationJobId: null });
    await sync();
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
    const { sync } = await nudgeFixture(request);

    const first = sync();
    await entered.promise;
    await sync();
    run.resolve({ ok: true, ran: true });
    await first;
    await sync();

    expect(request).toHaveBeenCalledOnce();
  });

  it.each([-60_000, 60_000])(
    "keeps the board debounce at 60 seconds after a %s ms wall-clock step",
    async (wallClockStepMs) => {
      const request = vi.fn(async () => {
        vi.setSystemTime(Date.now() + wallClockStepMs);
        return { ok: true, ran: true };
      });
      const { card, service } = await nudgeFixture(request);
      const boards = await store.listBoards();
      using lookup = vi.spyOn(store, "listBoards");
      lookup.mockResolvedValue(boards);
      vi.useFakeTimers();
      try {
        await service.nudge({ cards: [card] });
        await vi.advanceTimersByTimeAsync(59_999);
        await service.nudge({ cards: [card] });
        expect(request).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(1);
        await service.nudge({ cards: [card] });
        expect(request).toHaveBeenCalledTimes(2);
      } finally {
        service.stop();
        vi.useRealTimers();
      }
    },
  );

  it.each(["failure", "disabled"] as const)(
    "handles %s automation without affecting lifecycle sync",
    async (outcome) => {
      const warn = vi.fn();
      const request =
        outcome === "failure"
          ? vi.fn().mockRejectedValue(new Error("gateway unavailable"))
          : vi.fn().mockResolvedValue({ ok: true, ran: false, reason: "disabled" });
      const { card, sync } = await nudgeFixture(request, {
        logger: { info: vi.fn(), warn, error: vi.fn() },
      });
      await expect(sync()).resolves.toBe(1);
      expect((await store.get(card.id))?.status).toBe("review");
      expect(warn).toHaveBeenCalledOnce();
    },
  );

  it("updates execution attempts once when duplicate failure hooks arrive", async () => {
    const { end, read } = await runningCard("agent:main:failure", "run-failure");
    const event = { runId: "run-failure", outcome: "error" as const };

    await end(event);
    await end(event);

    await expect(read()).resolves.toMatchObject({
      metadata: { failureCount: 1, attempts: [expect.objectContaining({ status: "blocked" })] },
    });
  });

  it("settles a running execution without reopening a manually completed card", async () => {
    const sessionKey = "agent:main:done";
    const { card, read, sweep } = await linked({
      status: "done",
      sessionKey,
      execution: execution(sessionKey, "manually-completed"),
    });
    await sweep([lifecycleSession(sessionKey, "done", card.updatedAt + 1)]);
    expect(await read()).toMatchObject({ status: "done", execution: { status: "review" } });
  });

  it("keeps backlog cards in place after a terminal session event", async () => {
    const { end, read } = await linked({
      status: "backlog",
      sessionKey: "agent:main:backlog",
    });
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
    const { request, readSessions } = sessionFixture(() => [
      lifecycleSession(sessionKey, active ? "running" : "failed", card.updatedAt + 1, active),
    ]);
    const onMatched = vi.fn();

    const handler = vi.fn(async (...args: unknown[]) =>
      syncWorkboardAgentEnded({
        store,
        event: args[0] as Parameters<typeof syncWorkboardAgentEnded>[0]["event"],
        context: args[1] as Parameters<typeof syncWorkboardAgentEnded>[0]["context"],
        readSessions,
        onMatched,
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
    expect(onMatched).not.toHaveBeenCalled();
    active = false;
    await sweepService(createWorkboardLifecycleService({ store, readSessions, onMatched }));
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
    const sessionKey = "agent:main:stale";
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
      sessionKey: "agent:retired:archived",
    });
    await store.archive(archived.id, true);
    const readSessions = vi.fn().mockResolvedValue(lifecycleSnapshot());
    const service = createWorkboardLifecycleService({ store, readSessions });
    await sweepService(service);

    expect(readSessions).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "reconciles unknown only with unambiguous ownership (selection=%s)",
    async (selectionRequired) => {
      const { card, read } = await linked({ sessionKey: "unknown" });
      const request = vi.fn().mockImplementation(async (method: string) => {
        if (method === "agents.list") {
          return { selectionRequired };
        }
        return {
          sessions: selectionRequired
            ? []
            : [lifecycleSession("unknown", "done", card.updatedAt + 1)],
        };
      });
      const readSessions = vi.fn(sessionReader(request));
      const service = createWorkboardLifecycleService({ store, readSessions });

      await sweepService(service);
      await expect(readSessions.mock.results[0]?.value).resolves.toMatchObject({ complete: true });
      expect((await read())?.status).toBe(selectionRequired ? "running" : "review");
      expect(request).toHaveBeenCalledWith("agents.list", {}, { scopes: ["operator.read"] });
      expect(request).toHaveBeenCalledWith(
        "sessions.list",
        expect.objectContaining({ includeGlobal: false, includeUnknown: !selectionRequired }),
        { scopes: ["operator.read"] },
      );
    },
  );

  it.each([undefined, "worker"])(
    "suffix matches only an agentless target (agent=%s)",
    async (agentId) => {
      const { card, read, sweep } = await linked({ agentId, boardId: "ops" });
      const key = workboardSessionKeyForCard(card);
      const suffix = key.slice(key.indexOf("subagent:workboard-"));
      await sweep([lifecycleSession(`agent:other:${suffix}`, "done", card.updatedAt + 1)]);
      expect((await read())?.status).toBe(agentId ? "running" : "review");
    },
  );

  it("does not backfill over a newer attempt after lifecycle matching", async () => {
    const provisionalSessionKey = "subagent:workboard-race";
    const created = await createLinkedCard(store, { sessionKey: provisionalSessionKey });
    const provisionalRunId = `workboard:${created.id}:${created.updatedAt}`;
    const card = await store.update(created.id, {
      runId: provisionalRunId,
      execution: execution(provisionalSessionKey, provisionalRunId),
    });
    const newerSessionKey = "agent:newer:subagent:workboard-race";
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
    const { end, read } = await runningCard("agent:worker:retry", "current-run");

    await expect(end({ runId: "older-run" })).resolves.toBe(0);
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

function managedService(
  readSessions: Parameters<typeof createWorkboardLifecycleService>[0]["readSessions"],
) {
  const service = createWorkboardLifecycleService({ store, readSessions });
  cleanup.push(() => service.onGatewayStop());
  return service;
}

describe("Workboard lifecycle service", () => {
  beforeEach(() => {
    resetStore();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());
  it("uses the active service reader from prepared hooks across replacement", async () => {
    const original = managedService(async () => lifecycleSnapshot());
    const readReplacement = vi.fn(async () => lifecycleSnapshot());
    const replacement = managedService(readReplacement);
    const preparedReader = vi.fn(async () => lifecycleSnapshot());
    const prepared = managedService(preparedReader);
    const readPrepared = () => prepared.readSessions({ sessionKey: "agent:main:card" });
    const context = serviceContext();
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
  });

  it.each(["interval", "plugin reload"] as const)(
    "waits for Gateway readiness and reconciles again after %s until drain",
    async (trigger) => {
      const sessionKey = "agent:main:ready";
      const card = await createLinkedCard(store, { status: "todo", sessionKey });
      const readSessions = vi
        .fn()
        .mockResolvedValueOnce(
          lifecycleSnapshot(lifecycleSession(sessionKey, "running", card.updatedAt + 1, true)),
        )
        .mockResolvedValueOnce(
          lifecycleSnapshot(lifecycleSession(sessionKey, "done", card.updatedAt + 2)),
        );
      const warn = vi.fn();
      const original = managedService(readSessions);
      const replacement = managedService(readSessions);
      const context = serviceContext({ info: vi.fn(), warn, error: vi.fn() });
      const lifetime = new AbortController();
      using runOperation = vi.spyOn(store, "runOperation");
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
      }
    },
  );

  it("fences an in-flight session read as soon as the Gateway drains", async () => {
    await createLinkedCard(store, { sessionKey: "agent:main:dashboard:draining" });
    using runOperation = vi.spyOn(store, "runOperation");
    const lifetime = new AbortController();
    const readEntered = Promise.withResolvers<void>();
    const readResult = Promise.withResolvers<{ sessions: []; complete: boolean }>();
    const readSessions = vi.fn(async () => {
      readEntered.resolve();
      return await readResult.promise;
    });
    const warn = vi.fn();
    const service = managedService(readSessions);
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
    }
  });
});

describe("Workboard lifecycle session discovery", () => {
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

describe("Workboard prepared launch restart recovery", () => {
  let prepared: { sessionKey: string; provisionalRunId: string };
  let canonicalSessionKey: string;
  let read: () => ReturnType<WorkboardStore["get"]>;
  let rejectDispatch: () => Promise<void>;
  beforeEach(async () => {
    const { store: dispatchStore, stores } = createWorkboardSqliteTestHarness();
    const card = await dispatchStore.create({
      title: "Prepared across restart",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });
    const reachedRun = Promise.withResolvers<typeof prepared>();
    const runResult = Promise.withResolvers<{ sessionKey?: string; runId: string }>();
    const dispatch = dispatchAndStartWorkboardCards({
      store: dispatchStore,
      subagent: {
        run: async (input) => {
          if (!input.idempotencyKey) {
            throw new Error("expected prepared launch idempotency key");
          }
          reachedRun.resolve({
            sessionKey: input.sessionKey,
            provisionalRunId: input.idempotencyKey,
          });
          return await runResult.promise;
        },
      },
      options: { maxStarts: 1 },
    });
    prepared = await reachedRun.promise;
    store = new WorkboardStore(stores.cards, sqliteTestAuxStores(stores));
    read = () => store.get(card.id);
    canonicalSessionKey = `agent:worker:${prepared.sessionKey}`;
    rejectDispatch = async () => {
      runResult.reject(new Error("simulated dispatcher process loss"));
      await dispatch;
    };
  });
  afterEach(async () => {
    try {
      await rejectDispatch();
    } finally {
      await store.close();
    }
  });
  const sweep = (sessions: LifecycleSnapshot["sessions"], complete = true) =>
    sweepService(
      createWorkboardLifecycleService({
        store,
        readSessions: async () => ({ sessions, complete }),
      }),
    );

  it.each(["running", "done"] as const)(
    "fails a prepared %s session without acceptance evidence",
    async (status) => {
      await sweep([lifecycleSession(canonicalSessionKey, status)]);
      await expect(read()).resolves.toMatchObject({
        status: "blocked",
        metadata: { automation: { launch: { phase: "failed" } } },
      });
      if (status === "running") {
        expect((await read())?.metadata?.claim).toBeUndefined();
      }
    },
  );

  it("accepts a prepared launch found under its canonical post-restart session", async () => {
    await sweep([lifecycleSession(canonicalSessionKey, "running", undefined, true)]);
    const accepted = await read();
    const link = { sessionKey: canonicalSessionKey, runId: prepared.provisionalRunId };
    expect(accepted).toMatchObject({
      status: "running",
      ...link,
      metadata: {
        claim: { ownerId: "workboard-dispatcher" },
        attempts: [{ status: "running", ...link }],
        automation: { launch: { phase: "accepted", acceptedSessionKey: canonicalSessionKey } },
      },
    });
    expect(accepted?.metadata?.automation?.launch).not.toHaveProperty("acceptedRunId");
    await syncWorkboardSubagentEnded({
      store,
      event: { targetSessionKey: canonicalSessionKey, runId: "accepted-run", outcome: "ok" },
    });
    const terminal = await read();
    expect(terminal).toMatchObject({
      status: "review",
      sessionKey: canonicalSessionKey,
      runId: "accepted-run",
      metadata: {
        automation: { launch: { phase: "accepted", acceptedRunId: "accepted-run" } },
        attempts: [{ id: expect.any(String), status: "succeeded", runId: "accepted-run" }],
      },
    });
    expect(terminal?.metadata?.attempts).toHaveLength(1);
    expect(terminal?.metadata?.attempts?.[0]?.id).toBe(accepted?.metadata?.attempts?.[0]?.id);
    await rejectDispatch();
    expect((await read())?.status).toBe("review");
  });

  it("accepts a prepared launch from an explicit terminal session snapshot", async () => {
    const launch = (await read())?.metadata?.automation?.launch;
    if (launch?.phase !== "prepared") {
      throw new Error("expected prepared launch");
    }
    await sweep([lifecycleSession(canonicalSessionKey, "done", launch.preparedAt + 1)]);
    await expect(read()).resolves.toMatchObject({
      status: "review",
      sessionKey: canonicalSessionKey,
      metadata: {
        automation: { launch: { phase: "accepted", acceptedSessionKey: canonicalSessionKey } },
        attempts: [{ status: "succeeded" }],
      },
    });
  });

  it.each(["incomplete", "ambiguous"] as const)(
    "keeps a prepared launch running when the post-restart snapshot is %s",
    async (snapshot) => {
      await sweep(
        snapshot === "ambiguous"
          ? ["alpha", "beta"].map((agent) => ({
              key: `agent:${agent}:${prepared.sessionKey}`,
              status: "done",
            }))
          : [],
        snapshot === "ambiguous",
      );
      await expect(read()).resolves.toMatchObject({
        status: "running",
        sessionKey: prepared.sessionKey,
        runId: prepared.provisionalRunId,
        metadata: {
          claim: { ownerId: "workboard-dispatcher" },
          automation: { launch: { phase: "prepared" } },
        },
      });
    },
  );
});
