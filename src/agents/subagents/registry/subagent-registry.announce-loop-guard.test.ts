// Announce loop-guard tests prove deferred delivery retries through its time
// window, then gives up instead of looping forever after repeated failures.
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { configureInMemoryTaskStoresForTests } from "../../../tasks/task-registry.test-support.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "../../../tasks/task-runtime.test-helpers.js";
import { createLifecycleWaits } from "./subagent-registry.lifecycle-waits.test-support.js";
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
  let taskRuntime: typeof import("../../../tasks/detached-task-runtime.js");

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

  const { flushAsync } = createLifecycleWaits("agent:main:main");

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
      await flushAsync();
    }
    throw new Error(`subagent run ${runId} did not reach expected state`);
  }

  beforeAll(async () => {
    registry = await import("./subagent-registry.test-helpers.js");
    taskRuntime = await import("../../../tasks/detached-task-runtime.js");
  });

  beforeEach(() => {
    vi.useFakeTimers();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    configureInMemoryTaskStoresForTests();
    vi.clearAllMocks();
    mocks.loadSubagentRegistryFromSqlite.mockReset();
    mocks.loadSubagentRegistryFromSqlite.mockReturnValue(new Map());
    mocks.onAgentEvent.mockReset();
    mocks.onAgentEvent.mockReturnValue(mocks.onAgentEventStop);
    mocks.runSubagentAnnounceFlow.mockReset();
    mocks.runSubagentAnnounceFlow.mockResolvedValue("retryable");
    registry.resetSubagentRegistryForTests({ persist: false });
  });

  afterEach(async () => {
    try {
      await flushAsync();
    } finally {
      registry.resetSubagentRegistryForTests({ persist: false });
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      vi.useRealTimers();
      vi.restoreAllMocks();
      vi.clearAllMocks();
    }
  });

  test("expired entries with high retry count are skipped by resumeSubagentRun", async () => {
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
    await waitForRun(entry.runId, (run) => typeof run.cleanupCompletedAt === "number");

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
    mocks.runSubagentAnnounceFlow.mockResolvedValue(outcome);

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
    vi.spyOn(taskRuntime, "findDetachedTaskRunAsync").mockResolvedValue({
      lookup: "available",
      task: {
        taskId: "task-retry-budget",
        runId: entry.runId,
        runtime: "subagent",
        requesterSessionKey: entry.requesterSessionKey,
        ownerKey: entry.requesterSessionKey,
        scopeKind: "session",
        childSessionKey: entry.childSessionKey,
        task: entry.task,
        status: "succeeded",
        deliveryStatus: "pending",
        notifyPolicy: "done_only",
        createdAt: entry.createdAt,
      },
    });
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
    mocks.runSubagentAnnounceFlow.mockResolvedValueOnce("delivered");

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
    await flushAsync();

    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
  });

  test("announce rejection resets cleanupHandled so retries can resume", async () => {
    mocks.runSubagentAnnounceFlow.mockRejectedValueOnce(new Error("announce failed"));

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
    await flushAsync();

    const stored = await waitForRun(
      runId,
      (run) => run.cleanupHandled === false && run.delivery?.attemptCount === 1,
    );
    expect(stored.cleanupCompletedAt).toBeUndefined();
    expect(stored.delivery?.lastAttemptAt).toBeTypeOf("number");
  });
});
