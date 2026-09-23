// Announce loop-guard tests prove deferred delivery retries through its time
// window, then gives up instead of looping forever after repeated failures.
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const sessionStore = vi.hoisted(() => ({
  "agent:main:subagent:child-1": { sessionId: "sess-child-1", updatedAt: 1 },
  "agent:main:subagent:expired-child": { sessionId: "sess-expired", updatedAt: 1 },
  "agent:main:subagent:retry-budget": { sessionId: "sess-retry", updatedAt: 1 },
}));

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({
    session: { store: "/tmp/test-store", mainKey: "main" },
    agents: {},
  })),
  updateSessionStore: vi.fn(),
  callGateway: vi.fn().mockResolvedValue({ status: "ok" }),
  onAgentEventStop: vi.fn(),
  onAgentEvent: vi.fn(),
  runSubagentAnnounceFlow: vi.fn().mockResolvedValue("retryable"),
  captureSubagentCompletionReply: vi.fn(),
  loadSubagentRegistryFromSqlite: vi.fn(() => new Map()),
  saveSubagentRegistryChangesToSqlite: vi.fn(),
  saveSubagentRegistryToSqlite: vi.fn(),
  resolveAgentTimeoutMs: vi.fn(() => 60_000),
}));

vi.mock("../../../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

vi.mock("../../../config/sessions.js", () => ({
  loadSessionStore: () => sessionStore,
  resolveAgentIdFromSessionKey: (key: string) => {
    const match = key.match(/^agent:([^:]+)/);
    return match?.[1] ?? "main";
  },
  resolveMainSessionKey: () => "agent:main:main",
  resolveSessionStorePathCore: () => "/tmp/test-store",
  updateSessionStore: mocks.updateSessionStore,
}));

vi.mock("../../../config/sessions/session-accessor.js", () => {
  const listSessionEntriesCore = () =>
    Object.entries(sessionStore).map(([sessionKey, entry]) => ({ sessionKey, entry }));
  const loadSessionEntry = (scope: { sessionKey: keyof typeof sessionStore }) =>
    sessionStore[scope.sessionKey];
  return {
    findTranscriptEvent: vi.fn(async () => undefined),
    listSessionEntriesCore,
    listSessionEntriesReadOnly: listSessionEntriesCore,
    loadSessionEntry,
    loadSessionEntryReadOnly: loadSessionEntry,
    patchSessionEntryCore: async () => null,
  };
});

vi.mock("../../../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

vi.mock("../../../infra/agent-events.js", () => ({
  getAgentEventLifecycleGeneration: () => "test-generation",
  isAgentEventLifecycleGenerationCurrent: (generation: string) => generation === "test-generation",
  onAgentEvent: mocks.onAgentEvent,
  registerAgentEventLifecycleRotationHandler: vi.fn(),
}));

vi.mock("./subagent-registry.store.sqlite.js", () => ({
  loadSubagentRegistryFromSqlite: mocks.loadSubagentRegistryFromSqlite,
  saveSubagentRegistryChangesToSqlite: mocks.saveSubagentRegistryChangesToSqlite,
  saveSubagentRegistryToSqlite: mocks.saveSubagentRegistryToSqlite,
}));

vi.mock("../../timeout.js", () => ({
  resolveAgentTimeoutMs: mocks.resolveAgentTimeoutMs,
}));

vi.mock("../announce/subagent-announce.js", async (importOriginal) => {
  const { hasUsableSessionEntry } =
    await importOriginal<typeof import("../announce/subagent-announce.js")>();
  return {
    hasUsableSessionEntry,
    captureSubagentCompletionReply: mocks.captureSubagentCompletionReply,
    runSubagentAnnounceFlow: mocks.runSubagentAnnounceFlow,
  };
});
vi.mock("../../../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd: vi.fn(async () => {}),
}));

describe("announce loop guard (#18264)", () => {
  let registry: typeof import("./subagent-registry.test-helpers.js");
  let resetTasks: typeof import("../../../tasks/task-registry.test-support.js").resetTaskRegistryForTests;

  function hydrateAndActivateRegistry() {
    registry.initSubagentRegistry();
    const recoveryRuntime = {
      dispatchAgent: vi.fn(),
      waitForAgent: vi.fn(async () => ({ status: "pending" })),
      sendRecoveryNotice: vi.fn(),
    };
    const gatewayContext = {
      recoveryRuntime,
      resolveGatewayContext: () => gatewayContext as never,
    };
    registry.activateSubagentRegistry(gatewayContext.resolveGatewayContext);
  }

  async function waitForRun(
    runId: string,
    predicate: (run: SubagentRunRecord) => boolean,
  ): Promise<SubagentRunRecord> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const run = registry
        .listSubagentRunsForRequester("agent:main:main")
        .find((candidate) => candidate.runId === runId);
      if (run && predicate(run)) {
        return run;
      }
      await vi.advanceTimersByTimeAsync(1);
      await vi.dynamicImportSettled();
    }
    throw new Error(`subagent run ${runId} did not reach expected state`);
  }

  beforeAll(async () => {
    vi.resetModules();
    registry = await import("./subagent-registry.test-helpers.js");
    ({ resetTaskRegistryForTests: resetTasks } =
      await import("../../../tasks/task-registry.test-support.js"));
  });

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.callGateway.mockClear();
    mocks.captureSubagentCompletionReply.mockClear();
    mocks.getRuntimeConfig.mockClear();
    mocks.loadSubagentRegistryFromSqlite.mockReset();
    mocks.loadSubagentRegistryFromSqlite.mockReturnValue(new Map());
    mocks.onAgentEventStop.mockClear();
    mocks.onAgentEvent.mockReset();
    mocks.onAgentEvent.mockReturnValue(mocks.onAgentEventStop);
    mocks.resolveAgentTimeoutMs.mockClear();
    mocks.runSubagentAnnounceFlow.mockReset();
    mocks.runSubagentAnnounceFlow.mockResolvedValue("retryable");
    mocks.saveSubagentRegistryChangesToSqlite.mockClear();
    mocks.saveSubagentRegistryToSqlite.mockClear();
    mocks.updateSessionStore.mockClear();
    registry.resetSubagentRegistryForTests({ persist: false });
  });

  afterEach(() => {
    try {
      registry.resetSubagentRegistryForTests({ persist: false });
    } finally {
      try {
        // Announce status reads restore the real task registry and its SQLite handle.
        resetTasks({ persist: false });
      } finally {
        vi.useRealTimers();
        vi.clearAllMocks();
      }
    }
  });

  test("expired entries with high retry count are skipped by resumeSubagentRun", async () => {
    mocks.runSubagentAnnounceFlow.mockClear();
    registry.resetSubagentRegistryForTests();

    const now = Date.now();
    const entry = {
      // Ended 10 minutes ago (well past ANNOUNCE_EXPIRY_MS of 5 min).
      runId: "test-expired-loop",
      childSessionKey: "agent:main:subagent:expired-child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "agent:main:main",
      task: "expired test task",
      cleanup: "keep" as const,
      createdAt: now - 15 * 60_000,
      execution: {
        status: "terminal" as const,
        startedAt: now - 14 * 60_000,
        endedAt: now - 10 * 60_000,
      },
      cleanupCompletedAt: undefined,
      delivery: { status: "pending" as const, attemptCount: 3, lastAttemptAt: now - 9 * 60_000 },
    };
    mocks.loadSubagentRegistryFromSqlite.mockReturnValue(new Map([[entry.runId, entry]]));

    // Initialization finalizes expired pending rows without another recipient-visible attempt.
    const beforeInit = Date.now();
    hydrateAndActivateRegistry();
    await vi.dynamicImportSettled();

    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(entry.cleanupCompletedAt).toBeGreaterThanOrEqual(beforeInit);
    expect(mocks.saveSubagentRegistryChangesToSqlite).toHaveBeenCalledWith(expect.any(Map), [
      entry.runId,
    ]);
  });

  test.each([
    {
      name: "entries over the former retry budget keep announcing inside the delivery window",
      outcome: "retryable",
      attemptCount: 4,
    },
    {
      name: "pending requester turns preserve the failure budget and schedule another observation",
      outcome: "requester_turn_pending",
      attemptCount: 3,
    },
  ])("$name", async ({ outcome, attemptCount }) => {
    mocks.runSubagentAnnounceFlow.mockClear();
    mocks.runSubagentAnnounceFlow.mockResolvedValue(outcome);
    registry.resetSubagentRegistryForTests();

    const now = Date.now();
    const entry: SubagentRunRecord = {
      runId: "test-retry-budget",
      childSessionKey: "agent:main:subagent:retry-budget",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "agent:main:main",
      task: "retry window test",
      cleanup: "keep",
      createdAt: now - 2 * 60_000,
      execution: {
        status: "terminal",
        startedAt: now - 90_000,
        endedAt: now - 60_000,
      },
      expectsCompletionMessage: true,
      delivery: { status: "pending", attemptCount: 3, lastAttemptAt: now - 30_000 },
    };
    mocks.loadSubagentRegistryFromSqlite.mockReturnValue(new Map([[entry.runId, entry]]));

    hydrateAndActivateRegistry();
    const resumed = await waitForRun(
      entry.runId,
      (run) =>
        run.delivery?.attemptCount === attemptCount &&
        typeof run.delivery.nextAttemptAt === "number",
    );

    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    expect(resumed.cleanupCompletedAt).toBeUndefined();
    expect(resumed.delivery).toMatchObject({
      status: "pending",
      attemptCount,
      windowStartedAt: entry.execution.endedAt,
      deadlineAt: entry.execution.endedAt! + 30 * 60_000,
    });
    expect(resumed.delivery!.nextAttemptAt).toBeGreaterThan(now);
    if (outcome === "requester_turn_pending") {
      mocks.runSubagentAnnounceFlow.mockResolvedValue("retryable");
      await vi.advanceTimersByTimeAsync(resumed.delivery!.nextAttemptAt! - Date.now());
      const retried = await waitForRun(entry.runId, (run) => run.delivery?.attemptCount === 4);
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(2);
      expect(retried.delivery?.deadlineAt).toBe(entry.execution.endedAt! + 30 * 60_000);
    }
  });

  test("expired completion-message entries are still resumed for announce", async () => {
    mocks.runSubagentAnnounceFlow.mockReset();
    mocks.runSubagentAnnounceFlow.mockResolvedValueOnce("delivered");
    registry.resetSubagentRegistryForTests();

    const now = Date.now();
    const runId = "test-expired-completion-message";
    mocks.loadSubagentRegistryFromSqlite.mockReturnValue(
      new Map([
        [
          runId,
          {
            runId,
            childSessionKey: "agent:main:subagent:child-1",
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "agent:main:main",
            task: "completion announce after long descendants",
            cleanup: "keep" as const,
            createdAt: now - 20 * 60_000,
            execution: {
              status: "terminal" as const,
              startedAt: now - 19 * 60_000,
              endedAt: now - 10 * 60_000,
            },
            cleanupHandled: false,
            expectsCompletionMessage: true,
          },
        ],
      ]),
    );

    hydrateAndActivateRegistry();
    await vi.dynamicImportSettled();

    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
  });

  test("announce rejection resets cleanupHandled so retries can resume", async () => {
    mocks.runSubagentAnnounceFlow.mockReset();
    mocks.runSubagentAnnounceFlow.mockRejectedValueOnce(new Error("announce failed"));
    registry.resetSubagentRegistryForTests();

    const now = Date.now();
    const runId = "test-announce-rejection";
    mocks.loadSubagentRegistryFromSqlite.mockReturnValue(
      new Map([
        [
          runId,
          {
            runId,
            childSessionKey: "agent:main:subagent:child-1",
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "agent:main:main",
            task: "rejection test",
            cleanup: "keep" as const,
            createdAt: now - 30_000,
            execution: {
              status: "terminal" as const,
              startedAt: now - 20_000,
              endedAt: now - 10_000,
            },
            cleanupHandled: false,
          },
        ],
      ]),
    );

    hydrateAndActivateRegistry();
    await vi.dynamicImportSettled();

    const stored = await waitForRun(
      runId,
      (run) => run.cleanupHandled === false && run.delivery?.attemptCount === 1,
    );
    expect(stored.cleanupCompletedAt).toBeUndefined();
    expect(stored.delivery?.lastAttemptAt).toBeTypeOf("number");
  });
});
