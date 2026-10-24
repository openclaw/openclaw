import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { getRuntimeConfig, type OpenClawConfig } from "../../../config/config.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../../config/io.js";
import {
  loadExactSessionEntryReadOnly,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { readDescendantSubagentFallbackReply } from "../../../cron/isolated-agent/subagent-followup.js";
import { callGateway } from "../../../gateway/call.js";
import { getAgentEventLifecycleGeneration, onAgentEvent } from "../../../infra/agent-events.js";
import * as gatewayWorkAdmission from "../../../process/gateway-work-admission.js";
import { createReplyOperation } from "../../../sessions/session-controller.operation.js";
import { captureSessionTarget } from "../../../sessions/session-controller.target.js";
import { matchesTranscriptEvent } from "../../../sessions/transcript-visible-record.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import type { deliverAgentCommandResult } from "../../command/delivery.js";
import type { EmbeddedAgentRunResult } from "../../embedded-agent-runner/types.js";
import "../spawn/subagent-spawn-model.mocks.shared.js";
import { loadAgentRuntimePluginRegistryHandle } from "../../runtime-plugins.js";
import { createSubagentRunParams } from "../../subagent-test-fixtures.test-helpers.js";
import {
  getSubagentRequesterSessionActivity,
  loadRequesterSessionEntry,
} from "../announce/subagent-announce-delivery.runtime.js";
import { testing as subagentAnnounceDeliveryTesting } from "../announce/subagent-announce-delivery.test-support.js";
import { testing as subagentAnnounceOutputTesting } from "../announce/subagent-announce-output.test-support.js";
import { announceTesting as subagentAnnounceTesting } from "../announce/subagent-announce-overrides.test-support.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import * as completionStore from "../completion/subagent-completion-admission.store.js";
import { registerRequesterFinalAttachment } from "../requester-final-attachment.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { buildScopedSubagentRunReadIndexFromRuns } from "./subagent-registry-queries.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import {
  getAgentResultsForChildSession,
  type LifecycleData,
  type GatewayRequest,
  type SessionStoreEntry,
} from "./subagent-registry.lifecycle-fixture.test-support.js";
import {
  createLifecycleAgentCallWaits,
  createLifecycleWaits,
} from "./subagent-registry.lifecycle-waits.test-support.js";
import {
  createRequesterYieldTool,
  registerRequesterWakeReceiptBoundaryTests,
  visibleChild,
} from "./subagent-registry.requester-wake-receipts.test-support.js";
import {
  createGatewayContext,
  createRequesterWakeSessionFixture,
  holdRequesterWakeResponses,
} from "./subagent-registry.requester-wake-session.test-support.js";
import { registerRequesterWakeSettlementBoundaryTests } from "./subagent-registry.requester-wake-settlement.test-support.js";
import * as registry from "./subagent-registry.test-helpers.js";
import { getSubagentRunRuntimeKey } from "./subagent-run-generation.js";

const MAIN_REQUESTER_SESSION_KEY = "agent:main:main";

type GatewayDeliveryStatus = NonNullable<
  Awaited<ReturnType<typeof deliverAgentCommandResult>>["deliveryStatus"]
>;

type GatewayResponse = {
  status?: string;
  runId?: string;
  messages?: Array<Record<string, unknown>>;
  result?: Partial<EmbeddedAgentRunResult> & { deliveryStatus?: Partial<GatewayDeliveryStatus> };
};

let lifecycleFixture = false;
let agentCallPlan: Array<"ok" | "throw"> = [];
let agentCallWaits: ReturnType<typeof createLifecycleAgentCallWaits> | undefined;
let lifecycleHandler: Parameters<typeof onAgentEvent>[0] | undefined;
let agentCallGates = new Map<string, Promise<void>>();
let releaseAgentCallGate: (() => void) | undefined;
let agentCallObserved = createDeferred();
let chatHistoryBySessionKey = new Map<string, Array<Record<string, unknown>>>();
let sessionStore: Record<string, SessionStoreEntry> = {};
let sessionStorePath: string;
let rejectNextRequesterWake = false;
let rejectNextRequesterWakePersistence = false;
let armRequesterWakePersistenceFailure = false;
let emptyGatedAgentReply = false;
let releaseWakeReceipts: (() => void) | undefined;

const sendMessageMock = vi.fn<typeof import("../../../infra/outbound/message.js").sendMessage>(
  async () => ({
    channel: "discord",
    to: "user-1",
    via: "direct",
    mediaUrl: null,
    result: { messageId: "unexpected-fallback" },
  }),
);

const callGatewayMock = vi.fn(async (request: GatewayRequest): Promise<GatewayResponse> => {
  if (request.method === "agent.wait") {
    return { status: "pending" };
  }
  if (request.method === "chat.history") {
    return { messages: chatHistoryBySessionKey.get(request.params?.sessionKey ?? "") ?? [] };
  }
  if (request.method === "agent") {
    agentCallWaits?.notifyAgentCall();
    if (agentCallPlan.shift() === "throw") {
      throw new Error("announce delivery failed");
    }
    agentCallObserved.resolve();
    agentCallObserved = createDeferred();
    return {
      result: {
        payloads: [{ text: "completion delivered" }],
        deliveryStatus: { status: "sent", resultCount: 1 },
      },
    };
  }
  return {};
});

const loadConfigMock = vi.mocked(getRuntimeConfig);

vi.mock("../../../config/config.js", { spy: true });
vi.mock("../../../gateway/call.js", { spy: true });
vi.mock("../../../infra/agent-events.js", { spy: true });
vi.mock("../../runtime-plugins.js", async () => {
  const { createEmptyPluginRegistry } = await import("../../../plugins/registry-empty.js");
  return {
    loadAgentRuntimePluginRegistryHandle: vi.fn<
      typeof import("../../runtime-plugins.js").loadAgentRuntimePluginRegistryHandle
    >(() => createEmptyPluginRegistry()),
  };
});
vi.mock("../announce/subagent-announce.requester-settle-wake.js", { spy: true });

const { maybeWakeRequesterAfterAllChildrenSettled: wakeRequester } = await vi.importActual<
  typeof import("../announce/subagent-announce.requester-settle-wake.js")
>("../announce/subagent-announce.requester-settle-wake.js");

vi.mock("../../../config/sessions.js", async () => ({
  ...(await import("../../../config/sessions/targets.js")),
  ...(await import("../../../config/sessions/main-session.js")),
  loadSessionStore: vi.fn(() => sessionStore),
  resolveAgentIdFromSessionKey: (key: string) => key.match(/^agent:([^:]+)/)?.[1] ?? "main",
  resolveSessionStorePathCore: () => sessionStorePath,
  resolveMainSessionKey: () => MAIN_REQUESTER_SESSION_KEY,
  updateSessionStore: vi.fn(),
}));

vi.mock("../../../config/sessions/session-accessor.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../../config/sessions/session-accessor.js")>();
  return {
    ...original,
    loadSessionEntry: (scope: { sessionKey: string }) => sessionStore[scope.sessionKey],
    // Timing writes must share the synthetic session fixture used by reads.
    // Subagent settlement below still uses its real SQLite store.
    patchSessionEntryCore: async (
      ...[scope, update, options = {}]: Parameters<
        typeof import("../../../config/sessions/session-accessor.js").patchSessionEntryCore
      >
    ) => {
      if (lifecycleFixture) {
        return original.patchSessionEntryCore(scope, update, options);
      }
      const entry = sessionStore[scope.sessionKey];
      if (!entry) {
        return null;
      }
      const patch = await update(entry, { existingEntry: { ...entry } });
      if (patch === null || options.shouldCommit?.() === false) {
        return entry;
      }
      options.assertCommitAllowed?.();
      const updated = options.replaceEntry
        ? (patch as import("../../../config/sessions/types.js").SessionEntry)
        : { ...entry, ...patch };
      sessionStore[scope.sessionKey] = updated;
      return updated;
    },
    listSessionEntriesReadOnly: () =>
      Object.entries(sessionStore).map(([sessionKey, entry]) => ({ sessionKey, entry })),
  };
});

vi.mock("../../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

vi.mock("../../../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd: vi.fn(async () => {}),
}));

// mock-isolation: Wake fixtures supply requester depth without opening a session database.
vi.mock("../spawn/subagent-depth.js", () => ({
  getSubagentDepthFromSessionStore: () => 0,
  getSubagentDepthFromSessionStoreInWorker: async () => 0,
}));

describe("requester settle wake product flow", () => {
  let testState: OpenClawTestState;
  let settleRootWork: ReturnType<typeof observeRootWork>;
  const { flushAsync, waitForDeliveredCleanup } = createLifecycleWaits(MAIN_REQUESTER_SESSION_KEY);
  const flushOwnedWork = async () => {
    await flushAsync();
    await settleRootWork(true);
  };

  beforeEach(async () => {
    testState = await createOpenClawTestState({ scenario: "minimal", applyEnv: true });
    sessionStorePath = testState.statePath("agents", "main", "sessions", "sessions.json");
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    const config: OpenClawConfig = {
      agents: {
        defaults: { subagents: { archiveAfterMinutes: 0 } },
        entries: { main: {}, research: {} },
      },
      session: { mainKey: "main", scope: "per-sender" },
    };
    setRuntimeConfigSnapshot(config);
    loadConfigMock.mockReset().mockReturnValue(config);
    callGatewayMock.mockClear();
    vi.mocked(callGateway).mockImplementation(callGatewayMock as typeof callGateway);
    vi.mocked(loadAgentRuntimePluginRegistryHandle).mockReset();
    vi.mocked(onAgentEvent).mockImplementation((handler) => {
      lifecycleHandler = handler;
      return () => {};
    });
    lifecycleFixture = false;
    agentCallPlan = [];
    agentCallWaits = undefined;
    agentCallGates = new Map();
    agentCallObserved = createDeferred();
    chatHistoryBySessionKey = new Map();
    rejectNextRequesterWake = false;
    rejectNextRequesterWakePersistence = false;
    armRequesterWakePersistenceFailure = false;
    emptyGatedAgentReply = false;
    sendMessageMock.mockClear();
    sessionStore = {
      [MAIN_REQUESTER_SESSION_KEY]: {
        sessionId: "sess-main",
        updatedAt: 1,
        delivery: {
          kind: "external",
          route: { channel: "discord", accountId: "default", target: { to: "user-1" } },
          context: { channel: "discord", to: "user-1", accountId: "default" },
          origin: { provider: "discord", to: "user-1", accountId: "default" },
        },
      },
    };
    await replaceSessionEntry(
      { storePath: sessionStorePath, sessionKey: MAIN_REQUESTER_SESSION_KEY },
      sessionStore[MAIN_REQUESTER_SESSION_KEY]!,
    );
    vi.useFakeTimers();
    settleRootWork = observeRootWork();
    const settle = completionStore.mutateRequesterCompletionBatch;
    vi.spyOn(completionStore, "mutateRequesterCompletionBatch").mockImplementation(
      async (params) => {
        if (params.operation.kind === "settle" && rejectNextRequesterWakePersistence) {
          rejectNextRequesterWakePersistence = false;
          throw new Error("database is locked");
        }
        return settle(params);
      },
    );
    vi.mocked(maybeWakeRequesterAfterAllChildrenSettled).mockImplementation(async (params) => {
      if (rejectNextRequesterWake) {
        rejectNextRequesterWake = false;
        rejectNextRequesterWakePersistence = armRequesterWakePersistenceFailure;
        armRequesterWakePersistenceFailure = false;
        throw new Error("requester wake rejected before attempt admission");
      }
      return await wakeRequester(params);
    });
    const gatewayDeps = {
      callGateway: callGatewayMock as typeof import("../../../gateway/call.js").callGateway,
      getRuntimeConfig: loadConfigMock,
    };
    subagentAnnounceTesting.setDepsForTest(gatewayDeps);
    subagentAnnounceDeliveryTesting.setDepsForTest({
      ...gatewayDeps,
      sendMessage: sendMessageMock,
      loadSessionEntry: ({ sessionKey }) => sessionStore[sessionKey],
      getRequesterSessionActivity: (requesterSessionKey: string) => ({
        sessionId: sessionStore[requesterSessionKey]?.sessionId,
        target: captureSessionTarget({
          storeScope: sessionStorePath,
          sessionKey: requesterSessionKey,
          incarnation: sessionStore[requesterSessionKey]?.sessionId,
        }),
        isActive: false,
      }),
    });
    subagentAnnounceOutputTesting.setDepsForTest({
      ...gatewayDeps,
      readSubagentSessionEntry: (_storePath, sessionKey) => sessionStore[sessionKey],
      resolveSessionStorePathCore: () => sessionStorePath,
    });
    holdRequesterWakeResponses(agentCallGates, () => emptyGatedAgentReply);
  });

  afterEach(async () => {
    // Failed assertions must also release the delivery owned by this test.
    releaseAgentCallGate?.();
    releaseAgentCallGate = undefined;
    releaseWakeReceipts?.();
    releaseWakeReceipts = undefined;
    try {
      try {
        await vi.advanceTimersByTimeAsync(0);
      } finally {
        await agentCallWaits?.settle();
        await settleRootWork();
      }
    } finally {
      lifecycleHandler = undefined;
      subagentAnnounceDeliveryTesting.setDepsForTest();
      subagentAnnounceOutputTesting.setDepsForTest();
      subagentAnnounceTesting.setDepsForTest();
      await registry.resetSubagentRegistryForTests({ persist: false });
      vi.useRealTimers();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await testState.cleanup();
      clearRuntimeConfigSnapshot();
    }
  });

  const getAgentCalls = () =>
    (callGatewayMock.mock.calls as [GatewayRequest][])
      .map(([request]) => request)
      .filter((request) => request.method === "agent");

  const getRequesterWakeCalls = () =>
    getAgentCalls().filter((request) =>
      request.params?.idempotencyKey?.startsWith("announce:requester-settle:"),
    );

  const activeDescendants = () =>
    buildScopedSubagentRunReadIndexFromRuns(
      subagentRuns,
      MAIN_REQUESTER_SESSION_KEY,
      "main",
    ).countActiveDescendantRuns(MAIN_REQUESTER_SESSION_KEY);

  const activateRegistry = async (context = createGatewayContext()) => {
    await registry.initSubagentRegistry();
    await registry.activateSubagentRegistry(() => context).settled;
    return context;
  };

  const expectRawChildDelivered = (entry: ReturnType<typeof registry.getSubagentRunByRunId>) => {
    expect(entry).toMatchObject({
      childSessionKey: "global",
      childAgentId: "main",
      childSessionIdentity: { sessionId: "sess-run-serial-alpha", lifecycleRevision: "original" },
      execution: { status: "terminal" },
      delivery: { status: "delivered" },
      requesterSettleWake: undefined,
      cleanupCompletedAt: expect.any(Number),
      browserCleanupDispatchedAt: expect.any(Number),
    });
    expect(entry?.execution.suppressSessionEffects).not.toBe(true);
  };

  const waitForAgentCallCount = async (expectedCount: number) => {
    while (getAgentCalls().length < expectedCount) {
      await agentCallObserved.promise;
    }
  };

  const { prepareChildSession, spawnVisibleChild, settleTurn } = createRequesterWakeSessionFixture({
    requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
    getSessionStore: () => sessionStore,
    getSessionStorePath: () => sessionStorePath,
  });

  const emitCompleted = (
    runId: string,
    childSessionKey: string,
    text: string,
    modelRouteChange?: string,
  ) => {
    chatHistoryBySessionKey.set(childSessionKey, [{ role: "assistant", content: text }]);
    if (!lifecycleHandler) {
      throw new Error("Fixture lifecycle listener was not registered before completion");
    }
    lifecycleHandler({
      stream: "lifecycle",
      runId,
      seq: 1,
      ts: Date.now(),
      sessionKey: childSessionKey,
      data: {
        phase: "end",
        endedAt: Date.now(),
        terminalReply: {
          disposition: "visible",
          text,
          ...(modelRouteChange ? { modelRouteChange } : {}),
        },
      },
    });
  };

  const requesterFixture = {
    requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
    prepareChildSession,
    spawnVisibleChild,
    settleTurn,
    getFixture: () => ({ testState, sessionStore, sessionStorePath }),
    createGatewayContext,
    getLifecycleHandler: () => lifecycleHandler,
    emitCompleted,
    flushOwnedWork,
    waitForDeliveredCleanup,
    waitForAgentCallCount,
    getRequesterWakeCalls,
    getAgentCalls,
    wakeRequester,
  };

  registerRequesterWakeReceiptBoundaryTests({
    ...requesterFixture,
    sendMessageMock,
    setEmptyReply: (value) => {
      emptyGatedAgentReply = value;
    },
    setWakeRefusal: (wake, persistence) => {
      rejectNextRequesterWake = wake;
      armRequesterWakePersistenceFailure = persistence;
    },
    holdAgentCall: (sessionKey) => {
      agentCallGates.set(
        sessionKey,
        new Promise<void>((resolve) => {
          releaseAgentCallGate = resolve;
        }),
      );
    },
    releaseAgentCall: (sessionKey) => {
      agentCallGates.delete(sessionKey);
      releaseAgentCallGate?.();
    },
    onReceiptsHeld: (release) => {
      releaseWakeReceipts = release;
    },
  });

  it("preserves serial continuation and final attachment without replaying an accepted wave", async () => {
    vi.setSystemTime(100_000);
    await activateRegistry();
    const alpha = { ...visibleChild("serial-alpha"), childSessionKey: "global" };
    const beta = visibleChild("serial-beta");
    const yieldTurn = async (requesterTurnRunId: string, accepted: (typeof alpha)[]) => {
      const result = await createRequesterYieldTool(
        MAIN_REQUESTER_SESSION_KEY,
        requesterTurnRunId,
      ).execute(`yield-${requesterTurnRunId}`, {});
      expect(result).toMatchObject({
        details: { status: accepted.length > 0 ? "yielded" : "nothing_pending" },
      });
      return settleTurn(requesterTurnRunId, accepted, accepted.length > 0);
    };
    const ordinaryGatewayCall = callGatewayMock.getMockImplementation()!;
    let firstWakeReturned = false;
    let visibleFinals = 0;
    const initialRequesterTurnRunId = "requester-serial-initial";
    const append = vi.fn(() => true);
    const attachment = registerRequesterFinalAttachment({
      requesterAgentId: "main",
      requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
      requesterSessionId: "sess-main",
      requesterTurnRunId: initialRequesterTurnRunId,
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      timeoutMs: 600_000,
      append,
    });
    try {
      await callGatewayMock.withImplementation(
        async (request) => {
          if (
            request.method !== "agent" ||
            !request.params?.idempotencyKey?.startsWith("announce:requester-settle:")
          ) {
            return await ordinaryGatewayCall(request);
          }
          if (!firstWakeReturned) {
            // Gateway preflight uses this exact idempotency key as the run ID.
            const requesterTurnRunId = request.params.idempotencyKey;
            const firstEndedAt = registry.getSubagentRunByRunId(alpha.runId)?.execution.endedAt;
            expect(firstEndedAt).toEqual(expect.any(Number));
            vi.setSystemTime(firstEndedAt! + 1);
            await spawnVisibleChild({ ...beta, requesterTurnRunId });
            expect(registry.getSubagentRunByRunId(beta.runId)?.createdAt).toBeGreaterThan(
              firstEndedAt!,
            );
            const result = await yieldTurn(requesterTurnRunId, [beta]);
            firstWakeReturned = true;
            return { runId: requesterTurnRunId, status: "ok", result };
          }
          visibleFinals += 1;
          const response = await ordinaryGatewayCall(request);
          return {
            ...response,
            result: {
              ...response.result,
              meta: { durationMs: 1, finalAssistantVisibleText: "completion delivered" },
            },
          };
        },
        async () => {
          await spawnVisibleChild({ ...alpha, requesterTurnRunId: initialRequesterTurnRunId });
          await yieldTurn(initialRequesterTurnRunId, [alpha]);
          attachment?.releaseProvisional();
          emitCompleted(alpha.runId, alpha.childSessionKey, "alpha findings");
          await flushOwnedWork();
          await vi.waitFor(() => {
            expect(firstWakeReturned).toBe(true);
          });
          await vi.advanceTimersByTimeAsync(0);
          expect(getRequesterWakeCalls()).toHaveLength(1);
          expect(visibleFinals).toBe(0);
          expect(append).not.toHaveBeenCalled();
          expect(activeDescendants()).toBe(1);
          expect(registry.getSubagentRunByRunId(beta.runId)).toMatchObject({
            requesterTurnRunId: undefined,
            requesterSettleWake: {
              batchRunIds: [beta.runId],
              requesterYieldBatch: true,
            },
          });
          emitCompleted(beta.runId, beta.childSessionKey, "beta findings");
          await flushOwnedWork();
          await waitForDeliveredCleanup(beta.runId);
          emitCompleted(beta.runId, beta.childSessionKey, "beta findings");
          // Duplicate terminal events must not replay the delivered continuation.
          await flushOwnedWork();
          await vi.advanceTimersByTimeAsync(151_000);
          await registry.testing.sweepOnceForTests();
          await vi.advanceTimersByTimeAsync(0);
          await flushOwnedWork();
          for (const child of [alpha, beta]) {
            await waitForDeliveredCleanup(child.runId);
          }
          expect(
            getRequesterWakeCalls().map(
              (request) => request.params?.inputProvenance?.sourceSessionKey,
            ),
          ).toEqual([alpha.childSessionKey, beta.childSessionKey]);
          expect(visibleFinals).toBe(1);
          expect(sendMessageMock).not.toHaveBeenCalled();
          expect(activeDescendants()).toBe(0);
          expect(append).toHaveBeenCalledExactlyOnceWith("completion delivered");
          expectRawChildDelivered(loadSubagentRegistryFromSqlite().get(alpha.runId));
          expect(
            loadExactSessionEntryReadOnly({
              agentId: "main",
              storePath: sessionStorePath,
              sessionKey: "global",
            })?.entry,
          ).toMatchObject({ sessionId: "sess-run-serial-alpha", lifecycleRevision: "original" });
        },
      );
    } finally {
      attachment.revoke();
    }
  });

  it.each([
    { archiveAfterMinutes: 1, retiredAfterMs: 60_000, restart: false },
    // Without an archive deadline, settled delete rows fall back to the five-minute run TTL.
    { archiveAfterMinutes: 0, retiredAfterMs: 5 * 60_000 + 1, restart: true },
  ])(
    "keeps a cron run's delete-cleanup child readable after its settle wake (archive=$archiveAfterMinutes, restart=$restart)",
    async ({ archiveAfterMinutes, retiredAfterMs, restart }) => {
      vi.setSystemTime(100_000);
      const cronRunSessionKey = "agent:main:cron:job-spawn-only:run:sess-cron";
      const child = { runId: "run-cron-child", childSessionKey: "agent:main:subagent:cron-child" };
      const cfg = loadConfigMock();
      loadConfigMock.mockReturnValue({
        ...cfg,
        agents: { ...cfg.agents, defaults: { subagents: { archiveAfterMinutes } } },
      });
      sessionStore[cronRunSessionKey] = { sessionId: "sess-cron", updatedAt: 1 };
      await replaceSessionEntry(
        { storePath: sessionStorePath, sessionKey: cronRunSessionKey },
        sessionStore[cronRunSessionKey],
      );
      const context = createGatewayContext();
      await activateRegistry(context);
      const sessionEntry = await prepareChildSession(child.childSessionKey, "sess-cron-child");
      await registry.registerSubagentRun(
        createSubagentRunParams({
          ...child,
          sessionEntry,
          requesterSessionKey: cronRunSessionKey,
          requesterDisplayKey: "cron",
          cleanup: "delete",
          expectsCompletionMessage: true,
        }),
      );

      vi.setSystemTime(Date.now() + 90_000);
      const endedAt = Date.now();
      emitCompleted(child.runId, child.childSessionKey, "CRON CHILD ANSWER");
      await flushOwnedWork();
      await vi.waitFor(() => {
        expect(maybeWakeRequesterAfterAllChildrenSettled).toHaveBeenCalledWith(
          expect.objectContaining({
            settledEntry: expect.objectContaining({ runId: child.runId }),
          }),
        );
        expect(registry.getSubagentRunByRunId(child.runId)?.requesterSettleWake).toBeUndefined();
      });
      await flushOwnedWork();
      if (archiveAfterMinutes) {
        expect(registry.getSubagentRunByRunId(child.runId)?.archiveAtMs).toBe(endedAt + 60_000);
      }
      // Delete cleanup removed the child session; the cron run reads the captured result.
      chatHistoryBySessionKey.delete(child.childSessionKey);
      if (restart) {
        await registry.resetSubagentRegistryForTests({ persist: false });
        await registry.initSubagentRegistry();
        await registry.activateSubagentRegistry(() => context).settled;
        await flushOwnedWork();
      }

      await expect(
        readDescendantSubagentFallbackReply({ sessionKey: cronRunSessionKey, runStartedAt: 0 }),
      ).resolves.toBe("CRON CHILD ANSWER");
      expect(getAgentCalls()).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(retiredAfterMs);
      await flushOwnedWork();
      await registry.testing.sweepOnceForTests();
      await flushOwnedWork();
      expect(registry.getSubagentRunByRunId(child.runId)).toBeUndefined();
      expect(getAgentCalls()).toHaveLength(0);
    },
  );

  it("retires a delivered wave while a yielded cohort settles during its evaluation", async () => {
    vi.setSystemTime(100_000);
    await activateRegistry();
    const wave = ["wave-a", "wave-b"].map(visibleChild);
    const cohort = visibleChild("cohort");
    for (const child of wave) {
      await spawnVisibleChild({ ...child, requesterTurnRunId: "requester-wave" });
    }
    await settleTurn("requester-wave", wave, false);
    await spawnVisibleChild({ ...cohort, requesterTurnRunId: "requester-cohort" });
    await createRequesterYieldTool(MAIN_REQUESTER_SESSION_KEY, "requester-cohort").execute(
      "yield-cohort",
      {},
    );
    await settleTurn("requester-cohort", [cohort], true);
    // Let both results reach the wave before either singleton can retire.
    const alphaPending = createDeferred();
    const releaseAlpha = createDeferred();
    const evaluated = createDeferred<boolean>();
    const release = createDeferred();
    let heldAlpha = false;
    let held = false;
    vi.mocked(maybeWakeRequesterAfterAllChildrenSettled).mockImplementation(async (params) => {
      if (params.settledEntry.runId === wave[0]!.runId && !heldAlpha) {
        heldAlpha = true;
        alphaPending.resolve();
        await releaseAlpha.promise;
      }
      const woke = await wakeRequester(params);
      if (wave.some((child) => child.runId === params.settledEntry.runId) && !held) {
        held = true;
        evaluated.resolve(woke);
        await release.promise;
      }
      return woke;
    });
    try {
      emitCompleted(wave[0]!.runId, wave[0]!.childSessionKey, "wave alpha findings");
      await alphaPending.promise;
      // Hold the grouped evaluation after its delivered wave retires.
      emitCompleted(wave[1]!.runId, wave[1]!.childSessionKey, "wave beta findings");
      await waitForDeliveredCleanup(wave[1]!.runId, { allowPendingRequesterSettleWake: true });
      // Members share one evaluation slot; either member may own the grouped read.
      releaseAlpha.resolve();
      await expect(evaluated.promise).resolves.toBe(false);
      emitCompleted(cohort.runId, cohort.childSessionKey, "cohort findings");
      // The cohort's own wake settles while the wave's evaluation is still held.
      await vi.waitFor(() => {
        expect(registry.getSubagentRunByRunId(cohort.runId)?.requesterSettleWake).toBeUndefined();
        expect(getRequesterWakeCalls()).toHaveLength(1);
      });
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      releaseAlpha.resolve();
      release.resolve();
    }
    await flushOwnedWork();
    expect(
      getRequesterWakeCalls().map((request) => request.params?.inputProvenance?.sourceSessionKey),
    ).toEqual([cohort.childSessionKey]);
    for (const child of wave) {
      expect(registry.getSubagentRunByRunId(child.runId)?.requesterSettleWake).toBeUndefined();
    }
  });

  registerRequesterWakeSettlementBoundaryTests({
    ...requesterFixture,
    callGatewayMock,
    flushAsync,
    setReleaseAgentCallGate: (release) => {
      releaseAgentCallGate = release;
    },
    useGlobalSessionScope: () => {
      const cfg = loadConfigMock();
      loadConfigMock.mockReturnValue({ ...cfg, session: { ...cfg.session, scope: "global" } });
    },
  });
  describe("lifecycle completion delivery", () => {
    let requesterActive = false;
    let transcriptEventsBySessionKey = new Map<string, unknown[]>();
    const { waitForRun, waitForFrozenResultText } = createLifecycleWaits(
      MAIN_REQUESTER_SESSION_KEY,
    );
    const waitForCalls = (count: number) => agentCallWaits!.waitForAgentCallCount(count);
    const advanceAndFlush = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
      await flushAsync();
    };
    beforeEach(() => {
      lifecycleFixture = true;
      requesterActive = false;
      transcriptEventsBySessionKey = new Map();
      agentCallWaits = createLifecycleAgentCallWaits(
        MAIN_REQUESTER_SESSION_KEY,
        () => getAgentCalls().length,
      );
      const gatewayDeps = {
        callGateway: callGatewayMock as typeof callGateway,
        getRuntimeConfig: loadConfigMock,
      };
      subagentAnnounceDeliveryTesting.setDepsForTest({
        ...gatewayDeps,
        loadSessionEntry: ({ sessionKey }) => sessionStore[sessionKey],
        getRequesterSessionActivity: (requesterSessionKey, requester) => {
          const entry = sessionStore[requesterSessionKey];
          return {
            sessionId: entry?.sessionId,
            target: captureSessionTarget({
              storeScope: requester.storePath ?? sessionStorePath,
              sessionKey: requester.canonicalKey,
              agentId: requester.agentId,
              incarnation: entry?.sessionId,
            }),
            isActive: requesterActive,
          };
        },
      });
      subagentAnnounceOutputTesting.setDepsForTest({
        ...gatewayDeps,
        findTranscriptEvent: async ({ sessionKey }, match) => {
          const event = (
            sessionKey ? transcriptEventsBySessionKey.get(sessionKey) : undefined
          )?.findLast((candidate) => matchesTranscriptEvent(candidate, match));
          return event === undefined ? undefined : { event };
        },
        findSessionTranscriptArchiveEventReadOnly: async () => undefined,
        readSessionMessagesAsync: async ({ sessionKey }) =>
          chatHistoryBySessionKey.get(sessionKey ?? "") ?? [],
        readSubagentSessionEntry: (_storePath, sessionKey) => sessionStore[sessionKey],
        resolveSessionStorePathCore: () => sessionStorePath,
      });
    });
    async function prepareRun(suffix: string, text: string) {
      const runId = `run-${suffix}`;
      const childSessionKey = `agent:main:subagent:${suffix}`;
      const sessionEntry = await prepareChildSession(childSessionKey, `sess-${runId}`);
      await registry.registerSubagentRun(
        createSubagentRunParams({
          runId,
          childSessionKey,
          sessionEntry,
          requesterAgentId: "main",
          task: suffix,
          expectsCompletionMessage: true,
        }),
      );
      setAssistantOutput(childSessionKey, text, runId);
      return { runId, childSessionKey };
    }

    function emitLifecycleEvent(
      runId: string,
      data: LifecycleData,
      options?: { sessionKey?: string },
    ) {
      lifecycleHandler?.({
        stream: "lifecycle",
        runId,
        seq: 1,
        ts: Date.now(),
        sessionKey: options?.sessionKey,
        data,
      });
    }

    function endRun(runId: string, text: string, endedAt = Date.now()) {
      emitLifecycleEvent(runId, {
        phase: "end",
        endedAt,
        terminalReply: { disposition: "visible", text },
      });
    }

    const findRun = (runId: string) =>
      registry
        .listSubagentRunsForRequester(MAIN_REQUESTER_SESSION_KEY)
        .find((run) => run.runId === runId);
    const resultsFor = (sessionKey: string) =>
      getAgentResultsForChildSession(getAgentCalls(), sessionKey);
    const firstOutcome = () => getAgentCalls()[0]?.params?.internalEvents?.[0];

    function setAssistantOutput(sessionKey: string, text: string, runId: string) {
      const message = {
        role: "assistant",
        content: text,
        stopReason: "stop",
        __openclaw: { runId },
      };
      chatHistoryBySessionKey.set(sessionKey, [message]);
      const events = transcriptEventsBySessionKey.get(sessionKey) ?? [];
      events.push({ type: "message", message });
      transcriptEventsBySessionKey.set(sessionKey, events);
    }

    it("delivers a restart interruption once after the requester becomes available", async () => {
      const cleanupAttempts: Promise<unknown>[] = [];
      const cleanupObservation = vi.mocked(
        gatewayWorkAdmission.runWithGatewayDetachedWorkContinuation,
      );
      const original = expectDefined(
        cleanupObservation.getMockImplementation(),
        "root admission observer",
      );
      cleanupObservation.mockImplementation((run, origin) => {
        const work = original(run, origin);
        if (origin === "subagents:lifecycle-cleanup") {
          cleanupAttempts.push(work);
        }
        return work;
      });
      let operation: ReturnType<typeof createReplyOperation> | undefined;
      try {
        const child = await prepareRun("restart-child", "retained child progress");
        const requester = sessionStore[MAIN_REQUESTER_SESSION_KEY]!;
        delete sessionStore[MAIN_REQUESTER_SESSION_KEY];
        expect(
          await registry.finalizeInterruptedSubagentRun({
            runId: child.runId,
            error: "Subagent execution was interrupted by a Gateway restart.",
            endedAt: Date.now(),
          }),
        ).toBe(1);
        await waitForRun(
          child.runId,
          (run) => run.cleanupHandled === false && Boolean(run.delivery?.payload),
        );
        await expectDefined(cleanupAttempts[0], "failed boot cleanup");
        expect(findRun(child.runId)?.delivery?.status).toBe("pending");
        expect(getAgentCalls()).toHaveLength(0);

        sessionStore[MAIN_REQUESTER_SESSION_KEY] = requester;
        operation = createReplyOperation({
          sessionKey: MAIN_REQUESTER_SESSION_KEY,
          sessionId: requester.sessionId!,
          resetTriggered: false,
          target: expectDefined(
            getSubagentRequesterSessionActivity(
              MAIN_REQUESTER_SESSION_KEY,
              await loadRequesterSessionEntry(MAIN_REQUESTER_SESSION_KEY, "main"),
            ).target,
            "recovered requester target",
          ),
        });
        operation.setPhase("running");
        const received: string[] = [];
        operation.attachBackend({
          kind: "embedded",
          cancel() {},
          supportsTranscriptCommitWait: true,
          messageInjectionV2: {
            version: 2,
            isAvailable: () => true,
            queueMessage: async (text, options, assertCurrent) => {
              assertCurrent();
              received.push(options?.currentInboundContext?.text ?? text);
              options?.onQueueAccepted?.(true);
            },
          },
        });
        requesterActive = true;
        await advanceAndFlush(30_000);
        for (const cleanup of cleanupAttempts) {
          await cleanup;
        }
        expect(findRun(child.runId)?.delivery?.status).toBe("delivered");
        operation.complete();
        requesterActive = false;
        registry.resumeSubagentRun(child.runId);
        await advanceAndFlush(30_000);
        await waitForDeliveredCleanup(child.runId);
        expect(received).toHaveLength(1);
        expect(received[0]).toContain(child.runId);
        expect(getAgentCalls()).toHaveLength(0);
        expect(getRequesterWakeCalls()).toHaveLength(0);
      } finally {
        operation?.complete();
        requesterActive = false;
        cleanupObservation.mockImplementation(original);
      }
    });

    it("delivers terminal failure only after error grace", async () => {
      const { runId } = await prepareRun("terminal-error", "fatal summary");
      emitLifecycleEvent(runId, { phase: "error", error: "fatal failure", endedAt: Date.now() });
      await flushAsync();
      expect(getAgentCalls()).toHaveLength(0);
      await advanceAndFlush(15_000);
      await waitForCalls(1);
      expect(firstOutcome()?.status).toBe("error");
      expect(firstOutcome()?.statusLabel).toContain("fatal failure");
    });

    it.each(["corrected same-run final", "silent follow-up"] as const)(
      "retries frozen output without substituting later traffic: %s",
      async (mode) => {
        const corrected = mode === "corrected same-run final";
        const firstText = corrected
          ? "Both spawned. Waiting for completion events..."
          : "All work complete, final summary";
        const resultText = corrected
          ? "All 3 subagents complete. Here's the final summary."
          : firstText;
        const { runId, childSessionKey } = await prepareRun(
          corrected ? "refresh" : "refresh-silent",
          firstText,
        );
        agentCallPlan = ["throw", "ok"];
        const endedAt = Date.now();
        endRun(runId, firstText, endedAt);
        await flushAsync();
        await waitForCalls(1);
        expect(resultsFor(childSessionKey)).toEqual([firstText]);
        await agentCallWaits!.waitForCleanupHandledFalse(runId);
        await waitForFrozenResultText(runId, firstText);
        const before = expectDefined(findRun(runId), "frozen completion before refresh");
        const firstCapturedAt = before.completion?.capturedAt ?? 0;

        if (corrected) {
          setAssistantOutput(childSessionKey, resultText, runId);
          setAssistantOutput(childSessionKey, "Unrelated later turn", "run-refresh-followup-turn");
        } else {
          const followupRunId = "run-refresh-silent-followup-turn";
          setAssistantOutput(childSessionKey, "NO_REPLY", followupRunId);
          emitLifecycleEvent(
            followupRunId,
            { phase: "end", endedAt: endedAt + 200 },
            { sessionKey: childSessionKey },
          );
          await flushAsync();
          // The legacy refresh briefly polls the silent follow-up.
          await vi.advanceTimersByTimeAsync(50);
          expect(findRun(runId)?.completion?.resultText).toBe(resultText);
        }
        endRun(runId, resultText, endedAt + 300);
        await flushAsync();
        const after = await waitForFrozenResultText(runId, resultText);
        expect(getSubagentRunRuntimeKey(after)).toBe(getSubagentRunRuntimeKey(before));
        expect(after).toMatchObject({
          runId,
          generation: before.generation,
          childSessionKey,
          execution: { status: "terminal" },
          completion: { resultText, terminalReply: { disposition: "visible", text: resultText } },
        });
        expect(after.completion?.capturedAt).toBeGreaterThanOrEqual(firstCapturedAt);
        await waitForCalls(2);
        expect(resultsFor(childSessionKey)).toEqual([firstText, resultText]);
      },
    );

    it.each([false, true])("settles provider timeout (recovered: %s)", async (recovered) => {
      const text = recovered
        ? "Final answer after recovery"
        : "Partial output before provider timeout";
      const { runId } = await prepareRun(recovered ? "timeout-cancel" : "provider-timeout", text);
      emitLifecycleEvent(runId, {
        phase: "end",
        aborted: true,
        status: "timeout",
        timeoutPhase: "provider",
        providerStarted: true,
        endedAt: Date.now(),
        ...(!recovered ? { stopReason: "restart", error: "provider timed out" } : {}),
      });
      await flushAsync();
      expect(getAgentCalls()).toHaveLength(0);
      if (recovered) {
        endRun(runId, text);
        await flushAsync();
      } else {
        await advanceAndFlush(30_000);
      }
      await waitForCalls(1);
      expect(firstOutcome()?.status).toBe(recovered ? "ok" : "timeout");
      if (!recovered) {
        expect(findRun(runId)?.execution.outcome?.status).toBe("timeout");
        return;
      }
      await waitForDeliveredCleanup(runId);
      await advanceAndFlush(30_000);
      expect(
        getAgentCalls().filter((request) =>
          request.params?.idempotencyKey?.startsWith("announce:v1:"),
        ),
      ).toHaveLength(1);
      expect(getRequesterWakeCalls()).toHaveLength(0);
    });
  });
});
