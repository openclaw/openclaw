// Announce loop-guard tests prove deferred delivery retries through its time
// window, then gives up instead of looping forever after repeated failures.
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { SessionEntry } from "../../../config/sessions.js";
import { withSessionTurn } from "../../../sessions/session-controller.admission.js";
import { captureSessionTarget } from "../../../sessions/session-controller.lifecycle.js";
import {
  adoptSessionControllerSource,
  releaseSessionControllerClaim,
  reserveSessionControllerSource,
  retireSessionControllerInput,
  tryClaimSessionControllerTask,
  type SessionControllerInput,
  type SessionControllerMailboxClaim,
} from "../../../sessions/session-controller.mailbox.js";
import { resetSessionControllerStateForTest } from "../../../sessions/session-lifecycle-admission.test-support.js";
import {
  configureMockSubagentRegistryPersistence,
  type MockSubagentRegistryRows,
} from "../../subagent-test-fixtures.test-helpers.js";
import { createLifecycleWaits } from "./subagent-registry.lifecycle-waits.test-support.js";
import { prepareSubagentRecoveryFixture } from "./subagent-registry.persistence.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const sessionStore = vi.hoisted((): Record<string, SessionEntry> => ({
  "agent:main:main": { sessionId: "sess-main", updatedAt: 1 },
  "agent:main:subagent:child-1": { sessionId: "sess-child-1", updatedAt: 1 },
  "agent:main:subagent:expired-child": { sessionId: "sess-expired", updatedAt: 1 },
  "agent:main:subagent:retry-budget": { sessionId: "sess-retry", updatedAt: 1 },
}));

vi.mock("../../../config/sessions/session-entry-read-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../config/sessions/session-entry-read-runtime.js")
  >()),
  readSessionEntryReadOnlyInWorker: vi.fn<
    typeof import("../../../config/sessions/session-entry-read-runtime.js").readSessionEntryReadOnlyInWorker
  >(async (scope, assertCurrent) => {
    assertCurrent?.();
    const entry = await Promise.resolve(sessionStore[scope.sessionKey]);
    assertCurrent?.();
    return entry;
  }),
  withSessionEntryReadOnlyInWorker: vi.fn<
    typeof import("../../../config/sessions/session-entry-read-runtime.js").withSessionEntryReadOnlyInWorker
  >(async (scope, assertCurrent, consume) => {
    assertCurrent();
    const result = await consume(
      { ok: true, value: sessionStore[scope.sessionKey] },
      { kind: "file", assertCurrent },
    );
    assertCurrent();
    return result;
  }),
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
  runSubagentAnnounceFlow: vi
    .fn<typeof import("../announce/subagent-announce.js").runSubagentAnnounceFlow>()
    .mockResolvedValue("retryable"),
  captureSubagentCompletionReply: vi.fn(),
  loadSubagentRegistryFromSqlite: vi.fn<() => Map<string, SubagentRunRecord>>(() => new Map()),
  persistRegistryRows: vi.fn<MockSubagentRegistryRows>(),
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

// mock-isolation: Keep loop timing independent of native snapshots and worker startup.
vi.mock("../../../state/openclaw-state-db-readonly.js", () => ({
  getActiveOpenClawStateDatabaseReadSnapshot: () => undefined,
  executeExistingOpenClawStateRead: vi.fn<
    typeof import("../../../state/openclaw-state-db-readonly.js").executeExistingOpenClawStateRead
  >(async (_options, command, options) => {
    expect(command).toEqual({ type: "subagents.restore" });
    const runs = mocks.loadSubagentRegistryFromSqlite();
    options?.onChunk?.(
      [...runs.values()].map((entry) => ({
        entry,
        createdAt: entry.createdAt,
      })),
    );
    return { ok: true, type: "subagents.restore", sourceAdmitted: true, count: runs.size };
  }),
}));

vi.mock("../../timeout.js", () => ({
  resolveAgentTimeoutMs: mocks.resolveAgentTimeoutMs,
}));

vi.mock("../announce/subagent-announce.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../announce/subagent-announce.js")>()),
  captureSubagentCompletionReply: mocks.captureSubagentCompletionReply,
  runSubagentAnnounceFlow: mocks.runSubagentAnnounceFlow,
}));
vi.mock("../../../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd: vi.fn(async () => {}),
}));

describe("announce loop guard (#18264)", () => {
  let registry: typeof import("./subagent-registry.test-helpers.js");
  const adoptedInputs: SessionControllerInput[] = [];
  let requesterClaim: SessionControllerMailboxClaim | undefined;

  async function hydrateAndActivateRegistry() {
    await registry.initSubagentRegistry();
    const recoveryRuntime = {
      prepareRestartRecovery: () => undefined,
      resumeChatInput: async () => {
        throw new Error("Unexpected chat input recovery");
      },
      dispatchAgent: vi.fn(),
      waitForAgent: vi.fn(async () => ({ status: "pending" })),
      sendRecoveryNotice: vi.fn(),
    };
    const gatewayContext = {
      recoveryRuntime,
      resolveGatewayContext: () => gatewayContext as never,
    };
    await registry.activateSubagentRegistry(gatewayContext.resolveGatewayContext);
  }

  const { flushAsync } = createLifecycleWaits("agent:main:main");
  const terminalRun = (
    runId: string,
    child: string,
    sessionId: string,
    ages: [number, number, number],
    overrides: Partial<SubagentRunRecord> = {},
  ): SubagentRunRecord => {
    const now = Date.now();
    return {
      runId,
      childSessionKey: `agent:main:subagent:${child}`,
      childSessionIdentity: { sessionId },
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "agent:main:main",
      task: runId,
      cleanup: "keep",
      createdAt: now - ages[0],
      execution: { status: "terminal", startedAt: now - ages[1], endedAt: now - ages[2] },
      completion: { required: false },
      delivery: { status: "pending" },
      ...overrides,
    };
  };
  const restoreRun = (entry: SubagentRunRecord) =>
    mocks.loadSubagentRegistryFromSqlite.mockReturnValue(new Map([[entry.runId, entry]]));

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
  });

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.loadSubagentRegistryFromSqlite.mockReset();
    mocks.loadSubagentRegistryFromSqlite.mockReturnValue(new Map());
    mocks.onAgentEvent.mockReset();
    mocks.onAgentEvent.mockReturnValue(mocks.onAgentEventStop);
    mocks.runSubagentAnnounceFlow.mockReset();
    mocks.runSubagentAnnounceFlow.mockResolvedValue("retryable");
    await registry.resetSubagentRegistryForTests({ persist: false });
    mocks.persistRegistryRows.mockReset();
    await configureMockSubagentRegistryPersistence(mocks);
  });

  afterEach(async () => {
    try {
      if (requesterClaim) {
        releaseSessionControllerClaim(requesterClaim);
        requesterClaim = undefined;
      }
      await flushAsync();
    } finally {
      for (const input of adoptedInputs) {
        retireSessionControllerInput(input);
      }
      await Promise.all(adoptedInputs.map((input) => input.settlement.promise));
      adoptedInputs.length = 0;
      await registry.resetSubagentRegistryForTests({ persist: false });
      resetSessionControllerStateForTest();
      vi.useRealTimers();
      vi.restoreAllMocks();
      vi.clearAllMocks();
    }
  });

  test("expired entries with high retry count are skipped by resumeSubagentRun", async () => {
    const now = Date.now();
    const entry = terminalRun(
      "test-expired-loop",
      "expired-child",
      "sess-expired",
      [15 * 60_000, 14 * 60_000, 10 * 60_000],
      {
        task: "expired test task",
        cleanupCompletedAt: undefined,
        delivery: { status: "pending", attemptCount: 3, lastAttemptAt: now - 9 * 60_000 },
      },
    );
    restoreRun(entry);

    // Initialization finalizes expired pending rows without another recipient-visible attempt.
    const beforeInit = Date.now();
    await hydrateAndActivateRegistry();
    const completed = await waitForRun(
      entry.runId,
      (run) => typeof run.cleanupCompletedAt === "number",
    );

    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(completed.cleanupCompletedAt).toBeGreaterThanOrEqual(beforeInit);
    expect(mocks.persistRegistryRows).toHaveBeenCalledWith(expect.any(Map), [entry.runId]);
  });
  test.each([
    {
      name: "controller queue custody preserves the failure budget without timer replay",
      attemptCount: 3,
      restoreDelayMs: 0,
    },
    {
      name: "restores saved backoff before transferring delivery to the controller queue",
      attemptCount: 3,
      restoreDelayMs: 1_000,
    },
  ])("$name", async ({ attemptCount, restoreDelayMs }) => {
    const busyRequester = reserveSessionControllerSource("agent:main:main", {
      sourceTurnId: "busy-requester",
      policy: { mode: "followup" },
      target: captureSessionTarget({
        storeScope: "/tmp/test-store",
        sessionKey: "agent:main:main",
        agentId: "main",
        incarnation: "sess-main",
      }),
    });
    requesterClaim = tryClaimSessionControllerTask(busyRequester);
    if (!requesterClaim) {
      throw new Error("Expected the busy requester's controller claim");
    }
    mocks.runSubagentAnnounceFlow.mockImplementation(async ({ controllerInput, childRunId }) => {
      const target = controllerInput?.target;
      if (!controllerInput || !target) {
        throw new Error("Expected the completion's reserved controller source");
      }
      adoptSessionControllerSource(controllerInput, {
        target,
        protocolRunId: `queued-${childRunId}`,
        policy: controllerInput.policy,
        adapter: {},
      });
      adoptedInputs.push(controllerInput);
      return await withSessionTurn(
        {
          sessionKey: "agent:main:main",
          sessionId: "sess-main",
          agentId: "main",
          target,
          controllerInput,
        },
        async () => "delivered" as const,
      );
    });

    const now = Date.now();
    const entry = terminalRun(
      "test-retry-budget",
      "retry-budget",
      "sess-retry",
      [120_000, 90_000, 60_000],
      {
        task: "retry window test",
        expectsCompletionMessage: true,
        completion: { required: true },
        delivery: {
          status: "pending",
          attemptCount: 3,
          lastAttemptAt: now - 30_000,
          windowStartedAt: now - 60_000,
          deadlineAt: now - 60_000 + 30 * 60_000,
          ...(restoreDelayMs ? { nextAttemptAt: now + restoreDelayMs } : {}),
        },
      },
    );
    await prepareSubagentRecoveryFixture(entry, { entries: sessionStore });
    restoreRun(entry);

    await hydrateAndActivateRegistry();
    if (restoreDelayMs) {
      await registry.initSubagentRegistry();
      expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(restoreDelayMs);
    }
    const resumed = await waitForRun(
      entry.runId,
      (run) =>
        run.delivery?.attemptCount === attemptCount &&
        run.cleanupHandled === true &&
        adoptedInputs.length === 1,
    );

    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    expect(resumed.cleanupCompletedAt).toBeUndefined();
    expect(resumed.delivery).toMatchObject({
      status: "pending",
      attemptCount,
      windowStartedAt: entry.execution.endedAt,
      deadlineAt: entry.execution.endedAt! + 30 * 60_000,
    });
    expect(adoptedInputs[0]?.custody.rpcAdopted).toBe(true);
    expect(adoptedInputs[0]?.phase).toBe("waiting");
    await vi.advanceTimersByTimeAsync(30_000);
    await flushAsync();
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    expect(registry.getSubagentRunByRunId(entry.runId)?.delivery?.attemptCount).toBe(attemptCount);
    releaseSessionControllerClaim(requesterClaim!);
    requesterClaim = undefined;
    const delivered = await waitForRun(entry.runId, (run) => Boolean(run.cleanupCompletedAt));
    expect(delivered.delivery?.status).toBe("delivered");
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
  });

  test("announce rejection resets cleanupHandled so retries can resume", async () => {
    mocks.runSubagentAnnounceFlow.mockRejectedValueOnce(new Error("announce failed"));

    const runId = "test-announce-rejection";
    const entry = terminalRun(runId, "child-1", "sess-child-1", [30_000, 20_000, 10_000], {
      task: "rejection test",
      cleanupHandled: false,
    });
    restoreRun(entry);
    await prepareSubagentRecoveryFixture(entry, { entries: sessionStore });

    await hydrateAndActivateRegistry();
    await flushAsync();

    const stored = await waitForRun(
      runId,
      (run) => run.cleanupHandled === false && run.delivery?.attemptCount === 1,
    );
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledOnce();
    expect(stored.cleanupCompletedAt).toBeUndefined();
    expect(stored.delivery?.lastAttemptAt).toBeTypeOf("number");
  });
});
