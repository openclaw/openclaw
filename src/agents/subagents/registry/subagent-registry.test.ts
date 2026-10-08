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
} from "../../../process/gateway-work-admission.js";
import { listSessionStateEventsSince } from "../../../sessions/session-state-events.js";
vi.mocked(cleanupBrowserSessionsForLifecycleEnd).mockReset();
import { buildAgentRunTerminalOutcomeFromLifecycleEvent } from "../../agent-run-terminal-outcome.js";
import type { SubagentRegistryHarness } from "../../subagent-test-fixtures.test-helpers.js";
import {
  configureMockSubagentRegistryPersistence,
  createSessionEntry,
  createSessionStore,
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
import { resolveFinalizedSubagentTaskState } from "./subagent-registry-completion.js";
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
  // Read the child's signal log the way sessions.status does: its whole
  // `stateChanges` block comes from listSessionStateEventsSince, so this is the
  // observer-visible projection rather than a spy on the producer call.
  const observerTerminalSignals = (runId: string) =>
    listSessionStateEventsSince("agent:main:subagent:child", "main", 0, 200)
      .events.filter(
        (event) =>
          event.runId === runId && (event.kind === "run_failed" || event.kind === "run_completed"),
      )
      .map((event) => ({
        kind: event.kind,
        summary: event.summary,
        outcome: (event.payload as { outcome?: string } | undefined)?.outcome,
      }));
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

  it("keeps an unconfirmed collector group alive until stop evidence promotes the child", async () => {
    const now = Date.now();
    mocks.getRuntimeConfig.mockReturnValue({
      agents: { defaults: { subagents: { archiveAfterMinutes: 1 } } },
      session: { mainKey: "main", scope: "per-sender", store: mocks.resolveStorePath() },
    });
    mocks.entries = createSessionStore(
      {
        lifecycleRevision: "revision-unconfirmed-collector",
        sessionId: "session-unconfirmed-collector",
        status: "running",
        updatedAt: now,
      },
      "agent:main:subagent:collector-unconfirmed",
    );
    mod.addSubagentRunForTests(
      makeCompletedCollectorRun({
        runId: "run-collector-confirmed",
        childSessionKey: "agent:main:subagent:collector-confirmed",
        task: "completed sibling",
        createdAt: now - 10_000,
        endedAt: now - 5_000,
        archiveAtMs: now - 1,
        groupId: "swarm:unconfirmed-member",
      }),
    );
    mod.addSubagentRunForTests(
      makeCompletedCollectorRun({
        runId: "run-collector-unconfirmed",
        childSessionKey: "agent:main:subagent:collector-unconfirmed",
        task: "still-running collector",
        createdAt: now - 10_000,
        endedAt: now - 5_000,
        outcome: { status: "timeout", timeoutDisposition: "child-unconfirmed" },
        archiveAtMs: now - 1,
        groupId: "swarm:unconfirmed-member",
      }),
    );

    await mod.testing.sweepOnceForTests();

    expect(mod.getSubagentRunByRunId("run-collector-confirmed")).toBeDefined();
    const unconfirmed = mod.getSubagentRunByRunId("run-collector-unconfirmed");
    expect(unconfirmed).toBeDefined();
    expect(unconfirmed?.collectorCompletion).toBeUndefined();
    expect(unconfirmed?.archiveAtMs).toBeUndefined();
    expect(
      mocks.callGateway.mock.calls.filter(([request]) => request.method === "sessions.delete"),
    ).toHaveLength(0);

    mocks.entries = createSessionStore(
      {
        lifecycleRevision: "revision-unconfirmed-collector",
        sessionId: "session-unconfirmed-collector",
        status: "done",
        updatedAt: now + 1_000,
        endedAt: now + 1_000,
      },
      "agent:main:subagent:collector-unconfirmed",
    );
    vi.setSystemTime(now + 2_000);
    await mod.testing.sweepOnceForTests();

    expect(mod.getSubagentRunByRunId("run-collector-unconfirmed")?.collectorCompletion).toEqual({
      status: "done",
    });

    vi.setSystemTime(now + 62_000);
    await mod.testing.sweepOnceForTests();
    expect(mod.getSubagentRunByRunId("run-collector-confirmed")).toBeUndefined();
    expect(mod.getSubagentRunByRunId("run-collector-unconfirmed")).toBeUndefined();
    const deleteCalls = mocks.callGateway.mock.calls.filter(
      ([request]) => request.method === "sessions.delete",
    );
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]?.[0]).toMatchObject({
      method: "sessions.delete",
      params: {
        key: "agent:main:subagent:collector-unconfirmed",
        expectedSessionId: "session-unconfirmed-collector",
        expectedLifecycleRevision: "revision-unconfirmed-collector",
      },
    });
  });

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

    await hydrateAndActivateRegistry();
    await Promise.resolve();
    expect(mocks.callGateway.mock.calls.filter(([request]) => request.method === "agent")).toEqual(
      [],
    );

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

  it("publishes expiry at explicit runTimeoutSeconds without terminalizing a bare wait", async () => {
    const startedAt = Date.now();
    let waitAttempts = 0;
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        waitAttempts += 1;
        return { status: "timeout" };
      }
      return {};
    });
    mocks.entries = {
      "agent:main:subagent:child": createSessionEntry({
        updatedAt: startedAt,
        status: "running",
      }),
    };

    await mod.registerSubagentRun({
      runId: "run-explicit-timeout",
      task: "respect explicit timeout",
      runTimeoutSeconds: 1,
    });

    await waitForFast(() => {
      expect(waitAttempts).toBeGreaterThanOrEqual(1);
    });
    const activeRun = findRequesterRun("run-explicit-timeout");
    expect(activeRun?.execution.endedAt).toBeUndefined();
    expect(activeRun?.execution.outcome).toBeUndefined();

    await vi.advanceTimersByTimeAsync(5_000);

    await waitForFast(() => {
      const completedRun = findRequesterRun("run-explicit-timeout");
      expect(waitAttempts).toBeGreaterThanOrEqual(2);
      expect(completedRun?.execution.endedAt).toBeUndefined();
      expect(completedRun?.execution.outcome).toBeUndefined();
      expect(completedRun?.waitExpiryObservedAt).toBe(startedAt + 1_000);
    });
    await waitForFast(() => {
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps a delete-cleanup child session alive when only the wait deadline expired", async () => {
    const startedAt = Date.now();
    let waitAttempts = 0;
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        waitAttempts += 1;
        return { status: "timeout" };
      }
      return {};
    });
    mocks.entries = createSessionStore({
      updatedAt: startedAt,
      status: "running",
      sessionId: "sess-unconfirmed",
      lifecycleRevision: "rev-unconfirmed",
    });

    await mod.registerSubagentRun({
      runId: "run-unconfirmed-delete-cleanup",
      task: "unconfirmed child keeps its session",
      cleanup: "delete",
      runTimeoutSeconds: 1,
    });

    await waitForFast(() => {
      expect(waitAttempts).toBeGreaterThanOrEqual(1);
    });
    await vi.advanceTimersByTimeAsync(5_000);

    await waitForFast(() => {
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    });
    // Regression (openclaw-kkv1 round 1): completing on the stored deadline
    // observed nothing, so the child may still be running. Handing the announce
    // cleanup: "delete" would submit sessions.delete with deleteTranscript for a
    // live session — the announce itself says the child may still be working.
    const announceParams = getMockCallArg(
      mocks.runSubagentAnnounceFlow,
      0,
      0,
      "unconfirmed announce params",
    );
    expect(announceParams.cleanup).toBe("keep");
    expect(announceParams.onBeforeDeleteChildSession).toBeUndefined();
    const deleteCalls = () =>
      mocks.callGateway.mock.calls.filter(([request]) => request.method === "sessions.delete");
    expect(deleteCalls()).toHaveLength(0);
    // Deferred, not cancelled. The row keeps cleanup: "delete" so the real mode
    // is restored the moment a stop is observed.
    const completedRun = findRequesterRun("run-unconfirmed-delete-cleanup");
    expect(completedRun?.cleanup).toBe("delete");
    expect(completedRun?.waitExpiryObservedAt).toEqual(expect.any(Number));
    // Regression (openclaw-odqn round 2, finding 2): this config sets
    // archiveAfterMinutes: 0, the documented no-auto-archive opt-out. Round 1
    // overrode it with a 60-minute floor so the deferred deletion would have an
    // owner; that turned a documented opt-out into a blind deletion timer. The
    // owner is observed stop evidence, never a clock, so zero stays zero.
    expect(completedRun?.archiveAtMs).toBeUndefined();
    // The child's own session entry must not have been stamped terminal by our
    // guess either — it is the only independent record of the child's liveness.
    expect(mocks.applySessionEntryExactReplacements).not.toHaveBeenCalled();

    expect(mocks.getAgentRunContext("run-unconfirmed-delete-cleanup")).toBeUndefined();
    // Long past any retention window, with the child session still reporting
    // running: no clock may delete it, and the row must survive so a later
    // observed stop can still settle it.
    vi.setSystemTime(startedAt + 1_000 + 61 * 60_000);
    await mod.testing.sweepOnceForTests();
    expect(deleteCalls()).toHaveLength(0);
    expect(findRequesterRun("run-unconfirmed-delete-cleanup")?.execution).toMatchObject({
      status: "running",
    });
    expect(findRequesterRun("run-unconfirmed-delete-cleanup")?.execution.endedAt).toBeUndefined();
    expect(mocks.cleanupBrowserSessionsForLifecycleEnd).not.toHaveBeenCalled();

    // The child finally records its own stop. That is authoritative evidence,
    // so the sweeper promotes the row and the deferred cleanup completes.
    mocks.entries = createSessionStore({
      updatedAt: startedAt + 1_000 + 62 * 60_000,
      endedAt: startedAt + 1_000 + 62 * 60_000,
      status: "done",
      sessionId: "sess-unconfirmed",
      lifecycleRevision: "rev-unconfirmed",
    });
    vi.setSystemTime(startedAt + 1_000 + 63 * 60_000);
    await mod.testing.sweepOnceForTests();
    // Promotion re-opens the cleanup that was withheld, so the delete-mode row
    // settles and retires, and the terminal tails that never ran for the
    // unconfirmed row finally run against the observed stop.
    await waitForFast(() => {
      expect(findRequesterRun("run-unconfirmed-delete-cleanup")).toBeUndefined();
      expect(mocks.onSubagentEnded).toHaveBeenCalled();
    });
    // The child's session entry gets its real terminal timing only now, from an
    // observed stop rather than from our own deadline guess.
    expect(mocks.applySessionEntryExactReplacements).toHaveBeenCalled();
    // The actual completion must follow the provisional wake.
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(2);
  });

  it("routes a private child's provisional wait-expiry wake by its completion target", async () => {
    const startedAt = Date.now();
    let waitAttempts = 0;
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        waitAttempts += 1;
        return { status: "timeout" };
      }
      return {};
    });
    mocks.entries = createSessionStore({
      updatedAt: startedAt,
      status: "running",
    });

    await mod.registerSubagentRun({
      runId: "run-unconfirmed-private-child",
      task: "private child keeps its provisional wake parent-only",
      expectsCompletionMessage: true,
      completionTarget: "parent",
      completionRequesterSessionId: "sess-private-parent",
      runTimeoutSeconds: 1,
    });

    await waitForFast(() => {
      expect(waitAttempts).toBeGreaterThanOrEqual(1);
    });
    await vi.advanceTimersByTimeAsync(5_000);

    await waitForFast(() => {
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    });
    // A parent-only child must have completion notifications on, so the
    // producer's collect/expectsCompletionMessage skip cannot exclude it. The
    // terminal producers forward the private-completion fields; the provisional
    // wake has to as well or the still-running notice takes the public route.
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryPhase: "wait-expiry",
        outcome: { status: "timeout", disposition: "still-running" },
        completionTarget: "parent",
        completionRequesterSessionId: "sess-private-parent",
      }),
    );
  });

  it("runs no terminal cleanup tails for an unconfirmed child until an observed stop promotes it", async () => {
    // Regression (openclaw-odqn round 2, finding 1): round 1 only withheld
    // sessions.delete. Cleanup bookkeeping still tore down internal session
    // effects, retired the child's MCP runtime, stamped a terminal status onto
    // the child's session entry, and reported the child completed to the
    // context engine — all against a child the announce says may still be live.
    const startedAt = Date.now();
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return { status: "timeout" };
      }
      return {};
    });
    mocks.entries = createSessionStore({
      updatedAt: startedAt,
      status: "running",
      sessionId: "sess-no-tails",
      lifecycleRevision: "rev-no-tails",
    });

    await mod.registerSubagentRun({
      runId: "run-unconfirmed-no-tails",
      task: "unconfirmed child runs no terminal tails",
      cleanup: "keep",
      runTimeoutSeconds: 1,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await waitForFast(() => {
      expect(findRequesterRun("run-unconfirmed-no-tails")?.waitExpiryObservedAt).toEqual(
        expect.any(Number),
      );
    });
    // The parent still gets woken — that is the point of completing the row.
    await waitForFast(() => {
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    });
    // …but nothing the child owns may be torn down yet.
    expect(mocks.removeInternalSessionEffectsSession).not.toHaveBeenCalled();
    expect(mocks.onSubagentEnded).not.toHaveBeenCalled();
    expect(mocks.applySessionEntryExactReplacements).not.toHaveBeenCalled();

    // An observed stop promotes the row, and only then do the tails run.
    mocks.entries = createSessionStore({
      updatedAt: startedAt + 30_000,
      endedAt: startedAt + 30_000,
      status: "done",
      sessionId: "sess-no-tails",
      lifecycleRevision: "rev-no-tails",
    });
    vi.setSystemTime(startedAt + 40_000);
    await mod.testing.sweepOnceForTests();

    await waitForFast(() => {
      expect(mocks.onSubagentEnded).toHaveBeenCalled();
    });
    expect(mocks.removeInternalSessionEffectsSession).toHaveBeenCalled();
  });

  it("publishes no durable terminal signal for an unconfirmed child until an observed stop promotes it", async () => {
    // Regression (openclaw-odqn round 3): the terminal-signal projection sits
    // BEFORE the deferred-cleanup guard round 2 added, so an unconfirmed expiry
    // still recorded a durable `run_failed` / "child run timed out" event. The
    // signal log inserts on a `run-terminal:<runId>` dedupe key with
    // conflict-do-nothing, so that first write is permanent: authoritative
    // promotion afterwards cannot replace it, and an observer keeps being told a
    // possibly-live child died. This reads back through
    // listSessionStateEventsSince — the single source sessions.status uses to
    // build its `stateChanges` block — so it asserts the observer surface, not
    // just the producer call.
    const startedAt = Date.now();
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return { status: "timeout" };
      }
      return {};
    });
    mocks.entries = createSessionStore({
      updatedAt: startedAt,
      status: "running",
      sessionId: "sess-terminal-signal",
      lifecycleRevision: "rev-terminal-signal",
    });

    await mod.registerSubagentRun({
      runId: "run-unconfirmed-terminal-signal",
      task: "unconfirmed child publishes no terminal signal",
      cleanup: "keep",
      runTimeoutSeconds: 1,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await waitForFast(() => {
      expect(findRequesterRun("run-unconfirmed-terminal-signal")?.waitExpiryObservedAt).toEqual(
        expect.any(Number),
      );
    });
    // The parent is still woken; only the durable death claim is withheld.
    await waitForFast(() => {
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    });
    expect(observerTerminalSignals("run-unconfirmed-terminal-signal")).toEqual([]);

    // The child records its own stop. That is authoritative evidence, so
    // promotion re-drives the withheld terminal effects — including this
    // projection, whose claim is now earned rather than guessed.
    mocks.entries = createSessionStore({
      updatedAt: startedAt + 30_000,
      endedAt: startedAt + 30_000,
      status: "done",
      sessionId: "sess-terminal-signal",
      lifecycleRevision: "rev-terminal-signal",
    });
    vi.setSystemTime(startedAt + 40_000);
    await mod.testing.sweepOnceForTests();

    // This half is also the anti-vacuity control: it proves the signal log is
    // live and readable in this harness, so the empty assertion above is a real
    // absence rather than an unreachable database.
    await waitForFast(() => {
      expect(observerTerminalSignals("run-unconfirmed-terminal-signal")).toEqual([
        { kind: "run_completed", summary: "child run completed", outcome: undefined },
      ]);
    });
  });

  it("emits no terminal plugin hooks for an unconfirmed child and exactly one of each after promotion", async () => {
    // Regression (openclaw-odqn round 4): the deferral covered the durable
    // signal-log record and the session writes, but the two plugin-visible
    // terminal projections still ran for a `child-unconfirmed` row. Both are
    // unrepeatable, so a premature emit is not merely early — it is final:
    // `subagent_ended` persists `endedHookEmittedAt` (exactly-once), and
    // `progress ended` latches once per entry (progressEndedEntries). Channel plugins
    // also act on `subagent_ended` destructively (Discord unbinds the child's
    // thread bindings, Feishu its session binding), so the false emit tears
    // down routing for a child that may still be live. These assertions run
    // against the real hook-runner boundary the plugins subscribe to.
    const startedAt = Date.now();
    const runSubagentProgress = vi.fn<(event: { phase?: string; runId?: string }) => Promise<void>>(
      async () => {},
    );
    mocks.getGlobalHookRunner.mockReturnValue({
      hasHooks: (hookName: string) =>
        hookName === "subagent_ended" || hookName === "subagent_progress",
      runSubagentEnded: mocks.runSubagentEnded,
      runSubagentProgress,
    } as never);
    const endedProgressPhases = () =>
      runSubagentProgress.mock.calls.filter(
        ([event]) => event.phase === "ended" && event.runId === "run-unconfirmed-terminal-hooks",
      );
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return { status: "timeout" };
      }
      return {};
    });
    mocks.entries = createSessionStore({
      updatedAt: startedAt,
      status: "running",
      sessionId: "sess-terminal-hooks",
      lifecycleRevision: "rev-terminal-hooks",
    });

    await mod.registerSubagentRun({
      runId: "run-unconfirmed-terminal-hooks",
      task: "unconfirmed child emits no terminal plugin hooks",
      cleanup: "keep",
      runTimeoutSeconds: 1,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await waitForFast(() => {
      expect(findRequesterRun("run-unconfirmed-terminal-hooks")?.waitExpiryObservedAt).toEqual(
        expect.any(Number),
      );
    });
    // The parent is still woken — the announce is the notification that the
    // wait ended, and it is deliberately NOT deferred.
    await waitForFast(() => {
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    });
    expect(mocks.runSubagentEnded).not.toHaveBeenCalled();
    expect(endedProgressPhases()).toEqual([]);
    expect(findRequesterRun("run-unconfirmed-terminal-hooks")?.endedHookEmittedAt).toBeUndefined();

    // The child records its own stop. That is authoritative evidence, so
    // promotion reopens cleanup and the withheld hooks finally fire — each
    // exactly once, because neither unrepeatable marker was consumed early.
    mocks.entries = createSessionStore({
      updatedAt: startedAt + 30_000,
      endedAt: startedAt + 30_000,
      status: "done",
      sessionId: "sess-terminal-hooks",
      lifecycleRevision: "rev-terminal-hooks",
    });
    vi.setSystemTime(startedAt + 40_000);
    await mod.testing.sweepOnceForTests();

    // This half is also the anti-vacuity control: it proves both hooks are
    // genuinely reachable in this harness, so the absences above are real.
    await waitForFast(() => {
      expect(mocks.runSubagentEnded).toHaveBeenCalledTimes(1);
      expect(endedProgressPhases()).toHaveLength(1);
    });
    const endedHookEvents = mocks.runSubagentEnded.mock.calls as unknown as ReadonlyArray<
      readonly [{ targetSessionKey?: string; outcome?: string }]
    >;
    expect(endedHookEvents[0]?.[0]?.targetSessionKey).toBe("agent:main:subagent:child");
    expect(typeof findRequesterRun("run-unconfirmed-terminal-hooks")?.endedHookEmittedAt).toBe(
      "number",
    );
  });

  it("keeps an unconfirmed child nonterminal in the registry and promotes it to succeeded", async () => {
    // Regression (openclaw-odqn round 5, finding 1): a deadline-only wait expiry
    // must not project a terminal status for the child. A terminal `timeout`
    // would make the child's later observed success unrepresentable and leave a
    // still-running child permanently reported as dead. Asserted through the
    // registry's own read projections (session status and the finalized
    // terminal-state boundary), not through a spy on a write.
    const startedAt = Date.now();
    const runId = "run-unconfirmed-terminal-state";
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return { status: "timeout" };
      }
      return {};
    });
    mocks.entries = createSessionStore({
      updatedAt: startedAt,
      status: "running",
      sessionId: "sess-terminal-state",
      lifecycleRevision: "rev-terminal-state",
    });

    await mod.registerSubagentRun({
      runId,
      task: "unconfirmed child keeps a nonterminal state",
      cleanup: "keep",
      runTimeoutSeconds: 1,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await waitForFast(() => {
      expect(findRequesterRun(runId)?.waitExpiryObservedAt).toEqual(expect.any(Number));
    });
    // The parent is still woken; the announce is deliberately not deferred.
    await waitForFast(() => {
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    });

    // What a parent reads must not claim the child died. `running` is the
    // truthful answer: the wait ended, the child did not.
    const provisional = findRequesterRun(runId);
    expect(provisional?.execution.endedAt).toBeUndefined();
    expect(provisional?.execution.outcome).toBeUndefined();
    expect(resolveSubagentSessionStatus(provisional)).toBe("running");
    expect(provisional && resolveFinalizedSubagentTaskState(provisional)).toBeUndefined();

    // The child's own record turns out to say it finished *successfully*,
    // 100ms before the deadline the wait expired on. The deadline was a clock
    // comparison, so the wait simply never saw the stop. Publishing a terminal
    // timeout above would have made this success unrepresentable forever. (A
    // stop observed *after* the deadline still promotes to `timeout` —
    // truthfully; that path is covered by the late-lifecycle-timeout case.)
    mocks.entries = createSessionStore({
      updatedAt: startedAt + 900,
      endedAt: startedAt + 900,
      status: "done",
      sessionId: "sess-terminal-state",
      lifecycleRevision: "rev-terminal-state",
    });
    vi.setSystemTime(startedAt + 40_000);
    await mod.testing.sweepOnceForTests();

    // Anti-vacuity control: the promotion must actually land as a success. It
    // can only do so because nothing published a terminal timeout first.
    await waitForFast(() => {
      const promoted = findRequesterRun(runId);
      expect(promoted?.execution.outcome?.status).toBe("ok");
      expect(resolveSubagentSessionStatus(promoted)).toBe("done");
    });
  });

  it("retains an unconfirmed child whose session snapshot is absent and retires it on an observed stop", async () => {
    // Regression (openclaw-odqn round 5, finding 2): the sweeper deferred only
    // while the child's session entry said `running`. An `absent` entry fell
    // through to TTL deletion plus attachment removal — but the entry is
    // best-effort and reads absent when the store is unreadable, not yet
    // written, or simply missing, so absence is not evidence of a stop. Fail
    // closed: retain and retry until something observed the child stop.
    const startedAt = Date.now();
    const runId = "run-unconfirmed-absent-session";
    const deleteCalls = () =>
      mocks.callGateway.mock.calls.filter(([request]) => request.method === "sessions.delete");
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return { status: "timeout" };
      }
      return {};
    });
    mocks.entries = createSessionStore({
      updatedAt: startedAt,
      status: "running",
      sessionId: "sess-absent",
      lifecycleRevision: "rev-absent",
    });

    await mod.registerSubagentRun({
      runId,
      task: "unconfirmed child with a vanishing session entry",
      // delete-mode is what makes the row reach retention teardown at all; a
      // keep-mode row would be retained for unrelated reasons.
      cleanup: "delete",
      runTimeoutSeconds: 1,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await waitForFast(() => {
      expect(findRequesterRun(runId)?.waitExpiryObservedAt).toEqual(expect.any(Number));
    });

    // The child's session entry is now unreadable. Nothing has been observed to
    // stop it, so no clock past SESSION_RUN_TTL_MS may retire it.
    mocks.entries = {};
    vi.setSystemTime(startedAt + 61 * 60_000);
    await mod.testing.sweepOnceForTests();
    expect(findRequesterRun(runId)).toBeDefined();
    expect(deleteCalls()).toHaveLength(0);

    // Still absent much later: retain and retry, never a bounded give-up. A
    // clock-based escape here would reintroduce exactly the bug this PR fixes.
    vi.setSystemTime(startedAt + 180 * 60_000);
    await mod.testing.sweepOnceForTests();
    expect(findRequesterRun(runId)).toBeDefined();
    expect(deleteCalls()).toHaveLength(0);

    // Anti-vacuity control: the entry reappears with the child's own terminal
    // record. That is stop evidence, so the row promotes and finally retires —
    // proving retention is gated on evidence, not disabled.
    mocks.entries = createSessionStore({
      updatedAt: startedAt + 181 * 60_000,
      endedAt: startedAt + 181 * 60_000,
      status: "done",
      sessionId: "sess-absent",
      lifecycleRevision: "rev-absent",
    });
    vi.setSystemTime(startedAt + 182 * 60_000);
    await mod.testing.sweepOnceForTests();
    await waitForFast(() => {
      expect(findRequesterRun(runId)).toBeUndefined();
    });
  });

  it("skips silent-cleanup session deletion for an unconfirmed child but keeps it for an observed stop", async () => {
    const sessionStore = () =>
      createSessionStore({
        updatedAt: Date.now(),
        status: "running",
        sessionId: "sess-silent",
        lifecycleRevision: "rev-silent",
      });
    const deleteCalls = () =>
      mocks.callGateway.mock.calls.filter(([request]) => request.method === "sessions.delete");

    // The silent path (expectsCompletionMessage: false) submits sessions.delete
    // itself rather than delegating to the announce flow, so it needs its own
    // coverage. Both identities are present, so a skipped delete can only come
    // from the disposition — see the observed-stop half below.
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return { status: "timeout" };
      }
      return {};
    });
    mocks.entries = sessionStore();
    await mod.registerSubagentRun({
      runId: "run-unconfirmed-silent-cleanup",
      task: "unconfirmed silent cleanup",
      cleanup: "delete",
      expectsCompletionMessage: false,
      runTimeoutSeconds: 1,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    // Settled either way: the fix keeps the row (cleanup downgraded to keep, so
    // it is not retired), the unfixed path retires it after deleting. Waiting on
    // "settled" rather than on the row keeps the delete assertion below the one
    // that fails when the fix is absent.
    await waitForFast(() => {
      const run = findRequesterRun("run-unconfirmed-silent-cleanup");
      expect(run?.waitExpiryObservedAt).toEqual(expect.any(Number));
    });
    expect(deleteCalls()).toHaveLength(0);
    expect(findRequesterRun("run-unconfirmed-silent-cleanup")?.waitExpiryObservedAt).toEqual(
      expect.any(Number),
    );

    // Same run shape, same session identities, but agent.wait now carries a
    // terminal snapshot. Deletion must still happen, or the fix has simply
    // disabled delete-mode cleanup.
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return { status: "timeout", stopReason: "run_timeout", endedAt: Date.now() };
      }
      return {};
    });
    mocks.entries = sessionStore();
    await mod.registerSubagentRun({
      runId: "run-observed-silent-cleanup",
      task: "observed silent cleanup",
      cleanup: "delete",
      expectsCompletionMessage: false,
    });
    await waitForFast(() => {
      expect(deleteCalls()).toHaveLength(1);
    });
  });

  it("marks a run timeout as an observed child stop when agent.wait carries a terminal snapshot", async () => {
    let waitAttempts = 0;
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        waitAttempts += 1;
        // stopReason/endedAt only come from a terminal snapshot, so unlike a
        // bare wait expiry this really is the child's own run ending.
        return { status: "timeout", stopReason: "run_timeout", startedAt: 111, endedAt: 222 };
      }
      return {};
    });
    mocks.entries = createSessionStore({ status: "running" });

    await mod.registerSubagentRun({
      runId: "run-observed-timeout",
      task: "observed stop",
    });

    await waitForFast(() => {
      const completedRun = findRequesterRun("run-observed-timeout");
      expect(waitAttempts).toBeGreaterThanOrEqual(1);
      expectRecordFields(
        completedRun?.execution.outcome,
        { status: "timeout", disposition: "exited" },
        "observed run timeout outcome",
      );
    });
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

  it("promotes an unconfirmed explicit timeout when a late lifecycle abort observes the stop", async () => {
    const startedAt = Date.now();
    mockGatewayMethods(mocks.callGateway, { "agent.wait": { status: "timeout" } });
    mocks.entries = {
      "agent:main:subagent:child": createSessionEntry({
        updatedAt: startedAt,
        status: "running",
      }),
    };

    const settleRootWork = observeRootWork();
    await mod.registerSubagentRun({
      runId: "run-timeout-late-lifecycle-timeout",
      task: "published timeout should ignore late timeout",
      runTimeoutSeconds: 1,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await waitForFast(() => {
      const completedRun = findRequesterRun("run-timeout-late-lifecycle-timeout");
      expect(completedRun?.execution.endedAt).toBeUndefined();
      expect(completedRun?.waitExpiryObservedAt).toBe(startedAt + 1_000);
    });
    // Round 3: while unconfirmed, no durable terminal signal reaches an observer.
    expect(observerTerminalSignals("run-timeout-late-lifecycle-timeout")).toEqual([]);

    const lifecycleHandler = getLifecycleHandler();

    lifecycleHandler?.({
      runId: "run-timeout-late-lifecycle-timeout",
      stream: "lifecycle",
      data: {
        phase: "end",
        startedAt: startedAt + 10,
        endedAt: startedAt + 2_000,
        aborted: true,
      },
    });
    await vi.advanceTimersByTimeAsync(30_000);

    // Regression (openclaw-odqn round 2, finding 1): this coverage previously
    // asserted the published timeout was frozen against every later callback,
    // which is exactly what made `child-unconfirmed` a state nothing could ever
    // leave. A lifecycle `end` with `aborted` IS an observed stop, so it must be
    // able to settle the row. The outcome stays a deadline-clamped timeout —
    // recomputed against the observed start the event reports — but the
    // disposition promotes, which is what re-arms terminal cleanup.
    await waitForFast(() => {
      const run = findRequesterRun("run-timeout-late-lifecycle-timeout");
      expectRecordFields(
        run?.execution.outcome,
        {
          status: "timeout",
          startedAt: startedAt + 10,
          endedAt: startedAt + 1_010,
          elapsedMs: 1_000,
        },
        "promoted lifecycle timeout outcome",
      );
      expect(run?.execution.endedAt).toBe(startedAt + 1_010);
      // Round 3: promotion is also what publishes the terminal signal. This is
      // the push route (a late lifecycle event); the sweeper pull route is
      // covered separately, and both must land the claim exactly once.
      expect(observerTerminalSignals("run-timeout-late-lifecycle-timeout")).toEqual([
        { kind: "run_failed", summary: "child run timed out", outcome: "timeout" },
      ]);
    });
    await settleRootWork();
    // The actual stop has its own terminal delivery after the provisional wake.
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(2);
  });

  it("keeps boundary wait expiry provisional until the lifecycle owner reports child end", async () => {
    const startedAt = Date.now();
    let waitAttempts = 0;
    mocks.captureSubagentCompletionReply.mockResolvedValue("PARTIAL before expiry");
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        waitAttempts += 1;
        vi.setSystemTime(startedAt + 999);
        return { status: "timeout" };
      }
      return {};
    });
    mocks.entries = {
      "agent:main:subagent:child": createSessionEntry({
        updatedAt: startedAt,
        status: "running",
      }),
    };

    const settleRootWork = observeRootWork();
    await mod.registerSubagentRun({
      runId: "run-boundary-timeout",
      task: "deadline skew should still timeout",
      runTimeoutSeconds: 1,
    });

    await waitForFast(() => {
      const observedRun = findRequesterRun("run-boundary-timeout");
      expect(waitAttempts).toBe(1);
      expect(observedRun?.execution.status).toBe("running");
      expect(observedRun?.execution.endedAt).toBeUndefined();
      expect(observedRun?.waitExpiryObservedAt).toBe(startedAt + 1_000);
    });
    await waitForFast(() => expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1));
    expect(findRequesterRun("run-boundary-timeout")?.completion?.resultText).toBeUndefined();
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        deliveryPhase: "wait-expiry",
        outcome: { status: "timeout", disposition: "still-running" },
      }),
    );
    expect(mocks.cleanupBrowserSessionsForLifecycleEnd).not.toHaveBeenCalled();
    expect(mocks.onSubagentEnded).not.toHaveBeenCalled();

    getLifecycleHandler()({
      runId: "run-boundary-timeout",
      stream: "lifecycle",
      data: {
        phase: "end",
        startedAt,
        endedAt: startedAt + 1_250,
        terminalReply: { disposition: "visible", text: "FINAL after completion" },
      },
    });

    await waitForFast(() => {
      const completedRun = findRequesterRun("run-boundary-timeout");
      expect(completedRun?.execution.status).toBe("terminal");
      expect(completedRun?.execution.endedAt).toBe(startedAt + 1_250);
      expectRecordFields(
        completedRun?.execution.outcome,
        {
          status: "ok",
          startedAt,
          endedAt: startedAt + 1_250,
          elapsedMs: 1_250,
        },
        "authoritative post-expiry completion outcome",
      );
    });
    await waitForFast(() => {
      expect(mocks.cleanupBrowserSessionsForLifecycleEnd).toHaveBeenCalledTimes(1);
      expect(mocks.onSubagentEnded).toHaveBeenCalledTimes(1);
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(2);
      expect(findRequesterRun("run-boundary-timeout")?.completion?.resultText).toBe(
        "FINAL after completion",
      );
    });
    await settleRootWork();
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        roundOneReply: "FINAL after completion",
      }),
    );
    expect(
      (
        mocks.runSubagentAnnounceFlow.mock.calls as unknown as Array<[{ deliveryPhase?: string }]>
      )[1]?.[0],
    ).not.toMatchObject({
      deliveryPhase: "wait-expiry",
    });
  });

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

  it.each(["grace", "delivery", "rejected-delivery"] as const)(
    "does not publish retired wait-expiry state after lifecycle rotation during %s",
    async (rotationPhase) => {
      const startedAt = Date.now() - 1_000;
      mocks.callGateway.mockImplementation(async (request: { method?: string }) =>
        request.method === "agent.wait" ? { status: "timeout", startedAt } : {},
      );
      if (rotationPhase !== "grace") {
        mocks.runSubagentAnnounceFlow.mockImplementation(async () => {
          mocks.lifecycleGeneration = "rotated-generation";
          return rotationPhase === "rejected-delivery" ? "retryable" : "delivered";
        });
      }
      await mod.registerSubagentRun({
        runId: "run-expiry-retired-lifecycle",
        task: "do not let the retired waiter publish into the new Gateway generation",
        runTimeoutSeconds: 1,
      });
      // Settle the wait without advancing the grace timer: the same live row
      // survives the in-process restart while the wait's owner retires.
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.callGateway).toHaveBeenCalled();
      const beforeRotation = findRequesterRun("run-expiry-retired-lifecycle");
      expect(beforeRotation?.waitExpiryObservedAt).toBe(startedAt + 1_000);
      const persistedBeforeRotation = mocks.persistSubagentRunsToDiskOrThrow.mock.calls.length;
      if (rotationPhase === "grace") {
        mocks.lifecycleGeneration = "rotated-generation";
      }
      await vi.advanceTimersByTimeAsync(500);
      const run = findRequesterRun("run-expiry-retired-lifecycle");
      expect(run?.waitExpiryAnnouncedAt).toBeUndefined();
      expect(run?.execution.endedAt).toBeUndefined();
      if (rotationPhase === "grace") {
        expect(run?.waitExpiryObservedAt).toBe(startedAt + 1_000);
        expect(mocks.persistSubagentRunsToDiskOrThrow).toHaveBeenCalledTimes(
          persistedBeforeRotation,
        );
        expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
      } else {
        expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledOnce();
      }
      expect(mocks.cleanupBrowserSessionsForLifecycleEnd).not.toHaveBeenCalled();
    },
  );

  it("keeps a child nonterminal when the sweeper runs during expiry announcement grace", async () => {
    const startedAt = Date.now();
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method !== "agent.wait") {
        return {};
      }
      vi.setSystemTime(startedAt + 1_000);
      return { status: "timeout", startedAt };
    });
    mocks.entries = createSessionStore({ updatedAt: startedAt, status: "running" });
    await mod.registerSubagentRun({
      runId: "run-expiry-grace-sweep",
      task: "preserve uncertainty before the provisional announcement",
      runTimeoutSeconds: 1,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
    await mod.testing.sweepOnceForTests();
    const run = findRequesterRun("run-expiry-grace-sweep");
    expect(run?.execution.endedAt).toBeUndefined();
    expect(run?.execution.outcome).toBeUndefined();
    expect(run?.waitExpiryObservedAt).toBe(startedAt + 1_000);
    expect(mocks.cleanupBrowserSessionsForLifecycleEnd).not.toHaveBeenCalled();

    getLifecycleHandler()({
      runId: "run-expiry-grace-sweep",
      stream: "lifecycle",
      data: { phase: "end", startedAt, endedAt: startedAt + 1_000 },
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(run?.execution.status).toBe("terminal");
    // Completion commits the task through the real async task store before it
    // announces; that takes real time, not fake time.
    await vi.waitFor(() => expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledOnce(), {
      timeout: 15_000,
      interval: 50,
    });
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalledWith(
      expect.objectContaining({ deliveryPhase: "wait-expiry" }),
    );
  });

  it("retires a scheduled failed-delivery retry when the Gateway generation changes", async () => {
    const startedAt = Date.now() - 1_000;
    mocks.callGateway.mockImplementation(async (request: { method?: string }) =>
      request.method === "agent.wait" ? { status: "timeout", startedAt } : {},
    );
    mocks.runSubagentAnnounceFlow.mockResolvedValue("retryable");
    await mod.registerSubagentRun({
      runId: "run-expiry-retired-retry",
      task: "do not re-admit a retired wait after failed delivery",
      runTimeoutSeconds: 1,
    });
    // The grace delay is 250ms; the failed publish schedules a
    // distinct 25ms retry. Rotate after that retry is queued, before it fires.
    await vi.advanceTimersByTimeAsync(250);
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledOnce();
    const waitCount = mocks.callGateway.mock.calls.filter(
      ([request]) => request.method === "agent.wait",
    ).length;
    mocks.lifecycleGeneration = "rotated-generation";
    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledOnce();
    expect(
      mocks.callGateway.mock.calls.filter(([request]) => request.method === "agent.wait"),
    ).toHaveLength(waitCount);
    expect(findRequesterRun("run-expiry-retired-retry")?.waitExpiryAnnouncedAt).toBeUndefined();
    expect(mocks.cleanupBrowserSessionsForLifecycleEnd).not.toHaveBeenCalled();
  });

  it.each(["intentional_non_delivery", "permanent_failure", "delivered"] as const)(
    "settles a provisional notification with %s without settling its child",
    async (notificationOutcome) => {
      const startedAt = Date.now() - 1_000;
      const runId = `run-expiry-settled-notification-${notificationOutcome}`;
      mocks.callGateway.mockImplementation(async (request: { method?: string }) =>
        request.method === "agent.wait" ? { status: "timeout", startedAt } : {},
      );
      mocks.runSubagentAnnounceFlow.mockResolvedValue(notificationOutcome);
      await mod.registerSubagentRun({
        runId,
        task: "do not retry a settled notification or finalize its live child",
        runTimeoutSeconds: 1,
      });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledOnce();
      const run = findRequesterRun(runId);
      expect(run?.waitExpiryAnnouncedAt).toEqual(expect.any(Number));
      expect(run?.execution.status).toBe("running");
      expect(run?.execution.endedAt).toBeUndefined();
      expect(run?.completion?.resultText).toBeUndefined();
      expect(mocks.cleanupBrowserSessionsForLifecycleEnd).not.toHaveBeenCalled();
      expect(mocks.onSubagentEnded).not.toHaveBeenCalled();
      expect(observerTerminalSignals(runId)).toEqual([]);

      // Notification settlement must not suppress the child's later real result.
      getLifecycleHandler()({
        runId,
        stream: "lifecycle",
        data: {
          phase: "end",
          startedAt,
          endedAt: Date.now(),
          terminalReply: { disposition: "visible", text: "FINAL after notification settlement" },
        },
      });
      await waitForFast(() => {
        expect(run?.execution.status).toBe("terminal");
        expect(run?.completion?.resultText).toBe("FINAL after notification settlement");
        expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(2);
        expect(mocks.cleanupBrowserSessionsForLifecycleEnd).toHaveBeenCalledOnce();
      });
    },
  );

  it("retries a provisional wait-expiry announcement that was not delivered", async () => {
    const startedAt = Date.now() - 1_000;
    mocks.callGateway.mockImplementation(async (request: { method?: string }) =>
      request.method === "agent.wait" ? { status: "timeout", startedAt } : {},
    );
    mocks.runSubagentAnnounceFlow
      .mockResolvedValueOnce("retryable")
      .mockResolvedValueOnce("delivered");

    await mod.registerSubagentRun({
      runId: "run-wait-expiry-retryable-announce",
      task: "retry a deferred provisional wake",
      runTimeoutSeconds: 1,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await waitForFast(() => {
      const run = findRequesterRun("run-wait-expiry-retryable-announce");
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(2);
      expect(run?.execution.status).toBe("running");
      expect(run?.waitExpiryObservedAt).toBe(startedAt + 1_000);
      expect(run?.waitExpiryAnnouncedAt).toEqual(expect.any(Number));
    });
    expect(mocks.runSubagentAnnounceFlow.mock.calls).toEqual(
      expect.arrayContaining([[expect.objectContaining({ deliveryPhase: "wait-expiry" })]]),
    );
  });

  registerRestoredRunDeadlineSettlementTests({
    getRegistry: () => mod,
    mocks,
    hydrateAndActivateRegistry,
  });

  it.each([
    {
      name: "does not terminally time out plain agent.wait timeouts before the observed run deadline",
      runId: "run-plain-timeout-observed-start",
      task: "do not timeout before observed start deadline",
      initialNowAfterMs: 61_000,
      waitStartedAfterMs: 10_000,
      sessionStartedAfterMs: undefined,
      observedStartedAfterMs: 10_000,
      sessionUpdatedAfterMs: 0,
      advanceOnFirstWait: false,
    },
    {
      name: "uses running session-store start time for plain agent.wait timeouts",
      runId: "run-plain-timeout-session-store-start",
      task: "do not timeout before session store start deadline",
      initialNowAfterMs: 0,
      waitStartedAfterMs: undefined,
      sessionStartedAfterMs: 10_000,
      observedStartedAfterMs: 10_000,
      sessionUpdatedAfterMs: 61_000,
      advanceOnFirstWait: true,
    },
  ] as const)(
    "$name",
    async ({
      runId,
      task,
      initialNowAfterMs,
      waitStartedAfterMs,
      sessionStartedAfterMs,
      observedStartedAfterMs,
      sessionUpdatedAfterMs,
      advanceOnFirstWait,
    }) => {
      const createdAt = Date.parse("2026-03-24T11:59:00Z");
      const observedStartedAt = createdAt + observedStartedAfterMs;
      vi.setSystemTime(createdAt + initialNowAfterMs);
      let waitAttempts = 0;
      mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
        if (request.method !== "agent.wait") {
          return {};
        }
        waitAttempts += 1;
        if (advanceOnFirstWait && waitAttempts === 1) {
          vi.setSystemTime(createdAt + 61_000);
        }
        return waitStartedAfterMs === undefined
          ? { status: "timeout" }
          : { status: "timeout", startedAt: createdAt + waitStartedAfterMs };
      });
      mocks.entries = {
        "agent:main:subagent:child": createSessionEntry({
          status: "running",
          updatedAt: createdAt + sessionUpdatedAfterMs,
          ...(sessionStartedAfterMs === undefined
            ? {}
            : { startedAt: createdAt + sessionStartedAfterMs }),
        }),
      };

      const settleRootWork = observeRootWork();
      await mod.registerSubagentRun({ runId, task, runTimeoutSeconds: 60 });

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
        expect(run?.execution.status).toBe("running");
        expect(run?.execution.endedAt).toBeUndefined();
        expect(run?.execution.outcome).toBeUndefined();
        expect(run?.waitExpiryObservedAt).toBe(observedStartedAt + 60_000);
      });
      await settleRootWork();
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    {
      name: "prefers agent.wait start time over stale session-store start time",
      runId: "run-wait-start-over-session-store-start",
      task: "prefer wait observed start",
      initialNowMs: 61_000,
      waitStartedAtMs: 10_000,
      sessionStartedAtMs: 0,
      sessionEndedAtMs: 65_000,
      expected: { status: "ok", startedAtMs: 10_000, endedAtMs: 65_000, elapsedMs: 55_000 },
      label: "wait observed start beats stale session store start",
    },
    {
      name: "ignores stale session-store start time for fresh terminal completions",
      runId: "run-ignore-stale-session-start",
      task: "ignore stale session store start",
      initialNowMs: 0,
      waitNowMs: 61_000,
      sessionStartedAtMs: -60_000,
      sessionEndedAtMs: 30_000,
      expected: { status: "ok", startedAtMs: 0, endedAtMs: 30_000, elapsedMs: 30_000 },
      label: "fresh terminal completion ignores stale session start",
    },
    {
      name: "applies explicit timeout to terminal session rows without startedAt",
      runId: "run-session-row-no-start-timeout",
      task: "terminal row without start still honors timeout",
      initialNowMs: 0,
      waitNowMs: 61_000,
      sessionEndedAtMs: 61_000,
      expected: { status: "timeout", startedAtMs: 0, endedAtMs: 60_000, elapsedMs: 60_000 },
      label: "terminal session row without start timeout outcome",
    },
  ])(
    "$name",
    async ({
      runId,
      task,
      initialNowMs,
      waitNowMs,
      waitStartedAtMs,
      sessionStartedAtMs,
      sessionEndedAtMs,
      expected,
      label,
    }) => {
      const createdAt = Date.parse("2026-03-24T12:00:00Z");
      vi.setSystemTime(createdAt + initialNowMs);
      mockGatewayMethods(mocks.callGateway, {
        "agent.wait": () => {
          if (waitNowMs !== undefined) {
            vi.setSystemTime(createdAt + waitNowMs);
          }
          return {
            status: "timeout",
            ...(waitStartedAtMs === undefined ? {} : { startedAt: createdAt + waitStartedAtMs }),
          };
        },
      });
      mocks.entries = {
        "agent:main:subagent:child": createSessionEntry({
          status: "done",
          ...(sessionStartedAtMs === undefined
            ? {}
            : { startedAt: createdAt + sessionStartedAtMs }),
          updatedAt: createdAt + sessionEndedAtMs,
          endedAt: createdAt + sessionEndedAtMs,
        }),
      };

      const settleRootWork = observeRootWork();
      await mod.registerSubagentRun({ runId, task, runTimeoutSeconds: 60 });

      await waitForFast(() => {
        const run = findRequesterRun(runId);
        expect(run?.execution.endedAt).toBe(createdAt + expected.endedAtMs);
        expectRecordFields(
          run?.execution.outcome,
          {
            status: expected.status,
            startedAt: createdAt + expected.startedAtMs,
            endedAt: createdAt + expected.endedAtMs,
            elapsedMs: expected.elapsedMs,
          },
          label,
        );
      });
      await settleRootWork();
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    },
  );

  it("caps restored waits to the remaining explicit run timeout", async () => {
    const startedAt = Date.parse("2026-03-24T11:59:00Z");
    const runTimeoutSeconds = 60;
    vi.setSystemTime(startedAt + 59_000);
    mocks.resolveAgentTimeoutMs.mockReturnValue(60_000);
    mockRestoredRuns(() => [
      createSubagentRunRecord({
        runId: "run-resumed-near-deadline",
        task: "resume near explicit timeout",
        runTimeoutSeconds,
        createdAt: startedAt,
        startedAt,
        sessionStartedAt: startedAt,
      }),
    ]);
    const waitTimeouts: unknown[] = [];
    mocks.callGateway.mockImplementation(
      async (request: { method?: string; params?: Record<string, unknown> }) => {
        if (request.method === "agent.wait") {
          waitTimeouts.push(request.params?.timeoutMs);
          vi.setSystemTime(startedAt + 60_000);
          return { status: "timeout" };
        }
        return {};
      },
    );

    const settleRootWork = observeRootWork();
    await hydrateAndActivateRegistry();

    await waitForFast(() => {
      expect(waitTimeouts).toEqual([1_000]);
      const completedRun = findRequesterRun("run-resumed-near-deadline");
      expect(completedRun?.execution.status).toBe("running");
      expect(completedRun?.execution.endedAt).toBeUndefined();
      expect(completedRun?.execution.outcome).toBeUndefined();
      expect(completedRun?.waitExpiryObservedAt).toBe(startedAt + 60_000);
    });
    // The provisional announcement waits out a 250 ms terminal grace timer, which
    // fake timers never fire on their own.
    await vi.advanceTimersByTimeAsync(1_000);
    await settleRootWork();
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "uses observed agent.wait start time when capping terminal timeout",
      runId: "run-terminal-timeout-observed-start",
      task: "cap timeout using observed start",
      initialNowAfterMs: 75_000,
      waitStartedAfterMs: 10_000,
      waitEndedAfterMs: 75_000,
      sessionUpdatedAfterMs: 0,
      runTimeoutSeconds: 60,
      label: "observed start capped terminal timeout outcome",
    },
  ] as const)(
    "$name",
    async ({
      runId,
      task,
      initialNowAfterMs,
      waitStartedAfterMs,
      waitEndedAfterMs,
      sessionUpdatedAfterMs,
      runTimeoutSeconds,
      label,
    }) => {
      const createdAt = Date.parse("2026-03-24T11:59:00Z");
      const startedAt = createdAt + waitStartedAfterMs;
      const elapsedMs = runTimeoutSeconds * 1_000;
      vi.setSystemTime(createdAt + initialNowAfterMs);
      mockGatewayMethods(mocks.callGateway, {
        "agent.wait": {
          status: "timeout",
          startedAt,
          endedAt: createdAt + waitEndedAfterMs,
          stopReason: "rpc",
        },
      });
      mocks.entries = {
        "agent:main:subagent:child": createSessionEntry({
          updatedAt: createdAt + sessionUpdatedAfterMs,
          status: "running",
        }),
      };

      const settleRootWork = observeRootWork();
      await mod.registerSubagentRun({ runId, task, runTimeoutSeconds });

      await waitForFast(() => {
        const run = findRequesterRun(runId);
        expect(run?.execution.endedAt).toBe(startedAt + elapsedMs);
        expectRecordFields(
          run?.execution.outcome,
          { status: "timeout", startedAt, endedAt: startedAt + elapsedMs, elapsedMs },
          label,
        );
      });
      await settleRootWork();
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    },
  );

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

  it("publishes aborted agent.wait snapshots only after killed reconciliation", async () => {
    mockGatewayMethods(mocks.callGateway, {
      "agent.wait": {
        status: "ok",
        startedAt: 100,
        endedAt: 250,
        stopReason: "aborted",
      },
    });

    await mod.registerSubagentRun({
      runId: "run-aborted-wait",
      task: "aborted wait",
      expectsCompletionMessage: true,
    });

    await waitForFast(() => {
      const run = findRequesterRun("run-aborted-wait");
      expect(run?.endedReason).toBe("subagent-killed");
      expect(run?.suppressAnnounceReason).toBe("killed");
    });
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();

    await mod.testing.sweepOnceForTests();
    await waitForFast(() => expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1));
    const announceParams = expectRecordFields(
      getMockCallArg(mocks.runSubagentAnnounceFlow, 0, 0, "aborted wait announce"),
      { childRunId: "run-aborted-wait" },
      "aborted wait announce params",
    );
    expectRecordFields(
      announceParams.outcome,
      {
        status: "error",
        error: "subagent run terminated",
        startedAt: 100,
        endedAt: 250,
        elapsedMs: 150,
      },
      "aborted wait announce outcome",
    );

    await waitForFast(() => {
      expect(
        mod
          .listSubagentRunsForRequester("agent:main:main")
          .some((entry) => entry.runId === "run-aborted-wait"),
      ).toBe(false);
    });
  });

  it("reconciles a provisionally announced run from persisted terminal state during sweep", async () => {
    mockPendingAgentWait();
    const persistedStartedAt = Date.parse("2026-03-24T11:58:00Z");
    const persistedEndedAt = persistedStartedAt + 111;
    mocks.entries = {
      "agent:main:subagent:child": createSessionEntry({
        updatedAt: persistedEndedAt,
        status: "done",
        startedAt: persistedStartedAt,
        endedAt: persistedEndedAt,
        runtimeMs: 111,
      }),
    };

    vi.setSystemTime(persistedStartedAt - 1);
    await mod.registerSubagentRun({
      runId: "run-stale-terminal",
      task: "settle from persisted terminal state",
    });
    const provisionalRun = findRequesterRun("run-stale-terminal");
    if (!provisionalRun) {
      throw new Error("expected provisional run");
    }
    provisionalRun.waitExpiryObservedAt = persistedStartedAt + 60_000;
    provisionalRun.waitExpiryAnnouncedAt = persistedStartedAt + 60_001;

    vi.setSystemTime(new Date("2026-03-24T12:02:00Z"));
    await mod.testing.sweepOnceForTests();

    await waitForFast(() => {
      const announceParams = findRecordCallArg(
        mocks.runSubagentAnnounceFlow,
        0,
        "stale terminal announce",
        (record) => record.childRunId === "run-stale-terminal",
      );
      expectRecordFields(
        announceParams,
        { childRunId: "run-stale-terminal" },
        "stale terminal announce",
      );
      expectRecordFields(
        announceParams.outcome,
        { status: "ok", endedAt: persistedEndedAt },
        "stale terminal announce outcome",
      );
    });

    const run = findRequesterRun("run-stale-terminal");
    expect(run?.execution.endedAt).toBe(persistedEndedAt);
    expectRecordFields(
      run?.execution.outcome,
      {
        status: "ok",
        endedAt: persistedEndedAt,
      },
      "stale terminal run outcome",
    );
    await waitForFast(() => expect(run?.cleanupCompletedAt).toBeTypeOf("number"));
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
