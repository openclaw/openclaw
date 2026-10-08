import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
// Subagent registry tests cover run state, completion capture, archive cleanup,
// persistence, lifecycle hooks, and orphan recovery scheduling.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { cleanupBrowserSessionsForLifecycleEnd } from "../../../browser-lifecycle-cleanup.js";
import {
  runWithOwnedSessionTranscriptWrite,
  withOwnedSessionTranscriptWrites,
} from "../../../config/sessions/transcript-write-context.js";
import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import { createMockGatewayRecoveryRuntime } from "../../../gateway/server-recovery-runtime.test-support.js";
import type { AgentEventPayload } from "../../../infra/agent-events.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { getPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../../process/gateway-work-admission.js";
vi.mocked(cleanupBrowserSessionsForLifecycleEnd).mockReset();
import { buildAgentRunTerminalOutcomeFromLifecycleEvent } from "../../agent-run-terminal-outcome.js";
import type { SubagentRegistryHarness } from "../../subagent-test-fixtures.test-helpers.js";
import {
  configureMockSubagentRegistryPersistence,
  createSessionEntry,
  createSubagentRegistryHarness,
  createSubagentRunRecord,
  mockGatewayMethods,
  waitForFast,
} from "../../subagent-test-fixtures.test-helpers.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import { releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import { testing as swarmSchedulerTesting } from "../swarm/swarm-scheduler.test-support.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";
import { mockRegistryRequesterWakeMutation } from "./subagent-registry-lifecycle-completion.test-support.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { publishSubagentRunChanges } from "./subagent-registry-publication.js";
import {
  registerSubagentResultRefreshCases,
  updateSubagentRunFixture as updateFixtureRun,
} from "./subagent-registry-result-refresh.test-support.js";
import { saveSubagentRegistryChangesToSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { registerYieldFollowupAdoptionTests } from "./subagent-registry-yield-followup-adoption.test-support.js";
import { registerYieldedParentCleanupCase } from "./subagent-registry-yielded-cleanup.test-support.js";
import {
  observeRootWork,
  registerBrowserCleanupBoundaryTests,
} from "./subagent-registry.browser-cleanup.test-support.js";
import {
  registerForcedCollectorCompletionSettlementTests,
  registerQueuedCollectorLaunchSettlementTest,
  registerRestartDrainCompletionSettlementTest,
} from "./subagent-registry.native-settlement.test-support.js";
import { registerSupersededNativeTimingTest } from "./subagent-registry.native-termination.test-support.js";
import { registerSubagentRegistrationPersistenceTests } from "./subagent-registry.persistence.test-support.js";
import {
  activateSubagentRegistryWithRecoveryRuntime,
  registerRestoredRequesterWakeSettlementTests,
  registerRestoredRollbackPublicationTest,
  registerRestoredRotationFailureTest,
} from "./subagent-registry.restored-settlement.test-support.js";
import {
  makeCompletedCollectorRun,
  makeKilledRun,
  makeQueuedRun,
  makeSuspendedDeliveryRun,
} from "./subagent-registry.run-fixtures.test-support.js";
import { resetSubagentRegistrySessionMocks } from "./subagent-registry.session-mocks.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { resolveSubagentSessionStatus } from "./subagent-session-metrics.js";

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
vi.mock("../../../infra/agent-run-registry.js", () => ({
  getAgentRunContext: mocks.getAgentRunContext,
  listAgentRunsForSession: () => [],
  hasLiveAgentRunContext: vi.fn(() => false),
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
    consumeFreshSubagentRegistryRows,
    publishSubagentRunsAfterAtomicStore,
    rememberRestoredSubagentRunNotification,
  } = await importOriginal<typeof import("./subagent-registry-state.js")>();
  return {
    consumeFreshSubagentRegistryRows,
    rememberRestoredSubagentRunNotification,
    clearSubagentRunsReadCacheForTest: mocks.clearSubagentRunsReadCacheForTest,
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
vi.mock("../../runtime-plugins.js", () => ({
  loadAgentRuntimePluginRegistryHandle: mocks.loadAgentRuntimePluginRegistryHandle,
}));

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
  const { mockRestoredRuns } = mocks;
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
  const mockSingleCollectorConcurrency = () =>
    mocks.getRuntimeConfig.mockReturnValue({
      tools: { swarm: { enabled: true, maxConcurrent: 1 } },
      agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
      session: { mainKey: "main", scope: "per-sender" as const, store: mocks.resolveStorePath() },
    });
  const getLifecycleHandler = () => {
    const handler = expectDefined(mocks.onAgentEvent.mock.calls.at(-1)?.[0], "lifecycle handler");
    return (
      event: Pick<AgentEventPayload, "runId" | "stream" | "data"> & Partial<AgentEventPayload>,
    ) => handler({ seq: 1, ts: Date.now(), ...event });
  };

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
    mod = createSubagentRegistryHarness(registry);
  });

  beforeEach(async () => {
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
    mocks.resolveAgentIdFromSessionKey.mockImplementation((sessionKey: string) => {
      return sessionKey.match(/^agent:([^:]+)/)?.[1] ?? "main";
    });
    mocks.entries = {
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
    swarmSchedulerTesting.reset();
    bindWakeMutation = await mockRegistryRequesterWakeMutation();
  });

  afterEach(async () => {
    resetGatewayWorkAdmission();
    vi.mocked(cleanupBrowserSessionsForLifecycleEnd).mockReset();
    await mod.resetSubagentRegistryForTests({ persist: false });
    swarmSchedulerTesting.reset();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it.each(["session", "agent"])(
    "keeps collector archive groups scoped to their requester %s",
    async (scope) => {
      const now = Date.now();
      for (const [suffix, archiveAtMs] of [
        ["one", now - 1],
        ["two", now + 1_000],
      ] as const) {
        const requesterSessionKey = scope === "agent" ? "global" : `agent:main:requester-${suffix}`;
        await mod.addSubagentRunForTests(
          makeCompletedCollectorRun({
            runId: `run-${suffix}`,
            childSessionKey: `agent:${suffix}:subagent:collector`,
            requesterSessionKey,
            requesterAgentId: scope === "agent" ? suffix : "main",
            task: "retain requester-scoped collector groups",
            cleanup: "delete",
            createdAt: now - 10_000,
            endedAt: now - 5_000,
            cleanupCompletedAt: now - 4_000,
            archiveAtMs,
            groupId: "swarm:shared-group-id",
          }),
        );
      }

      await mod.testing.sweepOnceForTests();

      expect(mod.getSubagentRunByRunId("run-one")).toBeUndefined();
      expect(mod.getSubagentRunByRunId("run-two")).toBeDefined();
    },
  );

  it.each(["sweep", "collector cleanup", "collector replacement"] as const)(
    "revalidates collector ownership after awaited %s work",
    async (phase) => {
      const now = Date.now();
      const runId = "run-collector-before-await";
      const childSessionKey = "agent:main:subagent:collector-before-await";
      const blockerKey =
        phase === "sweep" ? "agent:main:subagent:archive-blocker" : childSessionKey;
      mocks.entries = {
        [blockerKey]: createSessionEntry({
          lifecycleRevision: "revision-blocker",
          sessionId: "session-blocker",
        }),
      };
      let releaseDelete: (() => void) | undefined;
      mocks.callGateway.mockImplementation((request: { method?: string }) => {
        if (request.method !== "sessions.delete" || releaseDelete) {
          return Promise.resolve({});
        }
        return new Promise<Record<string, unknown>>((resolve) => {
          releaseDelete = () => resolve({});
        });
      });
      if (phase === "sweep") {
        await mod.addSubagentRunForTests({
          runId: "run-archive-blocker",
          childSessionKey: blockerKey,
          task: "hold the sweep before collector archival",
          cleanup: "delete",
          createdAt: now - 10_000,
          endedAt: now - 5_000,
          cleanupCompletedAt: now - 4_000,
          archiveAtMs: now - 1,
        });
      }
      await mod.addSubagentRunForTests(
        makeCompletedCollectorRun({
          runId,
          childSessionKey,
          task: "completed collector present before cleanup",
          createdAt: now - 10_000,
          endedAt: now - 5_000,
          archiveAtMs: now - 1,
          groupId: "swarm:cleanup-race",
        }),
      );
      const sweep = mod.testing.runSweeperTickForTests();
      await waitForFast(() => expect(releaseDelete).toBeTypeOf("function"));
      if (phase === "sweep") {
        expect(getActiveGatewayRootWorkCount()).toBe(1);
      }
      if (phase === "collector replacement") {
        await mod.addSubagentRunForTests(
          makeCompletedCollectorRun({
            runId,
            childSessionKey: "agent:main:subagent:collector-after-await",
            task: "collector after replacement",
            createdAt: now,
            endedAt: now,
            archiveAtMs: now - 1,
            groupId: "swarm:cleanup-race",
          }),
        );
      } else {
        await mod.addSubagentRunForTests({
          runId: "run-collector-after-await",
          childSessionKey: "agent:main:subagent:collector-after-await",
          task: "incomplete collector registered during cleanup",
          createdAt: now,
          collect: true,
          groupId: "swarm:cleanup-race",
        });
      }
      releaseDelete?.();
      await sweep;
      if (phase === "sweep") {
        await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      }
      if (phase === "collector replacement") {
        expect(mod.getSubagentRunByRunId(runId)?.childSessionKey).toBe(
          "agent:main:subagent:collector-after-await",
        );
      } else {
        expect(mod.getSubagentRunByRunId(runId)).toBeDefined();
        expect(mod.getSubagentRunByRunId("run-collector-after-await")).toBeDefined();
      }
    },
  );

  it("keeps collector groups while any member owes failed-launch cleanup", async () => {
    const now = Date.now();
    mocks.entries = {
      "agent:main:subagent:collector-clean": {
        lifecycleRevision: "revision-collector-clean",
        sessionId: "session-collector-clean",
        updatedAt: now,
      },
      "agent:main:subagent:collector-cleanup-pending": {
        lifecycleRevision: "revision-collector-cleanup-pending",
        sessionId: "session-collector-cleanup-pending",
        updatedAt: now,
      },
    };
    await mod.addSubagentRunForTests(
      makeCompletedCollectorRun({
        runId: "run-collector-clean",
        childSessionKey: "agent:main:subagent:collector-clean",
        task: "completed sibling",
        createdAt: now - 10_000,
        endedAt: now - 5_000,
        archiveAtMs: now - 1,
        groupId: "swarm:cleanup-pending",
      }),
    );
    await mod.addSubagentRunForTests({
      runId: "run-collector-cleanup-pending",
      childSessionKey: "agent:main:subagent:collector-cleanup-pending",
      task: "failed launch cleanup",
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
      task: "spawn nested child",
      createdAt: Date.now(),
      expectsCompletionMessage: true,
    });
    await mod.registerSubagentRun({
      runId: "run-collector-descendant",
      childSessionKey: "agent:main:subagent:collector-descendant",
      controllerSessionKey: parentSessionKey,
      requesterSessionKey: parentSessionKey,
      requesterDisplayKey: "parent",
      task: "nested result",
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

  registerQueuedCollectorLaunchSettlementTest({ getRegistry: () => mod });

  it("records early structured output through the child session identity", async () => {
    const childSessionKey = "agent:main:subagent:early-structured-output";
    await mod.addSubagentRunForTests({
      runId: "public-collector-run",
      childSessionKey,
      task: "return structured output immediately",
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
    mockRestoredRuns(() => [restored]);
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

  it("retries registry restore after a transient partial-merge failure", async () => {
    const runId = "run-restore-retry";
    const restored = createSubagentRunRecord({
      runId,
      task: "retry registry restore",
      cleanup: "keep",
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

    await vi.advanceTimersByTimeAsync(1_000);

    expect(mocks.restoreSubagentRunsFromDisk).toHaveBeenCalledTimes(2);
    expect(mod.getSubagentRunByRunId(runId)?.runId).toBe(runId);
    expect(mocks.onAgentEvent).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);

    await mod.initSubagentRegistry();
    expect(mocks.restoreSubagentRunsFromDisk).toHaveBeenCalledTimes(2);
  });

  it("routes restored waits for a newer session run", async () => {
    const runId = "run-restored-orphan-routing";
    const restored = createSubagentRunRecord({
      runId,
      execution: {
        status: "running",
        lifecycleGeneration: "retired-generation",
      },
    });
    mocks.entries = {
      "agent:main:subagent:child": createSessionEntry({
        lifecycleRunId: "newer-run",
        abortedLastRun: false,
      }),
    };
    mockRestoredRuns(() => [restored]);
    mockPendingAgentWait();

    await hydrateAndActivateRegistry();

    expect(mocks.callGateway).toHaveBeenCalledOnce();
    expect(mocks.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "agent.wait",
        params: expect.objectContaining({ runId }),
      }),
    );
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
    mockRestoredRuns(() => [
      makeQueuedRun({
        runId: "run-queued-kill-intent",
        childSessionKey: "agent:main:subagent:queued-kill-intent",
        task: "do not relaunch",
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

    expect(mocks.callGateway.mock.calls.filter(([request]) => request.method === "agent")).toEqual(
      [],
    );
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
    mockRestoredRuns(() => [
      createSubagentRunRecord({
        runId: "run-active",
        childSessionKey: "agent:main:subagent:run-active",
        groupId: "logical-group",
        collect: true,
        schedulerSlotId: "slot-active",
        createdAt: now - 1_000,
        execution: { status: "running", startedAt: now - 1_000 },
      }),
      makeQueuedRun({ ...queuedRunOverrides, runId: "run-queued-one", createdAt: now }),
      makeQueuedRun({
        ...queuedRunOverrides,
        runId: "run-queued-two",
        createdAt: now + 1,
      }),
    ]);
    mocks.entries = {
      "agent:main:subagent:run-active": {
        sessionId: "session-active",
        updatedAt: now,
      },
      "agent:main:subagent:run-queued-one": { sessionId: "session-one", updatedAt: now },
      "agent:main:subagent:run-queued-two": { sessionId: "session-two", updatedAt: now },
    };
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent") {
        return { runId: "gateway-run-one" };
      }
      return request.method === "agent.wait" ? { status: "pending" } : {};
    });

    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);
    await hydrateAndActivateRegistry();
    await Promise.resolve();
    expect(mocks.callGateway.mock.calls.filter(([request]) => request.method === "agent")).toEqual(
      [],
    );

    suspension?.release();
    expect(releaseSwarmRun("slot-active")).toBe(true);
    await waitForFast(() => {
      const agentCalls = mocks.callGateway.mock.calls.filter(
        ([request]) => request.method === "agent",
      );
      expect(agentCalls).toHaveLength(1);
      expect(agentCalls[0]?.[0]).toMatchObject({
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
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "collector acceptance race",
          cleanup: "keep",
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
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            task: "terminal collector acceptance",
            cleanup: "keep",
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
    mockRestoredRuns,
  });

  registerRestoredRotationFailureTest({
    getRegistry: () => mod,
    mocks,
    hydrateAndActivateRegistry,
    mockSingleCollectorConcurrency,
    mockRestoredRuns,
  });

  it("retries restored collector session cleanup before announcing deletion", async () => {
    const now = Date.now();
    mockRestoredRuns(() => [
      makeQueuedRun({
        runId: "run-queued-cleanup-retry",
        childSessionKey: "agent:main:subagent:queued-cleanup-retry",
        swarmRequesterSessionKey: "agent:main:main",
        task: "retry failed cleanup",
        groupId: "restore-cleanup-retry",
        createdAt: now,
        queuedLaunch: {
          request: { sessionKey: "agent:main:subagent:queued-cleanup-retry" },
        },
      }),
    ]);
    mocks.entries = {
      "agent:main:subagent:queued-cleanup-retry": {
        lifecycleRevision: "revision-queued-cleanup-retry",
        sessionId: "queued-cleanup-retry",
        updatedAt: now,
      },
    };
    let deleteAttempts = 0;
    let releaseDelete: (() => void) | undefined;
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent") {
        throw new Error("launch failed");
      }
      if (request.method === "sessions.delete") {
        deleteAttempts += 1;
        if (deleteAttempts === 1) {
          throw new Error("delete unavailable");
        }
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
    expect(deleteAttempts).toBe(2);
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
      task: "resume after transport close",
    });

    await waitForFast(() => expect(findRequesterRun("run-interrupted-wait")).toBeDefined());
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
    const run = findRequesterRun("run-interrupted-wait");
    expect(run?.execution.endedAt).toBeUndefined();
    expect(run?.execution.outcome).toBeUndefined();
  });

  it("detaches subagent completion from a disposed requester transcript owner", async () => {
    const sessionKey = "agent:main:main";
    const activeGatewayContext = { recoveryRuntime } as never;
    await mod.activateSubagentRegistry(
      () =>
        ({
          recoveryRuntime,
          resolveGatewayContext: () => activeGatewayContext,
        }) as never,
    );
    let disposed = false;
    const pendingWait = createDeferred<Record<string, unknown>>();
    const waitStarted = createDeferred();
    const announceStarted = createDeferred();
    const requesterTranscriptWrite = vi.fn();
    const withRequesterTranscriptWrite = async <T>(operation: () => Promise<T> | T): Promise<T> => {
      requesterTranscriptWrite();
      if (disposed) {
        throw new Error("attempt disposed before transcript write");
      }
      return await operation();
    };
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

    await withOwnedSessionTranscriptWrites(
      { sessionKey, withTranscriptWrite: withRequesterTranscriptWrite },
      async () => {
        await mod.registerSubagentRun({
          runId: "run-detached-requester-owner",
          requesterSessionKey: sessionKey,
          task: "finish after the requester attempt exits",
          expectsCompletionMessage: true,
        });
        await waitStarted.promise;
      },
    );

    const settleRootWork = observeRootWork();
    disposed = true;
    pendingWait.resolve({ status: "ok", startedAt: 111, endedAt: 222 });
    await announceStarted.promise;
    await settleRootWork();

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
      task: "published timeout should stay stable",
      runTimeoutSeconds: 1,
    });

    await waitForFast(() =>
      expect(mocks.callGateway).toHaveBeenCalledWith(
        expect.objectContaining({ method: "agent.wait" }),
      ),
    );
    const activeRun = findRequesterRun(runId);
    expect(activeRun?.execution.endedAt).toBeUndefined();
    expect(activeRun?.execution.outcome).toBeUndefined();

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
    expect(
      mocks.callGateway.mock.calls.filter(([request]) => request.method === "agent.wait").length,
    ).toBeGreaterThanOrEqual(2);
    getLifecycleHandler()({
      runId,
      stream: "lifecycle",
      data: {
        phase: "end",
        startedAt: startedAt + 10,
        endedAt: startedAt + 500,
      },
    });
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
          mockRestoredRuns(() => [
            createSubagentRunRecord({
              runId,
              task: "resume near explicit timeout",
              runTimeoutSeconds: duration / 1_000,
              createdAt,
              startedAt: createdAt,
              sessionStartedAt: createdAt,
            }),
          ]);
          await hydrateAndActivateRegistry();
        } else {
          await mod.registerSubagentRun({
            runId,
            task: "honor explicit run deadline",
            runTimeoutSeconds: duration / 1_000,
          });
          if (source === "lifecycle") {
            getLifecycleHandler()({
              runId,
              stream: "lifecycle",
              data: {
                phase: "end",
                startedAt: createdAt,
                endedAt: createdAt + 2_000,
                aborted: true,
              },
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
      task: "honor observed session start deadline",
      runTimeoutSeconds: 60,
    });

    await waitForFast(() => {
      const run = findRequesterRun(runId);
      expect(waitAttempts).toBeGreaterThanOrEqual(1);
      expect(run?.execution.endedAt).toBeUndefined();
      expect(run?.execution.outcome).toBeUndefined();
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
      task: "new run after stale terminal row",
    });

    await waitForFast(() => {
      expect(waitAttempts).toBeGreaterThanOrEqual(2);
    });
    const activeRun = findRequesterRun("run-reactivated-timeout");
    expect(activeRun?.execution.endedAt).toBeUndefined();
    expect(activeRun?.execution.outcome).toBeUndefined();
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
        task: "collect through the wait observation",
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
        task: "preserve actual timeout",
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
        getLifecycleHandler()({ runId, stream: "lifecycle", data: { phase: "end", ...terminal } });
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
    "cancels pending abort grace when superseded by %s (#92448)",
    async (source) => {
      const runId = "run-after-pending-timeout";
      const waitResult = createDeferred<Record<string, unknown>>();
      if (source === "wait yield") {
        mockAgentWait(waitResult.promise);
      } else {
        mockPendingAgentWait();
      }
      await mod.registerSubagentRun({
        runId,
        childSessionKey: "agent:main:subagent:pending-timeout",
        task: "settle pending timeout grace",
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
        task: "report terminal failure",
        expectsCompletionMessage: true,
      });
      if (source === "lifecycle") {
        const lifecycleHandler = getLifecycleHandler();
        lifecycleHandler({ runId, stream: "lifecycle", data: { phase: "start", startedAt } });
        lifecycleHandler({
          runId,
          stream: "lifecycle",
          data: {
            phase: "end",
            startedAt,
            endedAt,
            livenessState: kind,
            ...(kind === "blocked" ? { error } : { replayInvalid: true }),
          },
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
      expect(findRequesterRun(runId)?.completion).toMatchObject({
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

  it.each(["late completion", "earlier deadline"] as const)(
    "reconciles stable operator cancellation against %s",
    async (source) => {
      const now = Date.now();
      const startedAt = now - 10_000;
      const killedAt = now - 1_000;
      const runId = "run-stable-cancellation";
      const childSessionKey = "agent:main:subagent:stable-cancellation";
      const earlierDeadline = source === "earlier deadline";
      mocks.entries = {
        [childSessionKey]: {
          ...(earlierDeadline ? {} : { lifecycleRevision: "revision-stable-cancellation" }),
          sessionId: "sess-stable-cancellation",
          updatedAt: now,
          status: earlierDeadline ? "killed" : "done",
          startedAt,
          endedAt: now,
        },
      };
      await mod.addSubagentRunForTests(
        makeKilledRun(killedAt, {
          runId,
          childSessionKey,
          task: "preserve authoritative cancellation outcome",
          killReconciliation: { killedAt, taskCancellationAccepted: true },
          expectsCompletionMessage: !earlierDeadline,
          createdAt: startedAt,
          startedAt,
          ...(earlierDeadline ? { runTimeoutSeconds: 8 } : { cleanup: "delete", archiveAtMs: now }),
        }),
      );
      vi.setSystemTime(killedAt + 5 * 60_000);
      await mod.testing.sweepOnceForTests();
      await waitForFast(() => {
        const run = findRequesterRun(runId);
        if (earlierDeadline) {
          const timeoutAt = now - 2_000;
          expect(run).toMatchObject({
            endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
            execution: {
              status: "terminal",
              endedAt: timeoutAt,
              outcome: { status: "timeout", startedAt, endedAt: timeoutAt },
            },
          });
          expect(run?.execution.outcome?.error).toBeUndefined();
        } else {
          expect(run).toBeUndefined();
          expect(mocks.callGateway).toHaveBeenCalledWith({
            method: "sessions.delete",
            params: {
              key: childSessionKey,
              deleteTranscript: true,
              emitLifecycleHooks: false,
              expectedLifecycleRevision: "revision-stable-cancellation",
              expectedSessionId: "sess-stable-cancellation",
            },
            timeoutMs: 10_000,
            assertDispatchCurrent: expect.any(Function),
            prepareDispatchCurrent: expect.any(Function),
          });
        }
      });
      if (!earlierDeadline) {
        expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
      }
    },
  );

  it("suppresses registry delivery when cancellation becomes durable during capture", async () => {
    const now = Date.now();
    const killedAt = now - 5 * 60_000;
    const startedAt = killedAt - 10_000;
    const completedAt = killedAt + 1_000;
    const runId = "run-cancelled-during-sweep-capture";
    const childSessionKey = "agent:main:subagent:cancelled-during-sweep-capture";
    const retirementWrites: string[][] = [];
    const publishedRows: SubagentRunRecord[] = [];
    mocks.persistRegistryRows.mockImplementation((runs, ids) => {
      const next = runs.get(runId);
      if (next) {
        publishedRows.push(structuredClone(next));
      } else if (ids.includes(runId)) {
        retirementWrites.push([...ids]);
      }
    });
    mocks.entries = {
      [childSessionKey]: {
        sessionId: "sess-cancelled-during-sweep-capture",
        updatedAt: completedAt,
        status: "done",
        startedAt,
        endedAt: completedAt,
      },
    };
    const captureEntered = createDeferred();
    const finishCapture = createDeferred<string>();
    mocks.captureSubagentCompletionReply.mockImplementationOnce(() => {
      captureEntered.resolve();
      return finishCapture.promise;
    });
    await mod.addSubagentRunForTests(
      makeKilledRun(killedAt, {
        runId,
        childSessionKey,
        task: "cancel during result capture",
        expectsCompletionMessage: false,
        createdAt: startedAt,
        startedAt,
      }),
    );

    expect(subagentRuns.has(runId)).toBe(true);
    const settleRootWork = observeRootWork();
    try {
      const sweep = mod.testing.sweepOnceForTests();
      await captureEntered.promise;
      await updateFixtureRun(runId, (next) => {
        expectDefined(
          next.killReconciliation,
          "cancelled run reconciliation",
        ).taskCancellationAccepted = true;
      });
      finishCapture.resolve("late provider result");
      await sweep;
    } finally {
      finishCapture.resolve("late provider result");
      // Sweep completion hands retirement to detached requester-settle work.
      await settleRootWork();
    }

    const terminal = expectDefined(publishedRows.at(-1), "last committed cancellation");
    expect(terminal).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      execution: {
        status: "terminal",
        endedAt: killedAt,
        outcome: { status: "error", error: "manual kill" },
      },
    });
    expect(terminal.completion?.resultText).toBeUndefined();
    expect(retirementWrites).toEqual([[runId]]);
    expect(subagentRuns.has(runId)).toBe(false);
    expect(findRequesterRun(runId)).toBeUndefined();
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
  });

  it("uses the kill time when reconciling a yielded run", async () => {
    const startedAt = Date.parse("2026-03-24T11:50:00Z");
    const yieldedAt = Date.parse("2026-03-24T11:59:00Z");
    const completedAt = Date.parse("2026-03-24T11:59:30Z");
    const killedAt = Date.parse("2026-03-24T12:00:00Z");
    const runId = "run-yielded-before-kill";
    const childSessionKey = "agent:main:subagent:yielded-before-kill";
    mocks.entries = {
      [childSessionKey]: {
        sessionId: "sess-yielded-before-kill",
        updatedAt: completedAt,
        status: "done",
        startedAt,
        endedAt: completedAt,
      },
    };
    await mod.addSubagentRunForTests({
      runId,
      childSessionKey,
      task: "complete between yield and kill",
      expectsCompletionMessage: false,
      createdAt: startedAt,
      startedAt,
      endedAt: yieldedAt,
      pauseReason: "sessions_yield",
      cleanupHandled: false,
    });

    vi.setSystemTime(killedAt);
    expect(await mod.markSubagentRunTerminated({ runId, reason: "manual kill" })).toBe(1);
    const killedRun = findRequesterRun(runId);
    expect(killedRun).toMatchObject({
      execution: { status: "terminal", endedAt: yieldedAt },
      cleanupCompletedAt: killedAt,
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
    });

    vi.setSystemTime(killedAt + 5 * 60_000);
    await mod.testing.sweepOnceForTests();

    await waitForFast(() => {
      const run = findRequesterRun(runId);
      expect(run).toMatchObject({
        endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
        execution: {
          status: "terminal",
          endedAt: completedAt,
          outcome: { status: "ok", startedAt, endedAt: completedAt },
        },
      });
    });
  });

  it("retires a reconciled tombstone without replaying requester stop delivery", async () => {
    const killedAt = Date.now() - 5 * 60_000;
    const startedAt = killedAt - 60_000;
    const runId = "run-retired-kill";
    const childSessionKey = "agent:main:subagent:requester-stop-suppressed";
    await mod.addSubagentRunForTests(
      makeKilledRun(killedAt, {
        runId,
        childSessionKey,
        task: "do not replay cancellation",
        expectsCompletionMessage: true,
        createdAt: startedAt,
        killReconciliation: { killedAt, suppressTaskDelivery: true },
      }),
    );
    await mod.testing.sweepOnceForTests();
    await waitForFast(() => expect(findRequesterRun(runId)).toBeUndefined());
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
  });

  it.each(["new completion", "new completion without start", "old completion"] as const)(
    "retires superseded tombstones without mutating the successor: %s",
    async (source) => {
      const oldStartedAt = Date.parse("2026-03-24T11:50:00Z");
      const killedAt = Date.parse("2026-03-24T11:55:00Z");
      const newStartedAt = Date.parse("2026-03-24T11:58:00Z");
      const endedAt = Date.parse(
        source === "old completion" ? "2026-03-24T11:56:00Z" : "2026-03-24T11:59:00Z",
      );
      const childSessionKey = "agent:main:subagent:reused";
      const runId = "run-old-tombstone";
      const newRunId = "run-new-generation";
      const withoutStart = source === "new completion without start";
      mocks.entries = {
        [childSessionKey]: {
          sessionId: "sess-reused",
          updatedAt: endedAt,
          status: "done",
          endedAt,
          ...(withoutStart
            ? {}
            : { startedAt: source === "old completion" ? oldStartedAt : newStartedAt }),
        },
      };
      const originalEntry = structuredClone(mocks.entries[childSessionKey]);
      if (!withoutStart) {
        mocks.getAgentRunContext.mockImplementation((id: string) =>
          id === newRunId ? ({} as never) : undefined,
        );
        mockEndedHooks();
      }
      let attachmentsRootDir: string | undefined;
      let attachmentsDir: string | undefined;
      const transcriptTarget = {
        agentId: "main",
        sessionId: "internal-run-old-tombstone",
        sessionKey: "agent:main:internal-session-effects:run-old-tombstone",
        storePath: "/tmp/test-store",
      };
      if (source === "new completion") {
        attachmentsRootDir = await fs.mkdtemp(
          path.join(os.tmpdir(), "openclaw-old-tombstone-attachments-"),
        );
        attachmentsDir = path.join(attachmentsRootDir, "child");
        await fs.mkdir(attachmentsDir, { recursive: true });
        await fs.writeFile(path.join(attachmentsDir, "artifact.txt"), "artifact");
      }
      await mod.addSubagentRunForTests(
        makeKilledRun(killedAt, {
          runId,
          childSessionKey,
          task: "old generation",
          createdAt: oldStartedAt,
          startedAt: oldStartedAt,
          ...(withoutStart
            ? { runTimeoutSeconds: 60 }
            : { cleanup: "delete", sessionStartedAt: oldStartedAt }),
          ...(source === "new completion"
            ? {
                archiveAtMs: Date.now(),
                retainAttachmentsOnKeep: true,
                attachmentsDir,
                attachmentsRootDir,
                execution: {
                  status: "terminal",
                  startedAt: oldStartedAt,
                  endedAt: killedAt,
                  transcriptTarget,
                },
              }
            : {}),
        }),
      );
      await mod.addSubagentRunForTests({
        runId: newRunId,
        childSessionKey,
        task: "new generation",
        createdAt: newStartedAt,
        startedAt: newStartedAt,
        ...(withoutStart ? { generation: 2 } : { sessionStartedAt: newStartedAt }),
      });
      await mod.testing.sweepOnceForTests();
      expect(findRequesterRun(runId)).toBeUndefined();
      if (withoutStart) {
        expect(resolveSubagentSessionStatus(subagentRuns.get(runId))).not.toBe("timeout");
        return;
      }
      const newRun = findRequesterRun(newRunId);
      expect(newRun).toBeDefined();
      expect(newRun?.execution.endedAt).toBeUndefined();
      expect(newRun?.execution.outcome).toBeUndefined();
      expect(mocks.runSubagentEnded).not.toHaveBeenCalled();
      expect(
        mocks.onSubagentEnded.mock.calls.some(
          ([params]) => params.childSessionKey === childSessionKey,
        ),
      ).toBe(false);
      expect(
        mocks.callGateway.mock.calls.some(([request]) => request.method === "sessions.delete"),
      ).toBe(false);
      if (source === "new completion") {
        expect(mocks.removeInternalSessionEffectsSession).toHaveBeenCalledWith(transcriptTarget);
        await expect(
          fs.access(expectDefined(attachmentsDir, "retained attachments")),
        ).resolves.toBeUndefined();
      } else {
        expect(mocks.entries[childSessionKey]).toEqual(originalEntry);
        expect(
          mocks.emitSessionLifecycleEvent.mock.calls.some(
            ([event]) => (event as { sessionKey?: string }).sessionKey === childSessionKey,
          ),
        ).toBe(false);
      }
    },
  );

  registerSupersededNativeTimingTest({ getRegistry: () => mod, mocks, mockPendingAgentWait });

  it("settles restart-aborted runs without redispatching child work", async () => {
    mockPendingAgentWait();
    mocks.entries = {
      "agent:main:subagent:child": createSessionEntry({
        updatedAt: Date.now(),
        status: "interrupted",
        abortedLastRun: true,
      }),
    };

    await mod.registerSubagentRun({
      runId: "run-stale-aborted",
      task: "resume after restart",
    });

    vi.setSystemTime(new Date("2026-03-24T12:02:00Z"));
    await mod.testing.sweepOnceForTests();

    expect(mocks.dispatchRecoveryAgent).not.toHaveBeenCalled();
    await waitForFast(() => expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledOnce());
    const run = findRequesterRun("run-stale-aborted");
    expect(run?.execution.endedAt).toBeTypeOf("number");
    expect(run?.execution.outcome).toMatchObject({
      status: "error",
      error: expect.stringContaining("Gateway restart"),
    });
  });

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
        task: "retry completion after transient failure",
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
        expect(run?.execution.endedAt).toBeUndefined();
        expect(run?.execution.outcome).toBeUndefined();
        expect(run?.endedReason).toBeUndefined();
      });
      expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
      return;
    }
    await waitForFast(() => {
      const run = findRequesterRun(runId);
      expect(run?.endedReason).toBe("subagent-killed");
      expect(run?.execution.outcome?.status).toBe("error");
      expect(run?.suppressAnnounceReason).toBe("killed");
    });
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();

    await mod.testing.sweepOnceForTests();
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
      await waitForFast(() =>
        expect(
          mod
            .listSubagentRunsForRequester("agent:main:main")
            .some((entry) => entry.runId === runId),
        ).toBe(false),
      );
      await vi.advanceTimersByTimeAsync(20_000);
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    }
  });

  it("suppresses stale timeout announces when the same child run later finishes successfully", async () => {
    mockPendingAgentWait();

    await mod.registerSubagentRun({
      runId: "run-timeout-then-ok",
      task: "timeout retry",
      expectsCompletionMessage: true,
    });

    const lifecycleHandler = getLifecycleHandler();

    lifecycleHandler?.({
      runId: "run-timeout-then-ok",
      stream: "lifecycle",
      data: { phase: "end", endedAt: 1_000, aborted: true },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(14_999);
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();

    lifecycleHandler?.({
      runId: "run-timeout-then-ok",
      stream: "lifecycle",
      data: {
        phase: "end",
        endedAt: 1_250,
        terminalReply: { disposition: "visible", text: "Finished successfully." },
      },
    });

    await waitForFast(() => {
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    });
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        childRunId: "run-timeout-then-ok",
        outcome: expect.objectContaining({ status: "ok", endedAt: 1_250 }),
      }),
    );

    await vi.advanceTimersByTimeAsync(20_000);
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
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
      task: "completion cleanup retry",
      cleanup: "delete",
      expectsCompletionMessage: true,
    });

    await vi.advanceTimersByTimeAsync(0);
    await settleRootWork(true);
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    expect(
      mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-delete-give-up"),
    ).toEqual(expect.objectContaining({ runId: "run-delete-give-up", cleanup: "delete" }));

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

  it("retries completion delete runs regardless of prior attempt count", async () => {
    mockEndedHooks();
    const runId = "run-resume-delete";
    const task = "resume delete retry budget";
    const endedAt = Date.parse("2026-03-24T11:59:30Z");
    const restored = createSubagentRunRecord({
      runId,
      task,
      cleanup: "delete",
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
    expect(findRequesterRun(runId)).toBeUndefined();
  });

  it("finalizes expired delete-mode parents when descendant cleanup retriggers deferred announce handling", async () => {
    mocks.entries = {
      "agent:main:subagent:parent": {
        lifecycleRevision: "revision-parent",
        sessionId: "sess-parent",
        updatedAt: 1,
      },
      "agent:main:subagent:child": {
        lifecycleRevision: "revision-child",
        sessionId: "sess-child",
        updatedAt: 1,
      },
    };

    await mod.addSubagentRunForTests({
      runId: "run-parent-expired",
      childSessionKey: "agent:main:subagent:parent",
      task: "expired parent cleanup",
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
        task: "descendant settles",
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

    await mod.registerSubagentRun({
      runId: "run-killed-init",
      childSessionKey: "agent:main:subagent:killed",
      requesterOrigin: { channel: "quietchat", accountId: "acct-1" },
      task: "kill after init",
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
    vi.setSystemTime(killedAt + 5 * 60_000);
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
  });

  it("announces readable failure when an interrupted run is finalized", async () => {
    const error =
      "Subagent run was interrupted by a gateway restart or connection loss. Automatic recovery failed after 2 attempts. Please retry.";
    const outcome = { status: "error", error, startedAt: 1, endedAt: 2, elapsedMs: 1 };
    const finalize = () =>
      mod.finalizeInterruptedSubagentRun({ runId: "run-interrupted", error, endedAt: 2 });
    await mod.addSubagentRunForTests({
      runId: "run-interrupted",
      childSessionKey: "agent:main:subagent:interrupted",
      controllerSessionKey: "agent:main:main",
      requesterOrigin: { channel: "quietchat", accountId: "acct-interrupted" },
      task: "recover interrupted subagent",
      expectsCompletionMessage: true,
      spawnMode: "run",
      createdAt: 1,
      startedAt: 1,
      sessionStartedAt: 1,
      accumulatedRuntimeMs: 0,
      cleanupHandled: false,
    });

    expect(await finalize()).toBe(1);
    await waitForFast(() =>
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          childRunId: "run-interrupted",
          requesterSessionKey: "agent:main:main",
          requesterOrigin: { channel: "quietchat", accountId: "acct-interrupted" },
          outcome: expect.objectContaining({ status: "error", error }),
        }),
      ),
    );
    const run = findRequesterRun("run-interrupted");
    expect(run?.execution.outcome).toEqual(outcome);
    expect(run?.terminalOwner).toBe("interrupted-recovery");
    expect(run?.cleanupCompletedAt).toBeTypeOf("number");

    const announceCalls = mocks.runSubagentAnnounceFlow.mock.calls.length;
    await expect(finalize()).resolves.toBe(1);
    const repeated = findRequesterRun("run-interrupted");
    expect(repeated?.terminalOwner).toBe("interrupted-recovery");
    expect(repeated?.execution.outcome).toEqual(outcome);
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(announceCalls);
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
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "preserve existing terminal evidence",
        cleanup: "keep" as const,
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
        controllerSessionKey: "agent:main:session:parent",
        requesterSessionKey: "agent:main:session:parent",
        requesterDisplayKey: "parent",
        task: `${kind} cleanup`,
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

    await mod.testing.sweepOnceForTests();

    await waitForFast(() => {
      for (const kind of kinds) {
        expect(mocks.resolveContextEngine).toHaveBeenCalledWith(mocks.getRuntimeConfig(), {
          agentDir: `/tmp/agent-${kind}`,
          workspaceDir: `/tmp/workspace-${kind}`,
          initialize: mocks.ensureContextEnginesInitialized,
        });
      }
    });
  });

  it("does not emit ended hooks before suspended delete retirement is durable", async () => {
    const now = Date.parse("2026-03-24T12:00:00Z");
    const runId = "run-suspended-delete-persist-failure";
    const childSessionKey = "agent:main:subagent:suspended-delete-persist-failure";
    mockEndedHooks();
    await mod.addSubagentRunForTests(
      makeSuspendedDeliveryRun({
        runId,
        childSessionKey,
        controllerSessionKey: "agent:main:main",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "discard suspended delete delivery",
        cleanup: "delete",
        spawnMode: "run",
        createdAt: now - 8 * 24 * 60 * 60_000,
        endedAt: now - 8 * 24 * 60 * 60_000,
        delivery: {
          lastAttemptAt: now - 7 * 24 * 60 * 60_000 - 1,
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
  });

  it("retains a run after session read failure and completes it on a later sweep", async () => {
    const childSessionKey = "agent:main:subagent:child";
    const startedAt = Date.now() - 2_000;
    mockPendingAgentWait();
    await mod.registerSubagentRun({
      runId: "run-sweep-error",
      task: "sweep error",
      cleanup: "delete",
    });
    const run = expectDefined(
      await mod.getSubagentRunByChildSessionKey(childSessionKey),
      "registered run",
    );
    await updateFixtureRun(run.runId, (next) => {
      next.execution.startedAt = startedAt;
    });
    const execution = structuredClone(mod.getSubagentRunByRunId(run.runId)?.execution);
    mocks.loadSessionEntry.mockClear().mockImplementation(() => {
      throw new Error("simulated sweep failure");
    });

    await mod.testing.sweepOnceForTests();
    await mod.testing.runSweeperTickForTests();

    expect(mocks.loadSessionEntry).toHaveBeenCalled();
    expect((await mod.getSubagentRunByChildSessionKey(childSessionKey))?.execution).toEqual(
      execution,
    );
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();

    mocks.loadSessionEntry.mockReset();
    mocks.entries[childSessionKey] = createSessionEntry({
      lifecycleRevision: "revision-child",
      status: "done",
      startedAt,
      endedAt: Date.now(),
      updatedAt: Date.now(),
    });
    vi.setSystemTime(Date.now() + 1_000);
    await mod.testing.sweepOnceForTests();

    await waitForFast(() =>
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledWith(
        expect.objectContaining({
          childRunId: "run-sweep-error",
          outcome: expect.objectContaining({ status: "ok" }),
        }),
      ),
    );
    expect(mocks.entries[childSessionKey]?.status).toBe("done");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
