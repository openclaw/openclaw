// Subagent registry tests cover run state, completion capture, archive cleanup,
// persistence, lifecycle hooks, and orphan recovery scheduling.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../../test/helpers/promise.js";
import { cleanupBrowserSessionsForLifecycleEnd } from "../../../browser-lifecycle-cleanup.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../../config/io.js";
import {
  runWithOwnedSessionTranscriptWrite,
  withOwnedSessionTranscriptWrites,
} from "../../../config/sessions/transcript-write-context.js";
import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import { createMockGatewayRecoveryRuntime } from "../../../gateway/server-recovery-runtime.test-support.js";
import type { AgentEventPayload } from "../../../infra/agent-events.js";
import { GatewayDispatchUnavailableError } from "../../../infra/restart-recovery-errors.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { getPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { captureSessionTarget } from "../../../sessions/session-controller.lifecycle.js";
import { createReplyOperation } from "../../../sessions/session-controller.operation.js";
vi.mocked(cleanupBrowserSessionsForLifecycleEnd).mockReset();
import { buildAgentRunTerminalOutcomeFromLifecycleEvent } from "../../agent-run-terminal-outcome.js";
import type { SubagentRegistryHarness } from "../../subagent-test-fixtures.test-helpers.js";
import {
  configureMockSubagentRegistryPersistence,
  createSessionEntry,
  createSubagentRunParams,
  createSubagentRunRecord,
  mockGatewayMethods,
  waitForFast,
} from "../../subagent-test-fixtures.test-helpers.js";
import { createRequesterTranscriptWriter } from "../../test-helpers/requester-transcript-writer.test-support.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import { releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import { observeSwarmSchedulerWork } from "../swarm/swarm-scheduler.lifecycle.test-support.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";
import { PROVISIONAL_KILL_RECONCILIATION_MS } from "./subagent-registry-helpers.js";
import { mockRegistryRequesterWakeMutation } from "./subagent-registry-lifecycle-completion.test-support.js";
import { publishSubagentRunChanges } from "./subagent-registry-publication.js";
import {
  registerSubagentResultRefreshCases,
  updateSubagentRunFixture as updateFixtureRun,
} from "./subagent-registry-result-refresh.test-support.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryChangesToSqlite,
} from "./subagent-registry-state.fixture.test-support.js";
import { registerYieldFollowupAdoptionTests } from "./subagent-registry-yield-followup-adoption.test-support.js";
import { registerYieldedParentCleanupCase } from "./subagent-registry-yielded-cleanup.test-support.js";
import {
  observeRootWork,
  registerBrowserCleanupBoundaryTests,
} from "./subagent-registry.browser-cleanup.test-support.js";
import { registerCancellationReconciliationTests } from "./subagent-registry.cancellation-reconciliation.test-support.js";
import { registerCollectorArchiveTests } from "./subagent-registry.collector-archive.test-support.js";
import {
  registerForcedCollectorCompletionSettlementTests,
  registerQueuedCollectorLaunchSettlementTest,
  registerRestartDrainCompletionSettlementTest,
  registerTimeoutSuccessAnnouncementTest,
} from "./subagent-registry.native-settlement.test-support.js";
import { registerSupersededNativeTimingTest } from "./subagent-registry.native-termination.test-support.js";
import {
  prepareSubagentRecoveryFixture,
  registerSubagentRegistrationPersistenceTests,
} from "./subagent-registry.persistence.test-support.js";
import {
  activateSubagentRegistryWithRecoveryRuntime,
  registerRestoredLegacyAuthorityTests,
  registerRestoredRequesterWakeSettlementTests,
  registerRestoredSessionReadTests,
  registerRestoredRollbackPublicationTest,
} from "./subagent-registry.restored-settlement.test-support.js";
import {
  makeCompletedCollectorRun,
  makeQueuedRun,
  makeSuspendedDeliveryRun,
} from "./subagent-registry.run-fixtures.test-support.js";
import { resetSubagentRegistrySessionMocks } from "./subagent-registry.session-mocks.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const noop = () => {};

const mocks = await vi.hoisted(async () => {
  const { createSubagentRegistryMockState } =
    await import("./subagent-registry.mock-state.test-support.js");
  return createSubagentRegistryMockState();
});

const loadBrowserMaintenanceSurface = vi.hoisted(() => vi.fn());

vi.mock("../../../plugin-sdk/facade-runtime.js", () => ({
  tryLoadActivatedBundledPluginPublicSurfaceModule: loadBrowserMaintenanceSurface,
}));

vi.mock("../../../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

vi.mock("../../../infra/agent-events.js", () => ({
  getAgentEventLifecycleGeneration: () => mocks.lifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent: (generation: string) =>
    generation === mocks.lifecycleGeneration,
  onAgentEvent: mocks.onAgentEvent,
  registerAgentEventLifecycleRotationHandler: vi.fn(),
}));
// mock-isolation: Registry fixtures control run ownership without the process-global registry.
vi.mock("../../../infra/agent-run-registry.js", () => ({
  getAgentRunContext: mocks.getAgentRunContext,
  listAgentRunsForSession: () => [],
  hasLiveAgentRunContext: mocks.hasLiveAgentRunContext,
}));

vi.mock("../../../config/config.js", () => {
  return {
    getRuntimeConfig: mocks.getRuntimeConfig,
  };
});

vi.mock("../../../config/sessions.js", () => ({
  resolveAgentIdFromSessionKey: mocks.resolveAgentIdFromSessionKey,
  resolveSessionStorePathCore: mocks.resolveStorePath,
}));

vi.mock("../../../config/sessions/session-accessor.js", () => mocks.sessionAccessors);
vi.mock("../../../config/sessions/session-entry-read-runtime.js", { spy: true });
vi.mock("../../../config/sessions/session-delivery-generation.js", { spy: true });
vi.mock("../../../config/sessions/session-accessor.sqlite-replacement-projection.js", () => ({
  applySessionEntryExactReplacements: mocks.applySessionEntryExactReplacements,
}));
vi.mock("../../../config/sessions/session-entry-current-runtime.js", { spy: true });

vi.mock("../../../sessions/session-lifecycle-events.js", () => ({
  emitSessionLifecycleEvent: mocks.emitSessionLifecycleEvent,
  onSessionIdentityMutation: mocks.onSessionIdentityMutation,
  emitSessionIdentityMutation: mocks.emitSessionIdentityMutation,
}));

// mock-isolation: Use test-owned read state while retaining real persistence publications.
vi.mock("./subagent-registry-state.js", async (importOriginal) => {
  const {
    clearSubagentRunsReadCacheForTest,
    consumeFreshSubagentRegistryRows,
    countActiveSubagentRunsForSession,
    getSubagentSessionListRunsSnapshotForSessions,
    prepareSubagentRegistrationRows,
    prepareSubagentSessionListReadCache,
    publishSubagentRunsAfterAtomicStore,
    rememberRestoredSubagentRunNotification,
  } = await importOriginal<typeof import("./subagent-registry-state.js")>();
  return {
    clearSubagentRunsReadCacheForTest,
    consumeFreshSubagentRegistryRows,
    countActiveSubagentRunsForSession,
    getSubagentSessionListRunsSnapshotForSessions,
    prepareSubagentRegistrationRows,
    prepareSubagentSessionListReadCache,
    rememberRestoredSubagentRunNotification,
    getSubagentRunsSnapshotForChildSession: mocks.getSubagentRunsSnapshotForChildSession,
    getSubagentRunsSnapshotForRead: mocks.getSubagentRunsSnapshotForRead,
    ...(await import("../../subagent-test-fixtures.test-helpers.js")).createSubagentStateMock(
      publishSubagentRunsAfterAtomicStore,
    ),
  };
});

vi.mock("./subagent-registry-persistence.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./subagent-registry-persistence.js")>();
  return {
    ...original,
    restoreSubagentRunsFromDisk: async (...args) => {
      const restored = await mocks.restoreSubagentRunsFromDisk(...args);
      publishSubagentRunChanges(undefined, undefined, "persistence");
      return restored;
    },
  } satisfies typeof original;
});

vi.mock("../announce/subagent-announce.js", () => ({
  captureSubagentCompletionReply: mocks.captureSubagentCompletionReply,
  runSubagentAnnounceFlow: mocks.runSubagentAnnounceFlow,
}));

vi.mock("../../../browser-lifecycle-cleanup.js", { spy: true });
// Manual mocks can bypass concurrent lazy imports in Vitest; warm the autospy once.
vi.mock("../announce/subagent-announce.requester-settle-wake.js", { spy: true });
const wakeRequester = vi.mocked(maybeWakeRequesterAfterAllChildrenSettled);
// mock-isolation: Lifecycle fixtures supply their own registries without loading installed plugins.
vi.mock("../../runtime-plugins.js", () => import("../../runtime-plugins.test-support.js"));

vi.mock("../../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: mocks.getGlobalHookRunner,
}));

vi.mock("../../../context-engine/init.js", () => ({
  ensureContextEnginesInitialized: mocks.ensureContextEnginesInitialized,
}));

vi.mock("../../../context-engine/registry.js", () => ({
  resolveContextEngine: mocks.resolveContextEngine,
}));

vi.mock("../../timeout.js", () => ({
  resolveAgentTimeoutMs: mocks.resolveAgentTimeoutMs,
}));

vi.mock("../../internal-session-effects.js", () => ({
  removeInternalSessionEffectsSession: mocks.removeInternalSessionEffectsSession,
}));

describe("subagent registry seam flow", () => {
  let mod: SubagentRegistryHarness;
  let schedulerWork: ReturnType<typeof observeSwarmSchedulerWork>;
  let bindWakeMutation: Awaited<ReturnType<typeof mockRegistryRequesterWakeMutation>>;
  const recoveryRuntime = createMockGatewayRecoveryRuntime({
    dispatchSessionMethod: async <T>(
      method: string,
      params: unknown,
      options?: { timeoutMs?: number },
    ) =>
      (await mocks.callGateway({
        method,
        params: params as Record<string, unknown>,
        timeoutMs: options?.timeoutMs,
      })) as T,
    dispatchAgent: mocks.dispatchRecoveryAgent as GatewayRecoveryRuntime["dispatchAgent"],
    waitForAgent: (params, timeoutMs) =>
      mocks.callGateway({
        method: "agent.wait",
        params: params as unknown as Record<string, unknown>,
        timeoutMs,
      }) as never,
  });
  const activateRegistry = () => activateSubagentRegistryWithRecoveryRuntime(mod, recoveryRuntime);
  const hydrateAndActivateRegistry = async () => {
    await mod.initSubagentRegistry();
    await activateRegistry();
  };
  const findRequesterRun = (runId: string, requesterSessionKey = "agent:main:main") =>
    mod.listSubagentRunsForRequester(requesterSessionKey).find((entry) => entry.runId === runId);
  const expectUnsettled = (run: SubagentRunRecord | undefined) => {
    expect(run?.execution.endedAt).toBeUndefined();
    expect(run?.execution.outcome).toBeUndefined();
  };
  const agentCalls = () =>
    mocks.callGateway.mock.calls.filter(([request]) => request.method === "agent");
  const sessionEntries = (entries: Record<string, [string, string]>, updatedAt = Date.now()) =>
    Object.fromEntries(
      Object.entries(entries).map(([key, [sessionId, lifecycleRevision]]) => [
        key,
        { sessionId, lifecycleRevision, updatedAt },
      ]),
    );
  const mockAgentWait = (
    response:
      | Record<string, unknown>
      | Promise<Record<string, unknown>>
      | Error
      | ((request: Parameters<typeof mocks.callGateway>[0]) => Record<string, unknown>),
  ) => mockGatewayMethods(mocks.callGateway, { "agent.wait": response });
  const mockPendingAgentWait = () => mockAgentWait({ status: "pending" });
  const mockEndedHooks = (runSubagentEnded = mocks.runSubagentEnded) =>
    mocks.getGlobalHookRunner.mockReturnValue({
      hasHooks: (hookName: string) => hookName === "subagent_ended",
      runSubagentEnded,
    } as never);
  const mockSingleCollectorConcurrency = () => {
    mocks.getRuntimeConfig.mockReturnValue({
      tools: { swarm: { enabled: true, maxConcurrent: 1 } },
      agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
      session: { mainKey: "main", scope: "per-sender" as const, store: mocks.resolveStorePath() },
    });
    setRuntimeConfigSnapshot(mocks.getRuntimeConfig());
  };
  const getLifecycleHandler = () => {
    const handler = expectDefined(mocks.onAgentEvent.mock.calls.at(-1)?.[0], "lifecycle handler");
    return (
      event: Pick<AgentEventPayload, "runId" | "stream" | "data"> & Partial<AgentEventPayload>,
    ) => handler({ seq: 1, ts: Date.now(), ...event });
  };
  const emitLifecycle = (runId: string, data: AgentEventPayload["data"]) =>
    getLifecycleHandler()({ runId, stream: "lifecycle", data });

  function holdChildExecution(runId: string, sessionKey: string, sessionId: string) {
    const operation = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
      target: captureSessionTarget({
        storeScope: mocks.resolveStorePath(),
        sessionKey,
        incarnation: sessionId,
      }),
    });
    operation.setPhase("running");
    operation.attachBackend({ kind: "embedded", runId, cancel: noop });
    return { operation, releaseExecution: operation.retainExecution() };
  }

  async function settleLifecycle(event: Parameters<ReturnType<typeof getLifecycleHandler>>[0]) {
    const settleRootWork = observeRootWork();
    try {
      getLifecycleHandler()(event);
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      await settleRootWork();
    }
  }

  beforeAll(async () => {
    const registry = await import("./subagent-registry.test-helpers.js");
    mod = {
      ...registry,
      registerSubagentRun: (params) => {
        const registration = createSubagentRunParams(params);
        const sessionEntry = mocks.entries[registration.childSessionKey];
        if (sessionEntry && !Object.hasOwn(params, "sessionEntry")) {
          registration.sessionEntry = sessionEntry;
        }
        return registry.registerSubagentRun(registration);
      },
    };
  });

  beforeEach(async () => {
    schedulerWork = observeSwarmSchedulerWork();
    resetGatewayWorkAdmission();
    vi.clearAllMocks();
    mocks.callGateway.mockReset();
    mocks.captureSubagentCompletionReply.mockReset().mockResolvedValue("final completion reply");
    mocks.cleanupBrowserSessionsForLifecycleEnd.mockReset().mockResolvedValue(undefined);
    loadBrowserMaintenanceSurface.mockReset().mockResolvedValue(null);
    vi.mocked(cleanupBrowserSessionsForLifecycleEnd).mockImplementation(
      mocks.cleanupBrowserSessionsForLifecycleEnd,
    );
    mocks.persistRegistryRows.mockReset();
    await configureMockSubagentRegistryPersistence(mocks);
    mocks.restoreSubagentRunsFromDisk.mockReset().mockResolvedValue(0);
    mocks.loadSessionEntry.mockReset();
    resetSubagentRegistrySessionMocks(mocks);
    mocks.listSessionEntriesCore.mockReset();
    mocks.patchSessionEntryCore.mockReset();
    mocks.readSessionCurrent.mockReset();
    mocks.applySessionEntryExactReplacements.mockReset();
    mocks.runSubagentAnnounceFlow.mockReset().mockResolvedValue("delivered");
    wakeRequester.mockReset().mockImplementation(async (params) => {
      bindWakeMutation([params.settledEntry]);
      await params.completeBatch([params.settledEntry]);
      return false;
    });
    // SQLite worker deadlines share the native monotonic clock across threads.
    vi.useFakeTimers({ toNotFake: ["hrtime", "performance"] });
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));
    mocks.lifecycleGeneration = "test-generation";
    mocks.onAgentEvent.mockReturnValue(noop);
    mocks.getAgentRunContext.mockReturnValue(undefined);
    mocks.resolveStorePath.mockReturnValue("/tmp/test-session-store.json");
    mocks.getRuntimeConfig.mockReturnValue({
      agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
      session: { mainKey: "main", scope: "per-sender" as const, store: mocks.resolveStorePath() },
    });
    setRuntimeConfigSnapshot(mocks.getRuntimeConfig());
    mocks.resolveAgentIdFromSessionKey.mockImplementation((sessionKey: string) => {
      return sessionKey.match(/^agent:([^:]+)/)?.[1] ?? "main";
    });
    mocks.entries = {
      "agent:main:main": createSessionEntry({
        sessionId: "sess-requester",
        lifecycleRevision: "revision-requester",
      }),
      "agent:main:subagent:child": createSessionEntry({ lifecycleRevision: "revision-child" }),
    };
    mocks.getGlobalHookRunner.mockReturnValue(null);
    mocks.resolveContextEngine.mockResolvedValue({
      onSubagentEnded: mocks.onSubagentEnded,
    });
    const pluginRegistry = createEmptyPluginRegistry();
    mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(pluginRegistry);
    mocks.runSubagentEnded.mockImplementation(async () => {
      expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(pluginRegistry);
    });
    mocks.dispatchRecoveryAgent.mockReset();
    mocks.resolveAgentTimeoutMs.mockReturnValue(1_000);
    mocks.getSubagentRunsSnapshotForChildSession
      .mockReset()
      .mockImplementation((runs) => new Map(runs));
    mockAgentWait({
      status: "ok",
      startedAt: 111,
      endedAt: 222,
    });
    mocks.dispatchRecoveryAgent.mockImplementation(async (params, timeoutMs, options) =>
      mocks.callGateway({
        method: "agent",
        params: params as unknown as Record<string, unknown>,
        timeoutMs,
        ...(options?.scopes ? { scopes: options.scopes } : {}),
      }),
    );
    await mod.resetSubagentRegistryForTests({ persist: false });
    bindWakeMutation = await mockRegistryRequesterWakeMutation();
  });

  afterEach(async () => {
    await schedulerWork.close();
    resetGatewayWorkAdmission();
    vi.mocked(cleanupBrowserSessionsForLifecycleEnd).mockReset();
    await mod.resetSubagentRegistryForTests({ persist: false });
    clearRuntimeConfigSnapshot();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  registerCollectorArchiveTests({ getRegistry: () => mod, mocks });

  it("keeps collector groups while any member owes failed-launch cleanup", async () => {
    const now = Date.now();
    mocks.entries = sessionEntries({
      "agent:main:subagent:collector-clean": [
        "session-collector-clean",
        "revision-collector-clean",
      ],
      "agent:main:subagent:collector-cleanup-pending": [
        "session-collector-cleanup-pending",
        "revision-collector-cleanup-pending",
      ],
    });
    await mod.addSubagentRunForTests(
      makeCompletedCollectorRun({
        runId: "run-collector-clean",
        childSessionKey: "agent:main:subagent:collector-clean",
        childSessionIdentity: {
          sessionId: "session-collector-clean",
          lifecycleRevision: "revision-collector-clean",
        },
        createdAt: now - 10_000,
        endedAt: now - 5_000,
        archiveAtMs: now - 1,
        groupId: "swarm:cleanup-pending",
      }),
    );
    await mod.addSubagentRunForTests({
      runId: "run-collector-cleanup-pending",
      childSessionKey: "agent:main:subagent:collector-cleanup-pending",
      childSessionIdentity: {
        sessionId: "session-collector-cleanup-pending",
        lifecycleRevision: "revision-collector-cleanup-pending",
      },
      createdAt: now - 9_000,
      endedAt: now - 4_000,
      archiveAtMs: now - 1,
      collect: true,
      groupId: "swarm:cleanup-pending",
      collectorLaunchCleanupPending: true,
      collectorCompletion: { status: "failed" },
    });
    mocks.callGateway.mockRejectedValueOnce(new Error("delete unavailable"));

    await mod.testing.sweepOnceForTests();

    expect(mod.getSubagentRunByRunId("run-collector-clean")).toBeDefined();
    expect(mod.getSubagentRunByRunId("run-collector-cleanup-pending")).toMatchObject({
      collectorLaunchCleanupPending: true,
    });
  });

  it("snapshots ordinary parent-chain wait ownership when registering a collector", async () => {
    const parentSessionKey = "agent:main:subagent:collector-parent";
    await mod.addSubagentRunForTests({
      runId: "run-ordinary-parent",
      childSessionKey: parentSessionKey,
      childSessionIdentity: { sessionId: "sess-collector-parent" },
      createdAt: Date.now(),
      expectsCompletionMessage: true,
    });
    await mod.registerSubagentRun({
      runId: "run-collector-descendant",
      childSessionKey: "agent:main:subagent:collector-descendant",
      sessionEntry: { sessionId: "sess-collector-descendant" },
      controllerSessionKey: parentSessionKey,
      requesterSessionKey: parentSessionKey,
      requesterDisplayKey: "parent",
      expectsCompletionMessage: false,
      collect: true,
      swarmRequesterSessionKey: parentSessionKey,
      groupId: "swarm:descendant",
      queued: true,
    });

    expect(mod.getSubagentRunByRunId("run-collector-descendant")).toMatchObject({
      swarmWaitOwnerSessionKeys: [parentSessionKey, "agent:main:main"],
    });
  });

  registerSubagentResultRefreshCases({ getRegistry: () => mod, getLifecycleHandler, mocks });

  registerRestartDrainCompletionSettlementTest({ getRegistry: () => mod, mocks, findRequesterRun });

  registerQueuedCollectorLaunchSettlementTest({ getRegistry: () => mod, mocks });

  it("records early structured output through the child session identity", async () => {
    const childSessionKey = "agent:main:subagent:early-structured-output";
    await mod.addSubagentRunForTests({
      runId: "public-collector-run",
      childSessionKey,
      childSessionIdentity: { sessionId: "sess-early-structured-output" },
      createdAt: Date.now(),
      collect: true,
      execution: { status: "queued" },
    });

    await mod.recordSwarmStructuredOutput(
      { runId: "gateway-run-not-yet-remapped", childSessionKey },
      { invalidAttempts: 0, structured: { answer: 42 } },
    );

    expect(mod.getSubagentRunByRunId("public-collector-run")?.structuredOutput).toEqual({
      invalidAttempts: 0,
      structured: { answer: 42 },
    });
  });

  it("admits a restored pause notice and retires a revoked wake without completing the child", async () => {
    const runId = "run-restored-pause";
    const restored = createSubagentRunRecord({
      runId,
      childSessionIdentity: {
        sessionId: "sess-child",
        lifecycleRevision: "revision-child",
      },
      createdAt: Date.now() - 2_000,
      endedAt: Date.now() - 1_000,
      pauseReason: "sessions_yield",
      expectsCompletionMessage: true,
      completion: { required: true },
      delivery: { status: "pending" },
      requesterSettleWake: {
        status: "pending",
        attemptCount: 0,
        batchRunIds: [runId],
        requesterYieldBatch: true,
        rearmGeneration: 1,
        pauseNotice: { acknowledgment: "RESTORED-PAUSE" },
      },
    });
    mocks.mockRestoredRuns(() => [restored]);
    wakeRequester.mockImplementation(async (params) => {
      bindWakeMutation([params.settledEntry]);
      await params.completeBatch([params.settledEntry], 1);
      return true;
    });
    const settleRootWork = observeRootWork();
    try {
      await hydrateAndActivateRegistry();
    } finally {
      await settleRootWork();
    }
    expect(wakeRequester).toHaveBeenCalledOnce();
    expect(findRequesterRun(runId)).toMatchObject({
      pauseReason: "sessions_yield",
      delivery: { status: "pending" },
    });
    expect(findRequesterRun(runId)?.requesterSettleWake).toBeUndefined();
    expect(findRequesterRun(runId)?.execution.outcome).toBeUndefined();
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
  });

  it("reconciles a partial merge on the next explicit restore", async () => {
    const runId = "run-restore-retry";
    const restored = createSubagentRunRecord({
      runId,
      childSessionIdentity: {
        sessionId: "sess-child",
        lifecycleRevision: "revision-child",
      },
      pauseReason: "sessions_yield",
      createdAt: Date.now(),
    });
    mocks.restoreSubagentRunsFromDisk
      .mockImplementationOnce((async (params: { runs: Map<string, SubagentRunRecord> }) => {
        params.runs.set(runId, restored);
        throw new Error("transient sqlite read failure");
      }) as never)
      .mockResolvedValue(0);

    await hydrateAndActivateRegistry();
    expect(mocks.restoreSubagentRunsFromDisk).toHaveBeenCalledOnce();
    expect(mocks.onAgentEvent).not.toHaveBeenCalled();

    await hydrateAndActivateRegistry();

    expect(mocks.restoreSubagentRunsFromDisk).toHaveBeenCalledTimes(2);
    expect(mod.getSubagentRunByRunId(runId)?.runId).toBe(runId);
    expect(mocks.onAgentEvent).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);

    await mod.initSubagentRegistry();
    expect(mocks.restoreSubagentRunsFromDisk).toHaveBeenCalledTimes(2);
  });

  registerRestoredSessionReadTests({ mocks, hydrateAndActivateRegistry, mockPendingAgentWait });

  registerRestoredLegacyAuthorityTests({
    getRegistry: () => mod,
    mocks,
    hydrateAndActivateRegistry,
    mockRestoredRuns: mocks.mockRestoredRuns,
  });

  it("does not double-run reentrant registry restore calls", async () => {
    let reentrantRestore: ReturnType<typeof mod.initSubagentRegistry> | undefined;
    mocks.restoreSubagentRunsFromDisk.mockImplementation(async () => {
      reentrantRestore = mod.initSubagentRegistry();
      return 0;
    });

    await mod.initSubagentRegistry();
    await reentrantRestore;

    expect(mocks.restoreSubagentRunsFromDisk).toHaveBeenCalledOnce();
  });

  registerRestoredRequesterWakeSettlementTests({
    getRegistry: () => mod,
    mocks,
    wakeRequester,
    bindWakeMutation: (entries) => bindWakeMutation(entries),
    activateRegistry,
    recoveryRuntime,
  });

  it("does not relaunch a restored queued collector with durable kill intent", async () => {
    const now = Date.now();
    mocks.mockRestoredRuns(() => [
      makeQueuedRun({
        runId: "run-queued-kill-intent",
        childSessionKey: "agent:main:subagent:queued-kill-intent",
        childSessionIdentity: { sessionId: "session-queued-kill-intent" },
        groupId: "kill-intent",
        createdAt: now,
        killIntent: {
          requestedAt: now + 1,
          reason: "killed",
          sessionId: "session-queued-kill-intent",
        },
      }),
    ]);

    await hydrateAndActivateRegistry();
    await Promise.resolve();
    await Promise.resolve();

    expect(agentCalls()).toEqual([]);
  });

  it("rehydrates persisted collector FIFO queues after a running owner releases capacity", async () => {
    const now = Date.now();
    mockSingleCollectorConcurrency();
    const queuedRunOverrides = {
      groupId: "logical-group",
      queuedLaunch: {
        authorization: { modelOverride: { provider: "openai", model: "gpt-5.4" } },
        maxConcurrent: 2,
      },
    };
    mocks.mockRestoredRuns(() => [
      createSubagentRunRecord({
        runId: "run-active",
        childSessionKey: "agent:main:subagent:run-active",
        childSessionIdentity: {
          sessionId: "session-active",
          lifecycleRevision: "revision-active",
        },
        groupId: "logical-group",
        collect: true,
        schedulerSlotId: "slot-active",
        createdAt: now - 1_000,
        execution: { status: "running", startedAt: now - 1_000 },
      }),
      makeQueuedRun({
        ...queuedRunOverrides,
        runId: "run-queued-one",
        childSessionIdentity: { sessionId: "session-one", lifecycleRevision: "revision-one" },
        createdAt: now,
      }),
      makeQueuedRun({
        ...queuedRunOverrides,
        runId: "run-queued-two",
        childSessionIdentity: { sessionId: "session-two", lifecycleRevision: "revision-two" },
        createdAt: now + 1,
      }),
    ]);
    mocks.entries = sessionEntries({
      "agent:main:subagent:run-active": ["session-active", "revision-active"],
      "agent:main:subagent:run-queued-one": ["session-one", "revision-one"],
      "agent:main:subagent:run-queued-two": ["session-two", "revision-two"],
    });
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent") {
        return { runId: "gateway-run-one" };
      }
      return request.method === "agent.wait" ? { status: "pending" } : {};
    });

    await hydrateAndActivateRegistry();
    await Promise.resolve();
    expect(agentCalls()).toEqual([]);

    expect(releaseSwarmRun("slot-active")).toBe(true);
    await waitForFast(() => {
      const calls = agentCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[0]).toMatchObject({
        params: {
          idempotencyKey: "run-queued-one",
          provider: "openai",
          model: "gpt-5.4",
        },
        scopes: ["operator.admin"],
      });
      expect(mod.getSubagentRunByRunId("run-queued-one")?.execution?.status).toBe("running");
    });
    const acceptedRun = mod.getSubagentRunByRunId("gateway-run-one");
    expect(acceptedRun).toMatchObject({
      runId: "gateway-run-one",
      swarmRunId: "run-queued-one",
      schedulerSlotId: "run-queued-one",
      execution: { status: "running" },
    });
    expect(acceptedRun).not.toHaveProperty("startedAt");
    expect(acceptedRun?.sessionStartedAt).toBeUndefined();
    expect(acceptedRun?.execution.startedAt).toBeUndefined();
    expect(mod.getSubagentRunByRunId("run-queued-two")?.execution?.status).toBe("queued");
  });

  it.each(["started", "retired", "terminal pending", "terminal stale"] as const)(
    "accepts a collector response only for its current launch: %s",
    async (state) => {
      const runId = "run-acceptance";
      const gatewayRunId = "gateway-acceptance";
      const childSessionKey = "agent:main:subagent:acceptance";
      const startedAt = 12_345;
      if (state === "started" || state === "retired") {
        await mod.registerSubagentRun({
          runId,
          childSessionKey,
          collect: true,
          groupId: "acceptance-race",
          queued: true,
          expectsCompletionMessage: false,
        });
        if (state === "started") {
          const lifecycleHandler = getLifecycleHandler();
          lifecycleHandler({
            runId,
            seq: 1,
            stream: "lifecycle",
            ts: startedAt,
            data: { phase: "start", startedAt },
          });
          await waitForFast(() =>
            expect(mod.getSubagentRunByRunId(runId)?.execution.startedAt).toBe(startedAt),
          );
        }
      } else {
        await mod.addSubagentRunForTests(
          makeCompletedCollectorRun({
            runId,
            childSessionKey,
            swarmRunId: runId,
            schedulerSlotId: runId,
            ...(state === "terminal pending"
              ? {
                  swarmLaunchPending: false,
                  queuedLaunch: {
                    request: { sessionKey: childSessionKey },
                    timeoutMs: 1_000,
                    schedulerGroupKey: "acceptance-race",
                    maxConcurrent: 1,
                  },
                }
              : {}),
            groupId: "acceptance-race",
            createdAt: 1_000,
            endedAt: 2_000,
            execution: { status: "terminal", endedAt: 2_000 },
            completion: { required: false, resultText: "done", capturedAt: 2_000 },
          }),
        );
      }
      expect(
        await mod.startQueuedSubagentRun(
          runId,
          gatewayRunId,
          state === "retired" ? "retired-generation" : undefined,
        ),
      ).toBe(state === "started" || state === "terminal pending");
      const remapped = mod.getSubagentRunByRunId(gatewayRunId);
      if (state === "started") {
        expect(remapped).toMatchObject({
          sessionStartedAt: startedAt,
          execution: { status: "running", acceptedAt: expect.any(Number), startedAt },
        });
      } else if (state === "terminal pending") {
        expect(mod.getSubagentRunByRunId(runId)).toBe(remapped);
        expect(remapped).toMatchObject({
          runId: gatewayRunId,
          swarmRunId: runId,
          collectorCompletion: { status: "done" },
          swarmLaunchPending: false,
        });
      } else {
        expect(remapped).toBeUndefined();
        expect(mod.getSubagentRunByRunId(runId)).toMatchObject(
          state === "retired"
            ? { execution: { status: "queued" } }
            : { runId, collectorCompletion: { status: "done" } },
        );
      }
    },
  );

  registerRestoredRollbackPublicationTest({
    mocks,
    hydrateAndActivateRegistry,
    mockSingleCollectorConcurrency,
    mockRestoredRuns: mocks.mockRestoredRuns,
  });

  it("settles restored collector session cleanup before announcing deletion", async () => {
    const now = Date.now();
    mocks.mockRestoredRuns(() => [
      makeQueuedRun({
        runId: "run-queued-cleanup-retry",
        childSessionKey: "agent:main:subagent:queued-cleanup-retry",
        childSessionIdentity: {
          sessionId: "queued-cleanup-retry",
          lifecycleRevision: "revision-queued-cleanup-retry",
        },
        swarmRequesterSessionKey: "agent:main:main",
        groupId: "restore-cleanup-retry",
        createdAt: now,
        queuedLaunch: {
          request: { sessionKey: "agent:main:subagent:queued-cleanup-retry" },
        },
      }),
    ]);
    mocks.entries = sessionEntries({
      "agent:main:subagent:queued-cleanup-retry": [
        "queued-cleanup-retry",
        "revision-queued-cleanup-retry",
      ],
    });
    let deleteAttempts = 0;
    let releaseDelete: (() => void) | undefined;
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent") {
        throw new Error("launch failed");
      }
      if (request.method === "sessions.delete") {
        deleteAttempts += 1;
        return await new Promise<Record<string, unknown>>((resolve) => {
          releaseDelete = () => resolve({});
        });
      }
      return {};
    });

    await hydrateAndActivateRegistry();

    await waitForFast(() =>
      expect(mod.getSubagentRunByRunId("run-queued-cleanup-retry")).toMatchObject({
        execution: { status: "queued" },
      }),
    );
    await waitForFast(() => expect(releaseDelete).toBeTypeOf("function"));
    expect(deleteAttempts).toBe(1);
    expect(mocks.emitSessionLifecycleEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:subagent:queued-cleanup-retry",
        reason: "delete",
      }),
    );
    expect(mocks.onSubagentEnded).not.toHaveBeenCalled();
    expect(
      mod.getSubagentRunByRunId("run-queued-cleanup-retry")?.collectorCompletion,
    ).toBeUndefined();

    releaseDelete?.();
    await waitForFast(() =>
      expect(mod.getSubagentRunByRunId("run-queued-cleanup-retry")).toMatchObject({
        execution: { status: "terminal" },
        collectorCompletion: { status: "failed" },
      }),
    );
    await waitForFast(() =>
      expect(mocks.emitSessionLifecycleEvent).toHaveBeenCalledWith({
        sessionKey: "agent:main:subagent:queued-cleanup-retry",
        reason: "delete",
        parentSessionKey: "agent:main:main",
      }),
    );
    await waitForFast(() =>
      expect(mocks.onSubagentEnded).toHaveBeenCalledWith(
        expect.objectContaining({
          childSessionKey: "agent:main:subagent:queued-cleanup-retry",
          reason: "deleted",
        }),
      ),
    );
  });

  it("keeps runs active instead of terminally failing on recoverable wait transport errors", async () => {
    mockAgentWait(new Error("gateway closed (1006): transport close"));

    await mod.registerSubagentRun({
      runId: "run-interrupted-wait",
    });

    await waitForFast(() => expect(findRequesterRun("run-interrupted-wait")).toBeDefined());
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expectUnsettled(findRequesterRun("run-interrupted-wait"));
  });

  it("keeps a running child owed to recovery when its closing Gateway refuses the wait", async () => {
    const runId = "run-restart-cancelled-wait";
    let waits = 0;
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method !== "agent.wait") {
        return {};
      }
      waits += 1;
      if (waits > 1) {
        return { status: "pending" };
      }
      markGatewayRestartDraining("stop (SIGTERM)");
      throw new GatewayDispatchUnavailableError("agent.wait", false);
    });
    // The spawning turn retains admission while its child's observer is cancelled.
    const spawnTurn = createDeferred();
    const spawn = runWithGatewayIndependentRootWorkAdmission(async () => {
      await mod.registerSubagentRun({
        runId,
        expectsCompletionMessage: true,
      });
      await spawnTurn.promise;
    }, "sessions_spawn");
    try {
      await waitForFast(() =>
        expect(waits > 1 || findRequesterRun(runId)?.execution.endedAt !== undefined).toBe(true),
      );
    } finally {
      spawnTurn.resolve();
      await spawn;
    }

    const run = findRequesterRun(runId);
    expect(run).toMatchObject({ execution: { status: "running" }, cleanupHandled: false });
    expectUnsettled(run);
    expect(run?.endedReason).toBeUndefined();
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
  });

  it("detaches subagent completion from a disposed requester transcript owner", async (context) => {
    const sessionKey = "agent:main:main";
    const activeGatewayContext = { recoveryRuntime } as never;
    await mod.activateSubagentRegistry(
      () =>
        ({
          recoveryRuntime,
          resolveGatewayContext: () => activeGatewayContext,
        }) as never,
    ).settled;
    let disposed = false;
    const pendingWait = createDeferred<Record<string, unknown>>();
    const waitStarted = createDeferred();
    const announceStarted = createDeferred();
    const { requesterTranscriptWrite, withRequesterTranscriptWrite } =
      createRequesterTranscriptWriter(() => disposed);
    const freshTranscriptWrite = vi.fn(async () => {});
    const freshCompletionWrite = vi.fn(async () => {});

    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method !== "agent.wait") {
        return {};
      }
      waitStarted.resolve();
      const result = await pendingWait.promise;
      await runWithOwnedSessionTranscriptWrite({ sessionKey }, freshCompletionWrite);
      return result;
    });
    mocks.runSubagentAnnounceFlow.mockImplementation(async () => {
      announceStarted.resolve();
      await runWithOwnedSessionTranscriptWrite({ sessionKey }, freshTranscriptWrite);
      return "delivered";
    });

    const settleRootWork = observeRootWork();
    try {
      await withOwnedSessionTranscriptWrites(
        { sessionKey, withTranscriptWrite: withRequesterTranscriptWrite },
        async () => {
          await mod.registerSubagentRun({
            runId: "run-detached-requester-owner",
            requesterSessionKey: sessionKey,
            expectsCompletionMessage: true,
          });
          await withinTest(waitStarted.promise, context.signal);
        },
      );

      disposed = true;
      pendingWait.resolve({ status: "ok", startedAt: 111, endedAt: 222 });
      await withinTest(announceStarted.promise, context.signal);
    } finally {
      disposed = true;
      pendingWait.resolve({ status: "ok", startedAt: 111, endedAt: 222 });
      await settleRootWork();
    }

    expect(findRequesterRun("run-detached-requester-owner")?.execution.status).toBe("terminal");
    expect(freshTranscriptWrite).toHaveBeenCalledOnce();
    expect(freshCompletionWrite).toHaveBeenCalledOnce();
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledOnce();
    const announceParams = (
      mocks.runSubagentAnnounceFlow.mock.calls as unknown as Array<
        [{ resolveGatewayContext?: () => unknown }]
      >
    )[0]?.[0];
    expect(announceParams?.resolveGatewayContext?.()).toBe(activeGatewayContext);
    expect(requesterTranscriptWrite).not.toHaveBeenCalled();
  });

  it("keeps published timeout stable when pre-deadline success arrives late", async () => {
    const runId = "run-timeout-late-lifecycle-predeadline-ok";
    const startedAt = Date.now();
    mockAgentWait({ status: "timeout" });
    mocks.entries = {
      "agent:main:subagent:child": createSessionEntry({
        updatedAt: startedAt,
        status: undefined,
      }),
    };
    const settleRootWork = observeRootWork();
    await mod.registerSubagentRun({
      runId,
      runTimeoutSeconds: 1,
    });

    await waitForFast(() =>
      expect(mocks.callGateway).toHaveBeenCalledWith(
        expect.objectContaining({ method: "agent.wait" }),
      ),
    );
    expectUnsettled(findRequesterRun(runId));

    await vi.advanceTimersByTimeAsync(5_000);
    await waitForFast(() => {
      expect(findRequesterRun(runId)).toMatchObject({
        execution: {
          status: "terminal",
          endedAt: startedAt + 1_000,
          outcome: {
            status: "timeout",
            startedAt,
            endedAt: startedAt + 1_000,
            elapsedMs: 1_000,
          },
        },
      });
    });
    await settleRootWork();
    expect(mocks.captureSubagentCompletionReply).toHaveBeenCalledTimes(1);
    expect(
      mocks.callGateway.mock.calls.filter(([request]) => request.method === "agent.wait").length,
    ).toBeGreaterThanOrEqual(2);
    emitLifecycle(runId, { phase: "end", startedAt: startedAt + 10, endedAt: startedAt + 500 });
    await waitForFast(() => {
      const run = findRequesterRun(runId);
      expect(run?.execution.endedAt).toBe(startedAt + 1_000);
      expect(run?.execution.outcome).toEqual(
        expect.objectContaining({
          status: "timeout",
          startedAt,
          endedAt: startedAt + 1_000,
          elapsedMs: 1_000,
        }),
      );
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    });
    expect(mocks.captureSubagentCompletionReply).toHaveBeenCalledTimes(1);
  });

  it("refreshes unpublished timeout delivery payloads after lifecycle correction", async () => {
    const createdAt = Date.parse("2026-03-24T11:59:00Z");
    mockPendingAgentWait();
    mocks.runSubagentAnnounceFlow.mockResolvedValueOnce("retryable");
    await mod.registerSubagentRun({
      runId: "run-refresh-pending-timeout-payload",
      task: "pending timeout payload should refresh",
      runTimeoutSeconds: 60,
    });
    await updateFixtureRun("run-refresh-pending-timeout-payload", (next) =>
      Object.assign(next, {
        createdAt,
        sessionStartedAt: createdAt,
        execution: {
          status: "terminal",
          startedAt: createdAt,
          endedAt: createdAt + 60_000,
          outcome: {
            status: "timeout",
            startedAt: createdAt,
            endedAt: createdAt + 60_000,
            elapsedMs: 60_000,
          },
        },
        delivery: {
          status: "pending",
          payload: {
            requesterSessionKey: "agent:main:main",
            childSessionKey: "agent:main:subagent:child",
            childRunId: "run-refresh-pending-timeout-payload",
            task: "pending timeout payload should refresh",
            startedAt: createdAt,
            endedAt: createdAt + 60_000,
            outcome: { status: "timeout" },
          },
        },
      }),
    );

    await settleLifecycle({
      runId: "run-refresh-pending-timeout-payload",
      stream: "lifecycle",
      data: {
        phase: "end",
        startedAt: createdAt + 10_000,
        endedAt: createdAt + 65_000,
      },
    });

    expect(mocks.runSubagentAnnounceFlow).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        childRunId: "run-refresh-pending-timeout-payload",
        outcome: expect.objectContaining({
          status: "ok",
          startedAt: createdAt + 10_000,
          endedAt: createdAt + 65_000,
          elapsedMs: 55_000,
        }),
      }),
    );
  });

  it.each([
    {
      name: "caps lifecycle timeouts to the explicit deadline",
      source: "lifecycle",
      duration: 1_000,
    },
    {
      name: "caps boundary wait timeouts to the explicit deadline",
      source: "boundary wait",
      duration: 1_000,
      waitNow: 999,
    },
    {
      name: "caps restored wait timeouts to the explicit deadline",
      source: "restored wait",
      now: 59_000,
      waitNow: 60_000,
    },
    {
      name: "prefers explicit run timeout over late restored agent.wait success",
      source: "restored success",
      now: 61_000,
    },
    {
      name: "ignores stale session-store start time for fresh terminal completions",
      source: "session",
      waitNow: 61_000,
      sessionStart: -60_000,
      sessionEnd: 30_000,
      expectedStatus: "ok",
      expectedEnd: 30_000,
    },
    {
      name: "applies explicit timeout to terminal session rows without startedAt",
      source: "session",
      waitNow: 61_000,
      sessionEnd: 61_000,
    },
  ])(
    "$name",
    async ({
      source,
      duration = 60_000,
      now = 0,
      waitNow,
      sessionStart,
      sessionEnd,
      expectedStatus = "timeout",
      expectedEnd = duration,
    }) => {
      const runId = "run-explicit-deadline";
      const createdAt = Date.parse(
        source === "session" ? "2026-03-24T12:00:00Z" : "2026-03-24T11:59:00Z",
      );
      vi.setSystemTime(createdAt + now);
      const waitTimeouts: unknown[] = [];
      if (source === "lifecycle") {
        mockPendingAgentWait();
      } else {
        mockAgentWait((request) => {
          waitTimeouts.push(request.params?.timeoutMs);
          if (waitNow !== undefined) {
            vi.setSystemTime(createdAt + waitNow);
          }
          return source === "restored success"
            ? { status: "ok", startedAt: createdAt, endedAt: createdAt + 61_000 }
            : { status: "timeout" };
        });
      }
      if (source === "boundary wait" || source === "session") {
        mocks.entries = {
          "agent:main:subagent:child": createSessionEntry({
            status: source === "session" ? "done" : undefined,
            updatedAt: createdAt + (sessionEnd ?? 0),
            ...(sessionStart === undefined ? {} : { startedAt: createdAt + sessionStart }),
            ...(sessionEnd === undefined ? {} : { endedAt: createdAt + sessionEnd }),
          }),
        };
      }
      const settleRootWork = observeRootWork();
      try {
        if (source.startsWith("restored")) {
          mocks.resolveAgentTimeoutMs.mockReturnValue(60_000);
          const restored = createSubagentRunRecord({
            runId,
            childSessionIdentity: {
              sessionId: "sess-child",
              lifecycleRevision: "revision-child",
            },
            runTimeoutSeconds: duration / 1_000,
            createdAt,
            startedAt: createdAt,
            sessionStartedAt: createdAt,
          });
          await prepareSubagentRecoveryFixture(restored, { entries: mocks.entries });
          mocks.mockRestoredRuns(() => [restored]);
          await hydrateAndActivateRegistry();
        } else {
          await mod.registerSubagentRun({
            runId,
            runTimeoutSeconds: duration / 1_000,
          });
          if (source === "lifecycle") {
            emitLifecycle(runId, {
              phase: "end",
              startedAt: createdAt,
              endedAt: createdAt + 2_000,
              aborted: true,
            });
            await vi.advanceTimersByTimeAsync(30_000);
          }
        }
        await waitForFast(() => {
          expect(findRequesterRun(runId)?.execution).toMatchObject({
            endedAt: createdAt + expectedEnd,
            outcome: {
              status: expectedStatus,
              startedAt: createdAt,
              endedAt: createdAt + expectedEnd,
              elapsedMs: expectedEnd,
            },
          });
        });
      } finally {
        await settleRootWork();
      }
      if (source === "restored wait") {
        expect(waitTimeouts).toEqual([1_000]);
      } else if (source === "boundary wait") {
        expect(waitTimeouts).toHaveLength(1);
      }
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    },
  );

  it("uses running session-store start time for plain wait timeouts", async () => {
    const runId = "run-plain-timeout-session-store-start";
    const createdAt = Date.parse("2026-03-24T11:59:00Z");
    const observedStartedAt = createdAt + 10_000;
    vi.setSystemTime(createdAt);
    let waitAttempts = 0;
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method !== "agent.wait") {
        return {};
      }
      waitAttempts += 1;
      if (waitAttempts === 1) {
        vi.setSystemTime(createdAt + 61_000);
      }
      return { status: "timeout" };
    });
    mocks.entries = {
      "agent:main:subagent:child": createSessionEntry({
        status: undefined,
        updatedAt: createdAt + 61_000,
        startedAt: observedStartedAt,
      }),
    };

    const settleRootWork = observeRootWork();
    await mod.registerSubagentRun({
      runId,
      runTimeoutSeconds: 60,
    });

    await waitForFast(() => {
      const run = findRequesterRun(runId);
      expect(waitAttempts).toBeGreaterThanOrEqual(1);
      expectUnsettled(run);
      expect(run?.execution.startedAt).toBe(observedStartedAt);
    });

    vi.setSystemTime(observedStartedAt + 60_000);
    await vi.advanceTimersByTimeAsync(5_000);

    await waitForFast(() => {
      const run = findRequesterRun(runId);
      expect(run?.execution.endedAt).toBe(observedStartedAt + 60_000);
      expect(run?.execution.outcome).toEqual(
        expect.objectContaining({
          status: "timeout",
          startedAt: observedStartedAt,
          endedAt: observedStartedAt + 60_000,
          elapsedMs: 60_000,
        }),
      );
    });
    await settleRootWork();
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
  });

  it("ignores stale terminal session-store rows from older child runs", async () => {
    let waitAttempts = 0;
    const secondWait = createDeferred<{ status: "ok"; startedAt: number; endedAt: number }>();
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        waitAttempts += 1;
        if (waitAttempts === 1) {
          return { status: "timeout" };
        }
        return secondWait.promise;
      }
      return {};
    });
    const staleEndedAt = Date.parse("2026-03-24T11:59:00Z");
    mocks.entries = {
      "agent:main:subagent:child": createSessionEntry({
        updatedAt: staleEndedAt,
        status: "done",
        startedAt: staleEndedAt - 100,
        endedAt: staleEndedAt,
      }),
    };

    await mod.registerSubagentRun({
      runId: "run-reactivated-timeout",
    });

    await waitForFast(() => {
      expect(waitAttempts).toBeGreaterThanOrEqual(2);
    });
    expectUnsettled(findRequesterRun("run-reactivated-timeout"));
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();

    secondWait.resolve({
      status: "ok",
      startedAt: Date.parse("2026-03-24T12:00:01Z"),
      endedAt: Date.parse("2026-03-24T12:00:02Z"),
    });
    await waitForFast(() => {
      const completedRun = findRequesterRun("run-reactivated-timeout");
      expect(completedRun?.execution.outcome).toEqual(expect.objectContaining({ status: "ok" }));
    });
  });

  it("settles an aborted collector yield through agent.wait without canceling it", async () => {
    const runId = "run-wait-collector-yield";
    const terminalPersisted = createDeferred();
    mocks.persistRegistryRows.mockImplementation((runs, ids) => {
      if (ids?.includes(runId) && runs.get(runId)?.execution.status === "terminal") {
        terminalPersisted.resolve();
      }
    });
    mockAgentWait({
      status: "ok",
      startedAt: 111,
      endedAt: 222,
      livenessState: "paused",
      yielded: true,
      stopReason: "aborted",
    });

    const settleRootWork = observeRootWork();
    try {
      await mod.registerSubagentRun({
        runId,
        childSessionKey: "agent:main:subagent:wait-collector-yield",
        sessionEntry: { sessionId: "sess-wait-collector-yield" },
        expectsCompletionMessage: false,
        collect: true,
        outputSchema: { type: "object" },
        swarmRequesterSessionKey: "agent:main:main",
      });
      await terminalPersisted.promise;
    } finally {
      // Run the zero-delay wait continuation before draining owned root work.
      await vi.advanceTimersByTimeAsync(0);
      await settleRootWork();
    }

    await waitForFast(() => {
      expect(findRequesterRun(runId)).toMatchObject({
        execution: { status: "terminal", endedAt: 222, outcome: { status: "ok" } },
        endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
        collectorCompletion: {
          status: "failed",
          schemaError: "structured_output was not called",
        },
      });
    });
    // A yield terminal can also look aborted (#92448); settling it must never
    // turn the collector yield into a cancellation notice.
    expect(findRequesterRun(runId)?.pauseReason).toBeUndefined();
  });

  registerForcedCollectorCompletionSettlementTests({
    getRegistry: () => mod,
    mocks,
    findRequesterRun,
    getLifecycleHandler,
    mockPendingAgentWait,
  });

  it.each([
    { observation: "lifecycle", kind: "outer-timeout" },
    { observation: "wait", kind: "blocked" },
  ])(
    "preserves $kind alongside forced collector yield through $observation",
    async ({ observation, kind }) => {
      const runId = `forced-yield-${observation}-${kind}`;
      const childSessionKey = `agent:main:subagent:${runId}`;
      const terminal = {
        startedAt: 111,
        endedAt: 222,
        yielded: true,
        ...(kind === "blocked"
          ? { status: "error", livenessState: "blocked", error: "blocked execution" }
          : { status: "ok", aborted: true, stopReason: "timeout", livenessState: "paused" }),
      };
      const waitResult = createDeferred<Record<string, unknown>>();
      if (observation === "wait") {
        mocks.callGateway.mockImplementation(async () => waitResult.promise);
      } else {
        mockPendingAgentWait();
      }
      mocks.entries = {
        [childSessionKey]: createSessionEntry({ lifecycleRevision: "forced-timeout" }),
      };
      const settleRootWork = observeRootWork();
      await mod.registerSubagentRun({
        runId,
        childSessionKey,
        collect: true,
        expectsCompletionMessage: false,
        swarmRequesterSessionKey: "agent:main:main",
      });
      if (observation === "wait") {
        // The Gateway agent-job owner normalizes lifecycle facts before exposing
        // agent.wait. Its response is not the raw lifecycle event.
        const normalized = buildAgentRunTerminalOutcomeFromLifecycleEvent({
          phase: "end",
          data: terminal,
        });
        waitResult.resolve({ ...terminal, status: normalized.status });
      } else {
        emitLifecycle(runId, { phase: "end", ...terminal });
      }
      await vi.advanceTimersByTimeAsync(20_000);
      await settleRootWork();
      const entry = findRequesterRun(runId);
      expect(entry?.execution.outcome?.status).toBe(kind === "blocked" ? "error" : "timeout");
      expect(entry?.collectorCompletion?.status).toBe(kind === "blocked" ? "failed" : "timeout");
      expect(entry?.pauseReason).toBeUndefined();
      expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
    },
  );

  registerYieldFollowupAdoptionTests({
    getRegistry: () => mod,
    bindWakeMutation: (entries) => bindWakeMutation(entries),
    mocks,
    findRequesterRun,
    getLifecycleHandler,
    updateFixtureRun,
    settleLifecycle,
    wakeRequester,
  });

  it.each(["lifecycle yield", "wait yield", "explicit kill"] as const)(
    "reconciles a pending abort after %s while execution settles (#92448)",
    async (source) => {
      const runId = "run-after-pending-timeout";
      const waitResult = createDeferred<Record<string, unknown>>();
      if (source === "wait yield") {
        mockAgentWait(waitResult.promise);
      } else {
        mockPendingAgentWait();
      }
      const sessionEntry = createSessionEntry({
        sessionId: "sess-pending-timeout",
        lifecycleRevision: "revision-pending-timeout",
      });
      mocks.entries["agent:main:subagent:pending-timeout"] = sessionEntry;
      const { operation, releaseExecution } = holdChildExecution(
        runId,
        "agent:main:subagent:pending-timeout",
        "sess-pending-timeout",
      );
      const settleRootWork = observeRootWork();
      try {
        await mod.registerSubagentRun({
          runId,
          childSessionKey: "agent:main:subagent:pending-timeout",
          sessionEntry,
        });
        const lifecycleHandler = getLifecycleHandler();
        lifecycleHandler({
          runId,
          stream: "lifecycle",
          data: { phase: "end", startedAt: 111, endedAt: 222, aborted: true },
        });
        if (source === "explicit kill") {
          expect(await mod.markSubagentRunTerminated({ runId, reason: "manual kill" })).toBe(1);
        } else {
          if (source === "wait yield") {
            waitResult.resolve({ status: "ok", startedAt: 111, endedAt: 333, yielded: true });
          } else {
            lifecycleHandler({
              runId,
              stream: "lifecycle",
              data: { phase: "end", startedAt: 111, endedAt: 333, yielded: true, aborted: true },
            });
          }
          await waitForFast(() =>
            expect(findRequesterRun(runId)?.pauseReason).toBe("sessions_yield"),
          );
        }
        await vi.advanceTimersByTimeAsync(60_000);
        const run = findRequesterRun(runId);
        if (source === "explicit kill") {
          expect(run).toMatchObject({
            endedReason: SUBAGENT_ENDED_REASON_KILLED,
            execution: { outcome: { status: "error", error: "manual kill" } },
          });
        } else {
          expect(run?.pauseReason).toBe("sessions_yield");
        }
        expect(run?.execution.outcome?.status).not.toBe(
          source === "lifecycle yield" ? "error" : "timeout",
        );
        expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
      } finally {
        waitResult.resolve({ status: "pending" });
        releaseExecution();
        operation.complete();
        await operation.ownerSettlement;
        await settleRootWork();
      }
    },
  );

  it.each([
    {
      source: "wait",
      kind: "transport diagnostic",
      error: "child exited with code 1\nstderr: socket hang up",
    },
    { source: "wait", kind: "provider timeout", error: "model timed out" },
    {
      source: "lifecycle",
      kind: "blocked",
      error: "Context overflow: prompt too large for the model.",
    },
    {
      source: "lifecycle",
      kind: "abandoned",
      error: "Agent run ended before producing a complete result.",
    },
  ])("announces $source $kind with its terminal evidence", async ({ source, kind, error }) => {
    mocks.persistRegistryRows.mockImplementation(saveSubagentRegistryChangesToSqlite);
    const runId = `run-${source}-${kind}`;
    const startedAt = source === "wait" ? 100 : 10;
    const endedAt = source === "wait" ? 250 : 20;
    const providerTimeout = kind === "provider timeout";
    if (source === "wait") {
      mockAgentWait({
        status: "error",
        startedAt,
        endedAt,
        livenessState: kind === "transport diagnostic" ? undefined : "blocked",
        error,
        ...(providerTimeout
          ? {
              timeoutPhase: "provider",
              providerStarted: true,
              terminalReply: { disposition: "empty" },
            }
          : {}),
      });
    } else {
      mockPendingAgentWait();
    }
    const settleRootWork = observeRootWork();
    try {
      await mod.registerSubagentRun({
        runId,
        expectsCompletionMessage: true,
      });
      if (source === "lifecycle") {
        emitLifecycle(runId, { phase: "start", startedAt });
        emitLifecycle(runId, {
          phase: "end",
          startedAt,
          endedAt,
          livenessState: kind,
          ...(kind === "blocked" ? { error } : { replayInvalid: true }),
        });
      }
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      await settleRootWork();
    }
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    if (providerTimeout) {
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledWith(
        expect.objectContaining({
          childRunId: runId,
          outcome: expect.objectContaining({ status: "timeout" }),
          terminalReply: expect.objectContaining({ disposition: "empty" }),
        }),
      );
      expect(loadSubagentRegistryFromSqlite().get(runId)?.completion).toMatchObject({
        terminalReply: { disposition: "empty" },
        resultText: null,
      });
    } else {
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledWith(
        expect.objectContaining({
          childRunId: runId,
          outcome: expect.objectContaining({
            status: "error",
            error,
            startedAt,
            endedAt,
            elapsedMs: endedAt - startedAt,
          }),
        }),
      );
      expect(findRequesterRun(runId)?.endedReason).toBe("subagent-error");
      expect(findRequesterRun(runId)?.execution.outcome?.status).toBe("error");
    }
  });

  registerCancellationReconciliationTests({
    getRegistry: () => mod,
    mocks,
    findRequesterRun,
    mockEndedHooks,
  });

  registerSupersededNativeTimingTest({ getRegistry: () => mod, mocks, mockPendingAgentWait });

  it.each(["registry write", "completion hook"] as const)(
    "retries completion after a transient %s failure",
    async (failure) => {
      const runId = "run-retry-completion";
      const runSubagentEnded = vi
        .fn()
        .mockRejectedValueOnce(new Error("ended hook unavailable"))
        .mockResolvedValue(undefined);
      if (failure === "registry write") {
        mocks.persistRegistryRows
          .mockImplementationOnce(() => {})
          .mockImplementationOnce(() => {
            throw new Error("transient disk error");
          })
          .mockImplementation(() => {});
      } else {
        mockEndedHooks(runSubagentEnded);
      }
      await mod.registerSubagentRun({
        runId,
        childSessionKey:
          failure === "registry write"
            ? "agent:main:subagent:retry-durable-completion"
            : "agent:main:subagent:child",
        ...(failure === "registry write"
          ? { sessionEntry: { sessionId: "sess-retry-durable-completion" } }
          : {}),
        expectsCompletionMessage: false,
      });
      await waitForFast(() => {
        const run = findRequesterRun(runId);
        if (failure === "registry write") {
          expect(run).toMatchObject({
            endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
            execution: {
              status: "terminal",
              endedAt: 222,
              outcome: { status: "ok", startedAt: 111, endedAt: 222 },
            },
          });
          expect(mocks.persistRegistryRows.mock.calls.length).toBeGreaterThanOrEqual(3);
        } else {
          expect(runSubagentEnded.mock.calls.length).toBeGreaterThanOrEqual(2);
          expect(run?.cleanupCompletedAt).toBeTypeOf("number");
        }
      });
      if (failure === "completion hook") {
        expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
      }
    },
  );

  registerSubagentRegistrationPersistenceTests({
    getRegistry: () => mod,
    mocks,
    mockPendingAgentWait,
    findRequesterRun,
  });

  registerBrowserCleanupBoundaryTests({
    getRegistry: () => mod,
    mocks,
    loadBrowserMaintenanceSurface,
    mockPendingAgentWait,
    findRequesterRun,
  });

  it.each([
    {
      name: "publishes aborted wait snapshots only after killed reconciliation",
      runId: "run-aborted-wait",
      task: "aborted wait",
      phase: "wait" as const,
      event: { stopReason: "aborted" },
      verifiesAnnouncement: true,
    },
    {
      name: "publishes aborted lifecycle end events only after killed reconciliation",
      runId: "run-aborted-end",
      task: "aborted task",
      phase: "end" as const,
      event: { aborted: true, livenessState: "blocked", stopReason: "aborted" },
      verifiesAnnouncement: true,
    },
    {
      name: "preserves restart lifecycle error events for recovery",
      runId: "run-restart-error",
      task: "restart error task",
      phase: "error" as const,
      event: {
        error: "ACP turn failed before completion",
        aborted: true,
        stopReason: "restart",
      },
      verifiesAnnouncement: false,
    },
  ])("$name", async ({ runId, task, phase, event, verifiesAnnouncement }) => {
    const startedAt = phase === "wait" ? 100 : 10;
    const endedAt = phase === "wait" ? 250 : 20;
    if (phase === "wait") {
      mockAgentWait({ status: "ok", startedAt, endedAt, ...event });
    } else {
      mockPendingAgentWait();
    }
    await mod.registerSubagentRun({ runId, task, expectsCompletionMessage: true });

    const lifecycleHandler = getLifecycleHandler();
    if (phase !== "wait" && verifiesAnnouncement) {
      lifecycleHandler?.({
        runId,
        stream: "lifecycle",
        data: { phase: "start", startedAt },
      });
    }
    if (phase !== "wait") {
      lifecycleHandler({
        runId,
        stream: "lifecycle",
        data: { phase, startedAt, endedAt, ...event },
      });
    }

    if (event.stopReason === "restart") {
      await waitForFast(() => {
        const run = findRequesterRun(runId);
        expect(run?.execution).toMatchObject({
          status: "interrupted",
          interruptedAt: 20,
          interruptionReason: "gateway-restart",
        });
        expectUnsettled(run);
        expect(run?.endedReason).toBeUndefined();
      });
      expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
      return;
    }
    // The confirmed kill reports its outcome to the requester once, then retires the row.
    await waitForFast(() => expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1));
    if (verifiesAnnouncement) {
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledWith(
        expect.objectContaining({
          childRunId: runId,
          outcome: expect.objectContaining({
            status: "error",
            error: "subagent run terminated",
            startedAt,
            endedAt,
            elapsedMs: endedAt - startedAt,
          }),
        }),
      );
    }
    await waitForFast(() =>
      expect(
        mod.listSubagentRunsForRequester("agent:main:main").some((entry) => entry.runId === runId),
      ).toBe(false),
    );
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
  });

  it("finishes canonical killed cleanup when its best-effort hook fails", async () => {
    mockPendingAgentWait();
    const endedHook = vi.fn().mockRejectedValueOnce(new Error("ended hook unavailable"));
    mockEndedHooks(endedHook);

    await mod.registerSubagentRun({
      runId: "run-killed-recovery",
      expectsCompletionMessage: false,
    });

    emitLifecycle("run-killed-recovery", { phase: "start", startedAt: 100 });
    emitLifecycle("run-killed-recovery", {
      phase: "end",
      startedAt: 100,
      endedAt: 200,
      stopReason: "aborted",
    });

    await waitForFast(() => {
      expect(
        mod
          .listSubagentRunsForRequester("agent:main:main")
          .some((entry) => entry.runId === "run-killed-recovery"),
      ).toBe(false);
    });
    expect(endedHook).toHaveBeenCalledOnce();
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
  });

  registerTimeoutSuccessAnnouncementTest({
    getRegistry: () => mod,
    mocks,
    findRequesterRun,
    mockPendingAgentWait,
    holdChildExecution,
    getLifecycleHandler,
    settleLifecycle,
  });

  it("retains delete-mode successful completions through the delivery deadline", async () => {
    const persist = (runs: Map<string, SubagentRunRecord>, runIds?: readonly string[]) =>
      saveSubagentRegistryChangesToSqlite(runs, runIds ?? [...runs.keys()]);
    mocks.persistRegistryRows.mockImplementation(persist);
    mocks.runSubagentAnnounceFlow.mockResolvedValue("retryable");
    const endedAt = Date.parse("2026-03-24T12:00:00Z");
    mocks.callGateway.mockResolvedValueOnce({
      status: "ok",
      startedAt: endedAt - 500,
      endedAt,
      terminalReply: { disposition: "visible", text: "final completion reply" },
    });

    const settleRootWork = observeRootWork();
    await mod.registerSubagentRun({
      runId: "run-delete-give-up",
      cleanup: "delete",
      expectsCompletionMessage: true,
    });

    await vi.advanceTimersByTimeAsync(0);
    await settleRootWork(true);
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    expect(findRequesterRun("run-delete-give-up")).toMatchObject({
      runId: "run-delete-give-up",
      cleanup: "delete",
    });

    const retryWindowEnd = endedAt + 5 * 60_000;
    while (Date.now() < retryWindowEnd) {
      await vi.advanceTimersToNextTimerAsync();
      await settleRootWork(true);
    }
    expect(mocks.runSubagentAnnounceFlow.mock.calls.length).toBeGreaterThan(3);
    expect(findRequesterRun("run-delete-give-up")?.delivery?.status).not.toBe("suspended");

    const deadlineAt = findRequesterRun("run-delete-give-up")?.delivery?.deadlineAt;
    expect(deadlineAt).toBeTypeOf("number");
    vi.setSystemTime((deadlineAt ?? Date.now()) + 1);
    mod.resumeSubagentRun("run-delete-give-up");
    await vi.advanceTimersByTimeAsync(0);
    await settleRootWork();
    expect(findRequesterRun("run-delete-give-up")?.delivery).toMatchObject({
      status: "suspended",
      suspendedReason: "expiry",
    });
  });

  it.each(["delete", "keep"] as const)(
    "retries completion %s runs regardless of prior attempt count",
    async (cleanup) => {
      mockEndedHooks();
      const runId = `run-resume-${cleanup}`;
      const task = `resume ${cleanup} retry budget`;
      const endedAt = Date.parse("2026-03-24T11:59:30Z");
      const restored = createSubagentRunRecord({
        runId,
        childSessionIdentity: {
          sessionId: "sess-child",
          lifecycleRevision: "revision-child",
        },
        task,
        cleanup,
        createdAt: Date.parse("2026-03-24T11:58:00Z"),
        startedAt: Date.parse("2026-03-24T11:59:00Z"),
        endedAt,
        expectsCompletionMessage: true,
        delivery: {
          status: "pending",
          attemptCount: 3,
          lastAttemptAt: Date.parse("2026-03-24T11:59:40Z"),
        },
      });
      await prepareSubagentRecoveryFixture(restored, { entries: mocks.entries });
      mocks.restoreSubagentRunsFromDisk.mockImplementation(async ({ runs }) => {
        runs.set(runId, restored);
        return 1;
      });

      const settleRootWork = observeRootWork();
      try {
        await hydrateAndActivateRegistry();
      } finally {
        await settleRootWork();
      }

      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledWith(
        expect.objectContaining({ childRunId: runId }),
      );
      const settled = findRequesterRun(runId);
      if (cleanup === "delete") {
        expect(settled).toBeUndefined();
      } else {
        expect(settled).toMatchObject({
          runId,
          cleanup: "keep",
          cleanupCompletedAt: expect.any(Number),
          delivery: { status: "delivered" },
        });
        expect(settled?.requesterSettleWake).toBeUndefined();
        expect(settled?.delivery?.attemptCount).toBeUndefined();
      }
    },
  );

  it("finalizes expired delete-mode parents when descendant cleanup retriggers deferred announce handling", async () => {
    mocks.entries = sessionEntries(
      {
        "agent:main:subagent:parent": ["sess-parent", "revision-parent"],
        "agent:main:subagent:child": ["sess-child", "revision-child"],
      },
      1,
    );

    await mod.addSubagentRunForTests({
      runId: "run-parent-expired",
      childSessionKey: "agent:main:subagent:parent",
      childSessionIdentity: {
        sessionId: "sess-parent",
        lifecycleRevision: "revision-parent",
      },
      cleanup: "delete",
      createdAt: Date.parse("2026-03-24T11:50:00Z"),
      startedAt: Date.parse("2026-03-24T11:50:30Z"),
      endedAt: Date.parse("2026-03-24T11:51:00Z"),
      cleanupHandled: false,
      cleanupCompletedAt: undefined,
    });

    const announceEntered = createDeferred();
    mocks.runSubagentAnnounceFlow.mockImplementationOnce(async () => {
      announceEntered.resolve();
      return "delivered";
    });
    const settleRootWork = observeRootWork();
    try {
      await mod.registerSubagentRun({
        runId: "run-child-finished",
        requesterSessionKey: "agent:main:subagent:parent",
        requesterDisplayKey: "parent",
      });
      await announceEntered.promise;
    } finally {
      await settleRootWork();
    }

    expect(findRequesterRun("run-parent-expired")).toBeUndefined();

    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledWith(
      expect.objectContaining({ childRunId: "run-child-finished" }),
    );
    await waitForFast(() => {
      expect(mocks.onSubagentEnded).toHaveBeenCalledWith({
        childSessionKey: "agent:main:subagent:parent",
        reason: "deleted",
        workspaceDir: undefined,
      });
    });
  });

  registerYieldedParentCleanupCase({ getRegistry: () => mod, mocks });

  it("defers the killed hook until the provisional result reconciles", async () => {
    mockPendingAgentWait();
    mockEndedHooks();
    const sessionEntry = createSessionEntry({
      sessionId: "sess-killed",
      lifecycleRevision: "revision-killed",
    });
    mocks.entries["agent:main:subagent:killed"] = sessionEntry;

    const { operation, releaseExecution } = holdChildExecution(
      "run-killed-init",
      "agent:main:subagent:killed",
      "sess-killed",
    );
    const settleRootWork = observeRootWork();
    try {
      await mod.registerSubagentRun({
        runId: "run-killed-init",
        childSessionKey: "agent:main:subagent:killed",
        sessionEntry,
        requesterOrigin: { channel: "quietchat", accountId: "acct-1" },
        expectsCompletionMessage: false,
        workspaceDir: "/tmp/killed-workspace",
      });

      const updated = await mod.markSubagentRunTerminated({
        runId: "run-killed-init",
        reason: "manual kill",
      });

      expect(updated).toBe(1);
      const killedRun = findRequesterRun("run-killed-init");
      const killedAt = Date.parse("2026-03-24T12:00:00Z");
      expect(killedRun?.execution.outcome).toEqual({
        status: "error",
        error: "manual kill",
        startedAt: killedAt,
        endedAt: killedAt,
        elapsedMs: 0,
      });
      expect(mocks.runSubagentEnded).not.toHaveBeenCalled();
      operation.complete();
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.runSubagentEnded).not.toHaveBeenCalled();
      releaseExecution();
      await operation.ownerSettlement;
      vi.setSystemTime(killedAt + PROVISIONAL_KILL_RECONCILIATION_MS);
      await mod.testing.sweepOnceForTests();
      await waitForFast(() => expect(mocks.runSubagentEnded).toHaveBeenCalled());
      expect(mocks.runSubagentEnded).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          targetSessionKey: "agent:main:subagent:killed",
          reason: "subagent-killed",
          accountId: "acct-1",
          runId: "run-killed-init",
          outcome: "killed",
          error: "manual kill",
        }),
        expect.objectContaining({
          runId: "run-killed-init",
          childSessionKey: "agent:main:subagent:killed",
          requesterSessionKey: "agent:main:main",
        }),
      );
    } finally {
      releaseExecution();
      operation.complete();
      await operation.ownerSettlement;
      await settleRootWork();
    }
  });

  const completeTerminalOutcome = {
    status: "error" as const,
    error: "existing failure",
    startedAt: 1,
    endedAt: 2,
    elapsedMs: 1,
  };
  const completeTerminalEvidence = {
    endedReason: SUBAGENT_ENDED_REASON_ERROR,
    execution: {
      status: "terminal" as const,
      startedAt: 1,
      endedAt: 2,
      outcome: completeTerminalOutcome,
    },
  };
  it.each([
    [
      "persistence-failure",
      0,
      { execution: { status: "running" as const, startedAt: 1 } },
      undefined,
    ],
    [
      "missing-ended-at",
      0,
      {
        ...completeTerminalEvidence,
        execution: { status: "terminal" as const, startedAt: 1, outcome: completeTerminalOutcome },
      },
      undefined,
    ],
    ["cleanup-complete", 1, completeTerminalEvidence, 2],
    [
      "cleanup-partial",
      0,
      {
        ...completeTerminalEvidence,
        execution: { status: "terminal" as const, startedAt: 1, endedAt: 2 },
      },
      2,
    ],
  ])(
    "%s terminal evidence returns %i",
    async (scenario, expected, evidence, cleanupCompletedAt) => {
      const runId = `run-interrupted-${scenario}`;
      const entry = createSubagentRunRecord({
        runId,
        childSessionKey: `agent:main:subagent:interrupted-${scenario}`,
        childSessionIdentity: { sessionId: `sess-interrupted-${scenario}` },
        createdAt: 1,
        cleanupCompletedAt,
        ...evidence,
      });
      await mod.addSubagentRunForTests(entry);
      const original = structuredClone(
        expectDefined(findRequesterRun(runId), "published fixture run"),
      );

      if (scenario === "persistence-failure") {
        mocks.persistRegistryRows.mockClear();
        mocks.persistRegistryRows.mockImplementationOnce(() => {
          throw new Error("registry store boom");
        });
      }
      await expect(
        mod.finalizeInterruptedSubagentRun({
          runId,
          error: "restart interrupted run",
          endedAt: scenario === "persistence-failure" ? 2 : 3,
        }),
      ).resolves.toBe(expected);

      if (scenario === "persistence-failure") {
        expect(mocks.persistRegistryRows).toHaveBeenCalledOnce();
      }
      expect(findRequesterRun(runId)).toEqual(original);
    },
  );

  it("passes stored agentDir through swept context-engine cleanup paths", async () => {
    const now = Date.now();
    const kinds = ["session", "archive"] as const;
    mocks.entries = {
      "agent:alt:session:child-archive": {
        lifecycleRevision: "revision-child-archive",
        sessionId: "session-child-archive",
        updatedAt: now,
      },
    };
    for (const kind of kinds) {
      const childSessionKey = `agent:alt:session:child-${kind}`;
      await mod.addSubagentRunForTests({
        runId: `run-${kind}-swept-context-engine`,
        childSessionKey,
        childSessionIdentity: {
          sessionId: `session-child-${kind}`,
          lifecycleRevision: `revision-child-${kind}`,
        },
        controllerSessionKey: "agent:main:session:parent",
        requesterSessionKey: "agent:main:session:parent",
        requesterDisplayKey: "parent",
        spawnMode: kind === "session" ? "session" : "run",
        agentDir: `/tmp/agent-${kind}`,
        workspaceDir: `/tmp/workspace-${kind}`,
        createdAt: now - 20_000,
        startedAt: now - 10_000,
        sessionStartedAt: now - 10_000,
        accumulatedRuntimeMs: 0,
        endedAt: now - 8_000,
        outcome: { status: "ok", startedAt: now - 10_000, endedAt: now - 8_000, elapsedMs: 2_000 },
        cleanupHandled: true,
        ...(kind === "session"
          ? { cleanupCompletedAt: now - 6 * 60_000 }
          : { cleanup: "delete", archiveAtMs: now - 1 }),
      });
    }

    const settleRootWork = observeRootWork();
    try {
      await mod.testing.sweepOnceForTests();
    } finally {
      await settleRootWork();
    }
    for (const kind of kinds) {
      expect(mocks.resolveContextEngine).toHaveBeenCalledWith(mocks.getRuntimeConfig(), {
        agentDir: `/tmp/agent-${kind}`,
        workspaceDir: `/tmp/workspace-${kind}`,
        initialize: mocks.ensureContextEnginesInitialized,
      });
    }
  });

  it.each(["main", "cron"] as const)(
    "does not emit ended hooks before suspended %s delete retirement is durable",
    async (requester) => {
      const now = Date.parse("2026-03-24T12:00:00Z");
      const requesterSessionKey =
        requester === "cron" ? "agent:main:cron:cron-1:run:parent" : "agent:main:main";
      const runId = "run-suspended-delete-persist-failure";
      const childSessionKey = "agent:main:subagent:suspended-delete-persist-failure";
      mockEndedHooks();
      await mod.addSubagentRunForTests(
        makeSuspendedDeliveryRun({
          runId,
          childSessionKey,
          childSessionIdentity: {
            sessionId: "sess-suspended-delete-persist-failure",
            lifecycleRevision: "revision-suspended-delete-persist-failure",
          },
          controllerSessionKey: requesterSessionKey,
          requesterSessionKey,
          requesterDisplayKey: "main",
          task: "discard suspended delete delivery",
          cleanup: "delete",
          spawnMode: "run",
          createdAt: now - 8 * 24 * 60 * 60_000,
          endedAt: now - 8 * 24 * 60 * 60_000,
          delivery: {
            suspendedAt: now - 7 * 24 * 60 * 60_000 - 1,
          },
        }),
      );
      const original = structuredClone(await mod.getSubagentRunByChildSessionKey(childSessionKey));
      mocks.persistRegistryRows.mockImplementationOnce(() => {
        throw new Error("registry deletion failed");
      });

      await expect(mod.testing.sweepOnceForTests()).rejects.toThrow("registry deletion failed");

      expect(await mod.getSubagentRunByChildSessionKey(childSessionKey)).toEqual(original);
      expect(mocks.runSubagentEnded).not.toHaveBeenCalled();
      expect(mocks.onSubagentEnded).not.toHaveBeenCalled();
      expect(mocks.removeInternalSessionEffectsSession).not.toHaveBeenCalled();

      await mod.testing.sweepOnceForTests();

      expect(await mod.getSubagentRunByChildSessionKey(childSessionKey)).toBeNull();
      expect(mocks.runSubagentEnded).toHaveBeenCalledTimes(1);
      await waitForFast(() => {
        expect(mocks.removeInternalSessionEffectsSession).toHaveBeenCalledTimes(1);
      });
    },
  );
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
