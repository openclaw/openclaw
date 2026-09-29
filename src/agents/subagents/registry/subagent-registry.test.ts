import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
// Subagent registry tests cover run state, completion capture, archive cleanup,
// persistence, lifecycle hooks, and orphan recovery scheduling.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { cleanupBrowserSessionsForLifecycleEnd } from "../../../browser-lifecycle-cleanup.js";
import { captureSessionEntryCurrentRead } from "../../../config/sessions/session-entry-current-runtime.js";
import { withSessionEntryReadOnlyInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import {
  runWithOwnedSessionTranscriptWrite,
  withOwnedSessionTranscriptWrites,
} from "../../../config/sessions/transcript-write-context.js";
import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import type { AgentEventPayload } from "../../../infra/agent-events.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
  getSharedGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../../process/gateway-work-admission.js";
vi.mocked(cleanupBrowserSessionsForLifecycleEnd).mockReset();
import { buildAgentRunTerminalOutcomeFromLifecycleEvent } from "../../agent-run-terminal-outcome.js";
import type { SubagentRegistryHarness } from "../../subagent-test-fixtures.test-helpers.js";
import {
  createSessionEntry,
  createSubagentRegistryHarness,
  createSubagentRunRecord,
  expectRecordFields,
  mockCallArg as getMockCallArg,
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
import { subagentRuns } from "./subagent-registry-memory.js";
import { registerSubagentResultRefreshCases } from "./subagent-registry-result-refresh.test-support.js";
import { persistSubagentRunsToDiskOrThrow } from "./subagent-registry-state.js";
import {
  observeRootWork,
  registerBrowserCleanupBoundaryTests,
} from "./subagent-registry.browser-cleanup.test-support.js";
import { findRecordCallArg } from "./subagent-registry.mock-call.test-support.js";
import {
  registerForcedCollectorCompletionSettlementTests,
  registerQueuedCollectorLaunchSettlementTest,
  registerRestartDrainCompletionSettlementTest,
  registerRestoredRunDeadlineSettlementTests,
} from "./subagent-registry.native-settlement.test-support.js";
import { registerSupersededNativeTimingTest } from "./subagent-registry.native-termination.test-support.js";
import { registerSubagentRegistrationPersistenceTests } from "./subagent-registry.persistence.test-support.js";
import {
  registerRestoredRollbackPublicationTest,
  registerRestoredRunningSettlementTest,
} from "./subagent-registry.restored-settlement.test-support.js";
import {
  makeCompletedCollectorRun,
  makeKilledRun,
  makeQueuedRun,
  makeSuspendedDeliveryRun,
} from "./subagent-registry.run-fixtures.test-support.js";
import { saveSubagentRegistryChangesToSqlite } from "./subagent-registry.store.sqlite.js";
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
const { withSessionEntryReadOnlyInWorker: readCanonicalSessionEntry } = await vi.importActual<
  typeof import("../../../config/sessions/session-entry-read-runtime.js")
>("../../../config/sessions/session-entry-read-runtime.js");
vi.mock("../../../config/sessions/session-accessor.sqlite-replacement-projection.js", () => ({
  applySessionEntryExactReplacements: mocks.applySessionEntryExactReplacements,
}));
vi.mock("../../../config/sessions/session-entry-current-runtime.js", { spy: true });
const { captureSessionEntryCurrentRead: captureCanonicalSessionEntryCurrent } =
  await vi.importActual<typeof import("../../../config/sessions/session-entry-current-runtime.js")>(
    "../../../config/sessions/session-entry-current-runtime.js",
  );

vi.mock("../../../sessions/session-lifecycle-events.js", () => ({
  emitSessionLifecycleEvent: mocks.emitSessionLifecycleEvent,
  onSessionIdentityMutation: mocks.onSessionIdentityMutation,
  emitSessionIdentityMutation: mocks.emitSessionIdentityMutation,
}));

vi.mock("./subagent-registry-state.js", async () => ({
  clearSubagentRunsReadCacheForTest: mocks.clearSubagentRunsReadCacheForTest,
  getSubagentRunsSnapshotForChildSession: mocks.getSubagentRunsSnapshotForChildSession,
  getSubagentRunsSnapshotForController: mocks.getSubagentRunsSnapshotForController,
  getSubagentRunsSnapshotForRead: mocks.getSubagentRunsSnapshotForRead,
  getSubagentRunsSnapshotForSessions: mocks.getSubagentRunsSnapshotForRead,
  getSubagentMaintenanceRunsSnapshotForRead: mocks.getSubagentRunsSnapshotForRead,
  ...(await import("../../subagent-test-fixtures.test-helpers.js")).createSubagentPersistenceMock(
    mocks,
  ),
}));

vi.mock("./subagent-registry-replacement-store.js", () => ({
  commitSubagentRunReplacement: vi.fn(
    (
      params: Parameters<
        typeof import("./subagent-registry-replacement-store.js").commitSubagentRunReplacement
      >[0],
    ) => {
      persistSubagentRunsToDiskOrThrow(params.runs, params.changedRunIds);
    },
  ),
}));

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
  const recoveryRuntime: GatewayRecoveryRuntime = {
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
    sendRecoveryNotice: vi.fn(),
  };
  const activateRegistry = () => {
    const gatewayContext = {
      recoveryRuntime,
      resolveGatewayContext: () => gatewayContext as never,
    };
    bindGatewayContextResolver(recoveryRuntime, gatewayContext.resolveGatewayContext);
    mod.activateSubagentRegistry(gatewayContext.resolveGatewayContext);
  };
  const hydrateAndActivateRegistry = () => {
    mod.initSubagentRegistry();
    activateRegistry();
  };
  const findRequesterRun = (runId: string) =>
    mod.listSubagentRunsForRequester("agent:main:main").find((entry) => entry.runId === runId);
  const mockRestoredRuns = (createEntries: () => SubagentRunRecord[]) =>
    mocks.restoreSubagentRunsFromDisk.mockImplementation(({ runs }) => {
      const entries = createEntries();
      for (const entry of entries) {
        runs.set(entry.runId, entry);
      }
      return entries.length;
    });
  const mockPendingAgentWait = () =>
    mockGatewayMethods(mocks.callGateway, { "agent.wait": { status: "pending" } });
  const mockSingleCollectorConcurrency = () =>
    mocks.getRuntimeConfig.mockReturnValue({
      tools: { swarm: { enabled: true, maxConcurrent: 1 } },
      agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
      session: { mainKey: "main", scope: "per-sender" as const },
    });
  const getLifecycleHandler = () => {
    const handler = mocks.onAgentEvent.mock.calls.at(-1)?.[0] as unknown as
      | ((event: {
          runId: string;
          stream: string;
          data: Record<string, unknown>;
          seq?: number;
          ts?: number;
          sessionKey?: string;
        }) => void)
      | undefined;
    if (!handler) {
      throw new Error("expected lifecycle handler");
    }
    return handler;
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

  beforeEach(() => {
    resetGatewayWorkAdmission();
    vi.clearAllMocks();
    mocks.callGateway.mockReset();
    mocks.captureSubagentCompletionReply.mockReset().mockResolvedValue("final completion reply");
    mocks.cleanupBrowserSessionsForLifecycleEnd.mockReset().mockResolvedValue(undefined);
    loadBrowserMaintenanceSurface.mockReset().mockResolvedValue(null);
    vi.mocked(cleanupBrowserSessionsForLifecycleEnd).mockImplementation(
      mocks.cleanupBrowserSessionsForLifecycleEnd,
    );
    mocks.persistSubagentRunsToDisk.mockReset();
    mocks.persistSubagentRunsToDiskOrThrow.mockReset();
    mocks.restoreSubagentRunsFromDisk.mockReset().mockReturnValue(0);
    mocks.loadSessionEntry.mockReset();
    vi.mocked(withSessionEntryReadOnlyInWorker)
      .mockReset()
      .mockImplementation((...args) =>
        args[0].storePath === mocks.resolveStorePath()
          ? mocks.withSessionEntryReadOnlyInWorker(...args)
          : readCanonicalSessionEntry(...args),
      );
    vi.mocked(captureSessionEntryCurrentRead)
      .mockReset()
      .mockImplementation((scope, owner) =>
        scope.storePath === mocks.resolveStorePath()
          ? mocks.captureSessionEntryCurrentRead(scope, owner)
          : captureCanonicalSessionEntryCurrent(scope, owner),
      );
    mocks.listSessionEntriesCore.mockReset();
    mocks.patchSessionEntryCore.mockReset();
    mocks.readSessionCurrent.mockReset();
    mocks.applySessionEntryExactReplacements.mockReset();
    mocks.runSubagentAnnounceFlow.mockReset().mockResolvedValue("delivered");
    wakeRequester.mockReset().mockImplementation(async (params) => {
      await params.completeBatch([params.settledEntry]);
      return false;
    });
    // SQLite worker deadlines share the native monotonic clock across threads.
    vi.useFakeTimers({ toNotFake: ["hrtime", "performance"] });
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));
    mocks.lifecycleGeneration = "test-generation";
    mocks.onAgentEvent.mockReturnValue(noop);
    mocks.getAgentRunContext.mockReturnValue(undefined);
    mocks.getRuntimeConfig.mockReturnValue({
      agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
      session: { mainKey: "main", scope: "per-sender" as const },
    });
    mocks.resolveAgentIdFromSessionKey.mockImplementation((sessionKey: string) => {
      return sessionKey.match(/^agent:([^:]+)/)?.[1] ?? "main";
    });
    mocks.resolveStorePath.mockReturnValue("/tmp/test-session-store.json");
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
    mocks.getSubagentRunsSnapshotForController
      .mockReset()
      .mockImplementation((runs) => new Map(runs));
    mockGatewayMethods(mocks.callGateway, {
      "agent.wait": {
        status: "ok",
        startedAt: 111,
        endedAt: 222,
      },
    });
    mocks.dispatchRecoveryAgent.mockImplementation(async (params, timeoutMs, options) =>
      mocks.callGateway({
        method: "agent",
        params: params as unknown as Record<string, unknown>,
        timeoutMs,
        ...(options?.scopes ? { scopes: options.scopes } : {}),
      }),
    );
    mod.resetSubagentRegistryForTests({ persist: false });
    swarmSchedulerTesting.reset();
  });

  afterEach(() => {
    resetGatewayWorkAdmission();
    vi.mocked(cleanupBrowserSessionsForLifecycleEnd).mockReset();
    mod.resetSubagentRegistryForTests({ persist: false });
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
        mod.addSubagentRunForTests(
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

  it("refreshes collector membership after awaited sweep work", async () => {
    const now = Date.now();
    mocks.entries = {
      "agent:main:subagent:archive-blocker": createSessionEntry({
        lifecycleRevision: "revision-archive-blocker",
        sessionId: "session-archive-blocker",
      }),
    };
    let releaseFirstDelete: (() => void) | undefined;
    let shouldBlockDelete = true;
    mocks.callGateway.mockImplementation((request: { method?: string }) => {
      if (request.method !== "sessions.delete" || !shouldBlockDelete) {
        return Promise.resolve({});
      }
      shouldBlockDelete = false;
      return new Promise<Record<string, unknown>>((resolve) => {
        releaseFirstDelete = () => resolve({});
      });
    });
    mod.addSubagentRunForTests({
      runId: "run-archive-blocker",
      childSessionKey: "agent:main:subagent:archive-blocker",
      task: "hold the sweep before collector archival",
      cleanup: "delete",
      createdAt: now - 10_000,
      endedAt: now - 5_000,
      cleanupCompletedAt: now - 4_000,
      archiveAtMs: now - 1,
    });
    mod.addSubagentRunForTests(
      makeCompletedCollectorRun({
        runId: "run-collector-before-await",
        childSessionKey: "agent:main:subagent:collector-before-await",
        task: "completed collector present at sweep start",
        createdAt: now - 10_000,
        endedAt: now - 5_000,
        archiveAtMs: now - 1,
        groupId: "swarm:late-member",
      }),
    );

    const sweep = mod.testing.runSweeperTickForTests();
    await waitForFast(() => expect(releaseFirstDelete).toBeTypeOf("function"));
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    mod.addSubagentRunForTests({
      runId: "run-collector-after-await",
      childSessionKey: "agent:main:subagent:collector-after-await",
      task: "incomplete collector registered during sweep",
      createdAt: now,
      collect: true,
      groupId: "swarm:late-member",
    });
    releaseFirstDelete?.();
    await sweep;
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));

    expect(mod.getSubagentRunByRunId("run-collector-before-await")).toBeDefined();
    expect(mod.getSubagentRunByRunId("run-collector-after-await")).toBeDefined();
  });

  it("revalidates collector membership after collector cleanup awaits", async () => {
    const now = Date.now();
    mocks.entries = {
      "agent:main:subagent:collector-cleanup-snapshot": createSessionEntry({
        lifecycleRevision: "revision-collector-cleanup-snapshot",
        sessionId: "session-collector-cleanup-snapshot",
      }),
    };
    let releaseCollectorDelete: (() => void) | undefined;
    mocks.callGateway.mockImplementation((request: { method?: string }) => {
      if (request.method !== "sessions.delete" || releaseCollectorDelete) {
        return Promise.resolve({});
      }
      return new Promise<Record<string, unknown>>((resolve) => {
        releaseCollectorDelete = () => resolve({});
      });
    });
    mod.addSubagentRunForTests(
      makeCompletedCollectorRun({
        runId: "run-collector-cleanup-snapshot",
        childSessionKey: "agent:main:subagent:collector-cleanup-snapshot",
        task: "completed collector present before cleanup",
        createdAt: now - 10_000,
        endedAt: now - 5_000,
        archiveAtMs: now - 1,
        groupId: "swarm:cleanup-race",
      }),
    );

    const sweep = mod.testing.runSweeperTickForTests();
    await waitForFast(() => expect(releaseCollectorDelete).toBeTypeOf("function"));
    mod.addSubagentRunForTests({
      runId: "run-collector-added-during-cleanup",
      childSessionKey: "agent:main:subagent:collector-added-during-cleanup",
      task: "incomplete collector registered during cleanup",
      createdAt: now,
      collect: true,
      groupId: "swarm:cleanup-race",
    });
    releaseCollectorDelete?.();
    await sweep;

    expect(mod.getSubagentRunByRunId("run-collector-cleanup-snapshot")).toBeDefined();
    expect(mod.getSubagentRunByRunId("run-collector-added-during-cleanup")).toBeDefined();
  });

  it("keeps a collector replaced during collector cleanup awaits", async () => {
    const now = Date.now();
    mocks.entries = {
      "agent:main:subagent:collector-before-replacement": createSessionEntry({
        lifecycleRevision: "revision-collector-before-replacement",
        sessionId: "session-collector-before-replacement",
      }),
    };
    let releaseCollectorDelete: (() => void) | undefined;
    mocks.callGateway.mockImplementation((request: { method?: string }) => {
      if (request.method !== "sessions.delete" || releaseCollectorDelete) {
        return Promise.resolve({});
      }
      return new Promise<Record<string, unknown>>((resolve) => {
        releaseCollectorDelete = () => resolve({});
      });
    });
    mod.addSubagentRunForTests(
      makeCompletedCollectorRun({
        runId: "run-collector-replaced-during-cleanup",
        childSessionKey: "agent:main:subagent:collector-before-replacement",
        task: "collector before replacement",
        createdAt: now - 10_000,
        endedAt: now - 5_000,
        archiveAtMs: now - 1,
        groupId: "swarm:replacement-race",
      }),
    );

    const sweep = mod.testing.runSweeperTickForTests();
    await waitForFast(() => expect(releaseCollectorDelete).toBeTypeOf("function"));
    mod.addSubagentRunForTests(
      makeCompletedCollectorRun({
        runId: "run-collector-replaced-during-cleanup",
        childSessionKey: "agent:main:subagent:collector-after-replacement",
        task: "collector after replacement",
        createdAt: now,
        endedAt: now,
        archiveAtMs: now - 1,
        groupId: "swarm:replacement-race",
      }),
    );
    releaseCollectorDelete?.();
    await sweep;

    expect(
      mod.getSubagentRunByRunId("run-collector-replaced-during-cleanup")?.childSessionKey,
    ).toBe("agent:main:subagent:collector-after-replacement");
  });

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
    mod.addSubagentRunForTests(
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
    mod.addSubagentRunForTests({
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

  it("retires collector records without traversing legacy attachment paths", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-swarm-archive-"));
    const attachmentsRootDir = path.join(tempRoot, "root");
    const attachmentsDir = path.join(tempRoot, "outside");
    await fs.mkdir(attachmentsRootDir);
    await fs.mkdir(attachmentsDir);
    try {
      mod.addSubagentRunForTests(
        makeCompletedCollectorRun({
          runId: "run-collector-unsafe-attachments",
          childSessionKey: "agent:main:subagent:collector-unsafe-attachments",
          task: "retain record until attachments are safely removed",
          createdAt: Date.now() - 10_000,
          endedAt: Date.now() - 5_000,
          archiveAtMs: Date.now() - 1,
          groupId: "swarm:unsafe-attachments",
          attachmentsDir,
          attachmentsRootDir,
        }),
      );

      await mod.testing.sweepOnceForTests();

      expect(mod.getSubagentRunByRunId("run-collector-unsafe-attachments")).toBeUndefined();
      await expect(fs.access(attachmentsDir)).resolves.toBeUndefined();
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("snapshots ordinary parent-chain wait ownership when registering a collector", async () => {
    const parentSessionKey = "agent:main:subagent:collector-parent";
    mod.addSubagentRunForTests({
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

  it("records early structured output through the child session identity", () => {
    const childSessionKey = "agent:main:subagent:early-structured-output";
    mod.addSubagentRunForTests({
      runId: "public-collector-run",
      childSessionKey,
      task: "return structured output immediately",
      createdAt: Date.now(),
      collect: true,
      execution: { status: "queued" },
    });

    mod.recordSwarmStructuredOutput(
      { runId: "gateway-run-not-yet-remapped", childSessionKey },
      { invalidAttempts: 0, structured: { answer: 42 } },
    );

    expect(mod.getSubagentRunByRunId("public-collector-run")?.structuredOutput).toEqual({
      invalidAttempts: 0,
      structured: { answer: 42 },
    });
  });

  it("lists active and pending-delivery child sessions for maintenance preservation", () => {
    const now = Date.now();
    mod.addSubagentRunForTests({
      runId: "run-active",
      childSessionKey: "agent:main:subagent:active",
      task: "active task",
      cleanup: "delete",
      expectsCompletionMessage: true,
      createdAt: now,
    });
    mod.addSubagentRunForTests({
      runId: "run-pending",
      childSessionKey: "agent:main:subagent:pending",
      task: "pending delivery task",
      cleanup: "delete",
      expectsCompletionMessage: true,
      createdAt: now - 2,
      endedAt: now - 1,
      completion: { required: true, resultText: "child output" },
      delivery: { status: "pending" },
    });
    mod.addSubagentRunForTests({
      runId: "run-complete",
      childSessionKey: "agent:main:subagent:complete",
      task: "already delivered task",
      expectsCompletionMessage: true,
      createdAt: now - 4,
      endedAt: now - 3,
      delivery: { status: "delivered", announcedAt: now - 2, deliveredAt: now - 2 },
      cleanupCompletedAt: now - 1,
    });
    mod.addSubagentRunForTests({
      runId: "run-killed-reconciling",
      childSessionKey: "agent:main:subagent:killed-reconciling",
      task: "reconcile killed task",
      cleanup: "delete",
      expectsCompletionMessage: false,
      createdAt: now - 6,
      endedAt: now - 5,
      endedReason: "subagent-killed",
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: now - 5 },
      cleanupCompletedAt: now - 4,
    });

    expect(mod.listSessionMaintenanceProtectedSubagentSessionKeys().toSorted()).toEqual([
      "agent:main:subagent:active",
      "agent:main:subagent:killed-reconciling",
      "agent:main:subagent:pending",
    ]);
  });

  it("retries registry restore after a transient partial-merge failure", () => {
    const runId = "run-restore-retry";
    const restored = createSubagentRunRecord({
      runId,
      task: "retry registry restore",
      cleanup: "keep",
      pauseReason: "sessions_yield",
      createdAt: Date.now(),
    });
    mocks.restoreSubagentRunsFromDisk
      .mockImplementationOnce(((params: { runs: Map<string, SubagentRunRecord> }) => {
        params.runs.set(runId, restored);
        throw new Error("transient sqlite read failure");
      }) as never)
      .mockReturnValue(0);

    hydrateAndActivateRegistry();
    expect(mocks.restoreSubagentRunsFromDisk).toHaveBeenCalledOnce();
    expect(mocks.onAgentEvent).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_000);

    expect(mocks.restoreSubagentRunsFromDisk).toHaveBeenCalledTimes(2);
    expect(mod.getSubagentRunByRunId(runId)?.runId).toBe(runId);
    expect(mocks.onAgentEvent).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);

    mod.initSubagentRegistry();
    expect(mocks.restoreSubagentRunsFromDisk).toHaveBeenCalledTimes(2);
  });

  registerRestoredRunningSettlementTest({
    getRegistry: () => mod,
    mocks,
    hydrateAndActivateRegistry,
  });

  it.each([
    { name: "exact retired orphan", retired: true, sameRun: true, aborted: false, waits: false },
    { name: "newer session run", retired: true, sameRun: false, aborted: false, waits: true },
    { name: "current lifecycle", retired: false, sameRun: true, aborted: false, waits: true },
    { name: "aborted session", retired: false, sameRun: false, aborted: true, waits: false },
  ])("routes restored waits for a $name", ({ retired, sameRun, aborted, waits }) => {
    const runId = "run-restored-orphan-routing";
    const restored = createSubagentRunRecord({
      runId,
      execution: {
        status: "running",
        lifecycleGeneration: retired ? "retired-generation" : mocks.lifecycleGeneration,
      },
    });
    mocks.entries = {
      "agent:main:subagent:child": createSessionEntry({
        status: "running",
        lifecycleRunId: sameRun ? runId : "newer-run",
        abortedLastRun: aborted,
      }),
    };
    mockRestoredRuns(() => [restored]);
    mockPendingAgentWait();

    hydrateAndActivateRegistry();

    expect(mocks.callGateway).toHaveBeenCalledTimes(waits ? 1 : 0);
    if (waits) {
      expect(mocks.callGateway).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "agent.wait",
          params: expect.objectContaining({ runId }),
        }),
      );
    }
  });

  it("does not double-run reentrant registry restore calls", () => {
    mocks.restoreSubagentRunsFromDisk.mockImplementation(() => {
      mod.initSubagentRegistry();
      return 0;
    });

    mod.initSubagentRegistry();

    expect(mocks.restoreSubagentRunsFromDisk).toHaveBeenCalledOnce();
  });

  it.each([
    "after Gateway closure",
    "partial restore",
    "without instance binding",
    "without activation",
  ])("replays a past-due requester-settle obligation restored %s", async (restoreTiming) => {
    const endedAt = Date.now() - 1_000;
    const lateRestore = !["before activation", "without activation"].includes(restoreTiming);
    const runIds =
      restoreTiming === "partial restore"
        ? ["run-settle-restore", "run-settle-sibling"]
        : ["run-settle-restore"];
    const restored = runIds.map((runId) =>
      createSubagentRunRecord({
        runId,
        childSessionKey: `agent:main:subagent:${runId}`,
        task: "restore requester settle wake",
        cleanup: "delete",
        expectsCompletionMessage: true,
        createdAt: endedAt - 1_000,
        startedAt: endedAt - 900,
        endedAt,
        cleanupCompletedAt: endedAt,
        completion: { required: true, resultText: "persisted findings" },
        delivery: { status: "delivered" },
        requesterSettleWake: {
          status: "pending",
          attemptCount: 1,
          nextAttemptAt: endedAt,
          batchRunIds: runIds,
          retireAfterSettle: true,
        },
      }),
    );
    mocks.restoreSubagentRunsFromDisk.mockImplementation(((params: {
      runs: Map<string, SubagentRunRecord>;
    }) => {
      let inserted = 0;
      for (const entry of restored) {
        if (!params.runs.has(entry.runId)) {
          params.runs.set(entry.runId, entry);
          inserted += 1;
        }
      }
      return inserted;
    }) as never);
    if (lateRestore) {
      mocks.restoreSubagentRunsFromDisk.mockImplementationOnce(((params: {
        runs: Map<string, SubagentRunRecord>;
      }) => {
        if (restoreTiming === "partial restore") {
          params.runs.set(restored[0]!.runId, restored[0]!);
        }
        throw new Error("transient sqlite read failure");
      }) as never);
    }
    const retirementWrites: string[][] = [];
    mocks.persistSubagentRunsToDiskOrThrow.mockImplementation((runs, ids) => {
      if (ids?.some((id) => runIds.includes(id)) && runIds.every((id) => !runs.has(id))) {
        retirementWrites.push(ids.toSorted());
      }
    });
    const wakeGateway = createDeferred<unknown>();
    wakeRequester.mockImplementation(async (params) => {
      const gateway = getSharedGatewayContextResolver(restored)?.()?.recoveryRuntime;
      await params.completeBatch(restored);
      wakeGateway.resolve(gateway);
      return false;
    });
    let gatewayOpen = true;
    const instanceContext = { recoveryRuntime } as never;
    const resolveInstance = () => (gatewayOpen ? instanceContext : undefined);
    const resolveGatewayContext = () =>
      (restoreTiming === "without instance binding"
        ? { recoveryRuntime }
        : { resolveGatewayContext: resolveInstance }) as never;
    const settleRootWork = observeRootWork();
    try {
      mod.initSubagentRegistry();
      if (restoreTiming === "without activation") {
        mod.resumeSubagentRun(restored[0]!.runId);
      } else {
        mod.activateSubagentRegistry(resolveGatewayContext);
        mod.activateSubagentRegistry(resolveGatewayContext);
      }
      if (lateRestore) {
        expect(wakeRequester).not.toHaveBeenCalled();
        if (restoreTiming === "partial restore") {
          await mod.testing.runSweeperTickForTests();
          expect(wakeRequester).not.toHaveBeenCalled();
        }
        gatewayOpen = restoreTiming !== "after Gateway closure";
        await vi.advanceTimersByTimeAsync(1_000);
        if (!gatewayOpen || restoreTiming === "without instance binding") {
          await vi.advanceTimersByTimeAsync(5_000);
          expect(wakeRequester).not.toHaveBeenCalled();
          expect(getGatewayContextResolver(restored[0]!)).toBeUndefined();
          expect(restored[0]!.requesterSettleWake?.attemptCount).toBe(1);
          activateRegistry();
        }
      }
      expect(await wakeGateway.promise).toBe(
        restoreTiming === "without activation" ? undefined : recoveryRuntime,
      );
    } finally {
      await settleRootWork();
    }
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    expect(retirementWrites).toEqual([runIds.toSorted()]);
    for (const entry of restored) {
      expect(getGatewayContextResolver(entry)).toBe(getGatewayContextResolver(restored[0]!));
      expect(mod.getSubagentRunByRunId(entry.runId)).toBeUndefined();
    }
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(wakeRequester).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterSessionKey: "agent:main:main",
        settledEntry: expect.objectContaining({ runId: "run-settle-restore" }),
        transitionBatch: expect.any(Function),
        completeBatch: expect.any(Function),
      }),
    );
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

    hydrateAndActivateRegistry();
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.callGateway.mock.calls.filter(([request]) => request.method === "agent")).toEqual(
      [],
    );
  });

  it.each(["running", "interrupted"] as const)(
    "rehydrates persisted collector FIFO queues after a %s owner releases capacity",
    async (executionStatus) => {
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
          execution: { status: executionStatus, startedAt: now - 1_000 },
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
      hydrateAndActivateRegistry();
      await Promise.resolve();
      expect(
        mocks.callGateway.mock.calls.filter(([request]) => request.method === "agent"),
      ).toEqual([]);

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
      expect(acceptedRun).not.toHaveProperty("sessionStartedAt");
      expect(acceptedRun?.execution).not.toHaveProperty("startedAt");
      expect(mod.getSubagentRunByRunId("run-queued-two")?.execution?.status).toBe("queued");
    },
  );

  it("preserves a lifecycle start that arrives before collector acceptance returns", async () => {
    const startedAt = 12_345;
    await mod.registerSubagentRun({
      runId: "run-start-race",
      childSessionKey: "agent:main:subagent:start-race",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "start before acceptance",
      cleanup: "keep",
      collect: true,
      groupId: "start-race",
      queued: true,
      expectsCompletionMessage: false,
    });
    const lastOnAgentEventCall = mocks.onAgentEvent.mock.calls.at(-1) as unknown as
      | [(event: AgentEventPayload) => void]
      | undefined;
    const lifecycleHandler = lastOnAgentEventCall?.[0];
    expect(lifecycleHandler).toBeTypeOf("function");

    lifecycleHandler?.({
      runId: "run-start-race",
      seq: 1,
      stream: "lifecycle",
      ts: startedAt,
      data: { phase: "start", startedAt },
    });
    await waitForFast(() =>
      expect(mod.getSubagentRunByRunId("run-start-race")?.execution.startedAt).toBe(startedAt),
    );

    expect(mod.startQueuedSubagentRun("run-start-race", "gateway-start-race")).toBe(true);
    expect(mod.getSubagentRunByRunId("gateway-start-race")).toMatchObject({
      sessionStartedAt: startedAt,
      execution: { status: "running", acceptedAt: expect.any(Number), startedAt },
    });
  });

  it("rejects queued collector acceptance from a retired Gateway lifecycle", async () => {
    await mod.registerSubagentRun({
      runId: "run-retired-acceptance",
      childSessionKey: "agent:main:subagent:retired-acceptance",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "reject stale acceptance",
      cleanup: "keep",
      collect: true,
      groupId: "retired-acceptance",
      queued: true,
      expectsCompletionMessage: false,
    });

    expect(
      mod.startQueuedSubagentRun(
        "run-retired-acceptance",
        "gateway-retired-acceptance",
        "retired-generation",
      ),
    ).toBe(false);
    expect(mod.getSubagentRunByRunId("run-retired-acceptance")).toMatchObject({
      execution: { status: "queued" },
    });
    expect(mod.getSubagentRunByRunId("gateway-retired-acceptance")).toBeUndefined();
  });

  it("remaps a collector that completed before its acceptance response", () => {
    mod.addSubagentRunForTests(
      makeCompletedCollectorRun({
        runId: "run-terminal-race",
        childSessionKey: "agent:main:subagent:terminal-race",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "finish before acceptance",
        cleanup: "keep",
        swarmRunId: "run-terminal-race",
        schedulerSlotId: "run-terminal-race",
        swarmLaunchPending: false,
        queuedLaunch: {
          request: { sessionKey: "agent:main:subagent:terminal-race" },
          timeoutMs: 1_000,
          schedulerGroupKey: "terminal-race",
          maxConcurrent: 1,
        },
        groupId: "terminal-race",
        createdAt: 1_000,
        endedAt: 2_000,
        execution: { status: "terminal", endedAt: 2_000 },
        completion: { required: false, resultText: "done", capturedAt: 2_000 },
      }),
    );

    expect(mod.startQueuedSubagentRun("run-terminal-race", "gateway-terminal-race")).toBe(true);
    const remapped = mod.getSubagentRunByRunId("gateway-terminal-race");
    expect(mod.getSubagentRunByRunId("run-terminal-race")).toBe(remapped);
    expect(remapped).toMatchObject({
      runId: "gateway-terminal-race",
      swarmRunId: "run-terminal-race",
      collectorCompletion: { status: "done" },
      swarmLaunchPending: false,
    });
  });

  it("refuses to remap an unrelated terminal collector without a pending launch", () => {
    mod.addSubagentRunForTests(
      makeCompletedCollectorRun({
        runId: "run-terminal-stale",
        childSessionKey: "agent:main:subagent:terminal-stale",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "stale acceptance callback",
        cleanup: "keep",
        swarmRunId: "run-terminal-stale",
        schedulerSlotId: "run-terminal-stale",
        groupId: "terminal-stale",
        createdAt: 1_000,
        endedAt: 2_000,
        execution: { status: "terminal", endedAt: 2_000 },
        completion: { required: false, resultText: "done", capturedAt: 2_000 },
      }),
    );

    expect(mod.startQueuedSubagentRun("run-terminal-stale", "gateway-terminal-stale")).toBe(false);
    expect(mod.getSubagentRunByRunId("run-terminal-stale")).toMatchObject({
      runId: "run-terminal-stale",
      collectorCompletion: { status: "done" },
    });
    expect(mod.getSubagentRunByRunId("gateway-terminal-stale")).toBeUndefined();
  });

  registerRestoredRollbackPublicationTest({
    mocks,
    hydrateAndActivateRegistry,
    mockSingleCollectorConcurrency,
    mockRestoredRuns,
  });

  it("holds a restored FIFO slot while an indeterminate launch session is deleted", async () => {
    vi.useRealTimers();
    const now = Date.now();
    mockSingleCollectorConcurrency();
    mockRestoredRuns(() => [
      makeQueuedRun({
        runId: "run-restored-delete-one",
        groupId: "restore-delete",
        createdAt: now,
      }),
      makeQueuedRun({
        runId: "run-restored-delete-two",
        groupId: "restore-delete",
        createdAt: now + 1,
      }),
    ]);
    mocks.entries = {
      "agent:main:subagent:run-restored-delete-one": {
        lifecycleRevision: "revision-one",
        sessionId: "one",
        updatedAt: now,
      },
      "agent:main:subagent:run-restored-delete-two": {
        lifecycleRevision: "revision-two",
        sessionId: "two",
        updatedAt: now,
      },
    };
    let agentCalls = 0;
    let releaseDelete: (() => void) | undefined;
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent") {
        agentCalls += 1;
        if (agentCalls === 1) {
          throw new Error("launch response lost");
        }
        return { runId: "gateway-restored-second" };
      }
      if (request.method === "sessions.delete") {
        return await new Promise<Record<string, unknown>>((resolve) => {
          releaseDelete = () => resolve({});
        });
      }
      return request.method === "agent.wait" ? { status: "pending" } : {};
    });

    hydrateAndActivateRegistry();
    await waitForFast(() => expect(releaseDelete).toBeTypeOf("function"));
    expect(agentCalls).toBe(1);

    releaseDelete?.();
    await waitForFast(() => expect(agentCalls).toBe(2));
  });

  it("releases restored FIFO ownership when lifecycle rotates during failure persistence", async () => {
    vi.useRealTimers();
    const now = Date.now();
    mockSingleCollectorConcurrency();
    mockRestoredRuns(() => [
      makeQueuedRun({
        runId: "run-restored-rotation-one",
        groupId: "restore-lifecycle-rotation",
        createdAt: now,
      }),
      makeQueuedRun({
        runId: "run-restored-rotation-two",
        groupId: "restore-lifecycle-rotation",
        createdAt: now + 1,
      }),
    ]);
    mocks.entries = {
      "agent:main:subagent:run-restored-rotation-one": {
        sessionId: "one",
        lifecycleRevision: "revision-one",
        updatedAt: now,
      },
      "agent:main:subagent:run-restored-rotation-two": {
        sessionId: "two",
        lifecycleRevision: "revision-two",
        updatedAt: now,
      },
    };
    let persistenceCalls = 0;
    let concurrentSweep: Promise<void> | undefined;
    mocks.persistSubagentRunsToDiskOrThrow.mockImplementation(() => {
      persistenceCalls += 1;
      if (persistenceCalls === 1) {
        throw new Error("sqlite unavailable after Gateway acceptance");
      }
      if (persistenceCalls === 2) {
        mocks.lifecycleGeneration = "rotated-generation";
        concurrentSweep = mod.testing.sweepOnceForTests();
        throw new Error("sqlite unavailable during failure settlement");
      }
    });
    let agentCalls = 0;
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent") {
        agentCalls += 1;
        return { runId: `gateway-restored-rotation-${agentCalls}` };
      }
      return request.method === "agent.wait" ? { status: "pending" } : {};
    });

    hydrateAndActivateRegistry();

    await waitForFast(() => expect(persistenceCalls).toBeGreaterThanOrEqual(3));
    await concurrentSweep;
    await waitForFast(() => expect(agentCalls).toBe(2));
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    expect(mod.getSubagentRunByRunId("run-restored-rotation-one")).toMatchObject({
      execution: {
        status: "terminal",
        suppressSessionEffects: true,
        outcome: { status: "error" },
      },
      collectorCompletion: { status: "failed" },
    });
    expect(mod.getSubagentRunByRunId("gateway-restored-rotation-2")).toMatchObject({
      execution: { status: "running", lifecycleGeneration: "rotated-generation" },
    });
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

    hydrateAndActivateRegistry();

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

  it("rolls back a queued collector failure when persistence fails", () => {
    const runId = "run-queued-persist-failure";
    mod.addSubagentRunForTests(
      makeQueuedRun({
        runId,
        childSessionKey: "agent:main:subagent:queued-persist-failure",
        task: "remain queued after sqlite failure",
        groupId: "persist-failure",
        createdAt: Date.now(),
        queuedLaunch: {
          request: { sessionKey: "agent:main:subagent:queued-persist-failure" },
        },
      }),
    );
    mocks.persistSubagentRunsToDiskOrThrow.mockImplementationOnce(() => {
      throw new Error("sqlite busy");
    });

    expect(() => mod.testing.failQueuedSubagentRun(runId, "launch failed")).toThrow("sqlite busy");

    expect(mod.getSubagentRunByRunId(runId)).toMatchObject({
      execution: { status: "queued" },
      queuedLaunch: { maxConcurrent: 1 },
    });
    expect(mod.getSubagentRunByRunId(runId)?.collectorCompletion).toBeUndefined();
    expect(mod.getSubagentRunByRunId(runId)?.execution.endedAt).toBeUndefined();
  });

  it("keeps runs active instead of terminally failing on recoverable wait transport errors", async () => {
    mockGatewayMethods(mocks.callGateway, {
      "agent.wait": new Error("gateway closed (1006): transport close"),
    });

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
    mod.activateSubagentRegistry(
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
        expect(mocks.callGateway).toHaveBeenCalledWith(
          expect.objectContaining({ method: "agent.wait" }),
        );
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

  it.each([
    {
      name: "keeps published explicit timeout stable when pre-deadline lifecycle success arrives late",
      runId: "run-timeout-late-lifecycle-predeadline-ok",
      task: "published timeout should stay stable",
      eventStartedAfterMs: 10,
      eventEndedAfterMs: 500,
      expectCapturedReply: true,
    },
  ])(
    "$name",
    async ({ runId, task, eventStartedAfterMs, eventEndedAfterMs, expectCapturedReply }) => {
      const startedAt = Date.now();
      mockGatewayMethods(mocks.callGateway, { "agent.wait": { status: "timeout" } });
      mocks.entries = {
        "agent:main:subagent:child": createSessionEntry({
          updatedAt: startedAt,
          status: "running",
        }),
      };
      const settleRootWork = observeRootWork();
      await mod.registerSubagentRun({ runId, task, runTimeoutSeconds: 1 });

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
          ...(eventStartedAfterMs === undefined
            ? {}
            : { startedAt: startedAt + eventStartedAfterMs }),
          endedAt: startedAt + eventEndedAfterMs,
        },
      });
      await waitForFast(() => {
        const run = findRequesterRun(runId);
        expect(run?.execution.endedAt).toBe(startedAt + 1_000);
        expectRecordFields(run?.execution.outcome, {
          status: "timeout",
          startedAt,
          endedAt: startedAt + 1_000,
          elapsedMs: 1_000,
        });
        expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
      });
      if (expectCapturedReply) {
        expect(mocks.captureSubagentCompletionReply).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("refreshes unpublished timeout delivery payloads after lifecycle correction", async () => {
    const createdAt = Date.parse("2026-03-24T11:59:00Z");
    mockPendingAgentWait();
    mocks.runSubagentAnnounceFlow.mockResolvedValueOnce("retryable");
    await mod.registerSubagentRun({
      runId: "run-refresh-pending-timeout-payload",
      task: "pending timeout payload should refresh",
      runTimeoutSeconds: 60,
    });
    const run = mod.getSubagentRunByChildSessionKey("agent:main:subagent:child");
    expect(run).not.toBeNull();
    Object.assign(run ?? {}, {
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
    });

    await settleLifecycle({
      runId: "run-refresh-pending-timeout-payload",
      stream: "lifecycle",
      data: {
        phase: "end",
        startedAt: createdAt + 10_000,
        endedAt: createdAt + 65_000,
      },
    });

    const announceParams = findRecordCallArg(
      mocks.runSubagentAnnounceFlow,
      0,
      "refreshed pending delivery announce",
      (record) => record.childRunId === "run-refresh-pending-timeout-payload",
    );
    expectRecordFields(
      announceParams.outcome,
      {
        status: "ok",
        startedAt: createdAt + 10_000,
        endedAt: createdAt + 65_000,
        elapsedMs: 55_000,
      },
      "refreshed pending delivery outcome",
    );
  });

  it("caps lifecycle timeout events to the explicit run deadline", async () => {
    const startedAt = Date.now();
    mockPendingAgentWait();

    const settleRootWork = observeRootWork();
    await mod.registerSubagentRun({
      runId: "run-lifecycle-timeout-after-deadline",
      task: "post-deadline lifecycle timeout should cap",
      runTimeoutSeconds: 1,
    });

    const lifecycleHandler = getLifecycleHandler();

    lifecycleHandler?.({
      runId: "run-lifecycle-timeout-after-deadline",
      stream: "lifecycle",
      data: {
        phase: "end",
        startedAt,
        endedAt: startedAt + 2_000,
        aborted: true,
      },
    });
    await vi.advanceTimersByTimeAsync(30_000);

    await waitForFast(() => {
      const run = findRequesterRun("run-lifecycle-timeout-after-deadline");
      expect(run?.execution.endedAt).toBe(startedAt + 1_000);
      expectRecordFields(
        run?.execution.outcome,
        {
          status: "timeout",
          startedAt,
          endedAt: startedAt + 1_000,
          elapsedMs: 1_000,
        },
        "capped lifecycle timeout outcome",
      );
    });
    await settleRootWork();
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
  });

  it("treats boundary agent.wait timeouts as explicit run timeouts before child abort errors win", async () => {
    const startedAt = Date.now();
    let waitAttempts = 0;
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
      const completedRun = findRequesterRun("run-boundary-timeout");
      expect(waitAttempts).toBe(1);
      expect(completedRun?.execution.endedAt).toBe(startedAt + 1_000);
      expectRecordFields(
        completedRun?.execution.outcome,
        {
          status: "timeout",
          startedAt,
          endedAt: startedAt + 1_000,
          elapsedMs: 1_000,
        },
        "boundary explicit run timeout outcome",
      );
    });
    await settleRootWork();
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
  });

  registerRestoredRunDeadlineSettlementTests({
    getRegistry: () => mod,
    mocks,
    hydrateAndActivateRegistry,
  });

  it.each([
    {
      name: "uses running session-store start time for plain agent.wait timeouts",
      runId: "run-plain-timeout-session-store-start",
      task: "do not timeout before session store start deadline",
      initialNowAfterMs: 0,
      sessionStartedAfterMs: 10_000,
      observedStartedAfterMs: 10_000,
      sessionUpdatedAfterMs: 61_000,
      advanceOnFirstWait: true,
      label: "session store start plain wait timeout outcome",
    },
  ] as const)(
    "$name",
    async ({
      runId,
      task,
      initialNowAfterMs,
      sessionStartedAfterMs,
      observedStartedAfterMs,
      sessionUpdatedAfterMs,
      advanceOnFirstWait,
      label,
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
        return { status: "timeout" };
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
        expect(run?.execution.endedAt).toBe(observedStartedAt + 60_000);
        expectRecordFields(
          run?.execution.outcome,
          {
            status: "timeout",
            startedAt: observedStartedAt,
            endedAt: observedStartedAt + 60_000,
            elapsedMs: 60_000,
          },
          label,
        );
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
    hydrateAndActivateRegistry();

    await waitForFast(() => {
      expect(waitTimeouts).toEqual([1_000]);
      const completedRun = findRequesterRun("run-resumed-near-deadline");
      expect(completedRun?.execution.endedAt).toBe(startedAt + 60_000);
      expectRecordFields(
        completedRun?.execution.outcome,
        {
          status: "timeout",
          startedAt,
          endedAt: startedAt + 60_000,
          elapsedMs: 60_000,
        },
        "restored explicit run timeout outcome",
      );
    });
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
    let resolveSecondWait: (value: {
      status: "ok";
      startedAt: number;
      endedAt: number;
    }) => void = () => {};
    const secondWait = new Promise<{ status: "ok"; startedAt: number; endedAt: number }>(
      (resolve) => {
        resolveSecondWait = resolve;
      },
    );
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        waitAttempts += 1;
        if (waitAttempts === 1) {
          return { status: "timeout" };
        }
        return secondWait;
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

    resolveSecondWait({
      status: "ok",
      startedAt: Date.parse("2026-03-24T12:00:01Z"),
      endedAt: Date.parse("2026-03-24T12:00:02Z"),
    });
    await waitForFast(() => {
      const completedRun = findRequesterRun("run-reactivated-timeout");
      expectRecordFields(
        completedRun?.execution.outcome,
        { status: "ok" },
        "reactivated run outcome",
      );
    });
  });

  it.each([{ stopReason: "aborted" }])(
    "settles a collector yield seen through agent.wait without canceling it: %o",
    async (extra) => {
      const runId = "run-wait-collector-yield";
      mockGatewayMethods(mocks.callGateway, {
        "agent.wait": {
          status: "ok",
          startedAt: 111,
          endedAt: 222,
          livenessState: "paused",
          yielded: true,
          ...extra,
        },
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
      } finally {
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
      expect(findRequesterRun(runId)?.endedReason).not.toBe(SUBAGENT_ENDED_REASON_KILLED);
    },
  );

  registerForcedCollectorCompletionSettlementTests({
    getRegistry: () => mod,
    mocks,
    findRequesterRun,
    getLifecycleHandler,
    mockPendingAgentWait,
  });

  it.each([
    { observation: "lifecycle", kind: "outer-timeout" },
    { observation: "wait", kind: "timeout" },
    { observation: "lifecycle", kind: "blocked" },
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
          : kind === "outer-timeout"
            ? { status: "ok", aborted: true, stopReason: "timeout", livenessState: "paused" }
            : {
                status: "timeout",
                aborted: true,
                stopReason: "timeout",
                timeoutPhase: "provider",
                providerStarted: true,
              }),
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

  describe("sessions_yield follow-up adoption", () => {
    const CHILD_SESSION_KEY = "agent:main:subagent:yield-followup";
    const PAUSED_RUN_ID = "run-yield-followup-paused";
    const FOLLOW_UP_RUN_ID = "run-yield-followup-continued";
    const SIBLING_RUN_ID = "run-yield-followup-sibling";

    /**
     * Drives a child run to the paused state a `sessions_yield` produces, then
     * arms the wake credential that `settleRequesterTurnAfterSessionSpawns`
     * writes when the parent yields behind its own spawn batch.
     */
    const arrangePausedChildWithYieldedRequester = async () => {
      mockGatewayMethods(mocks.callGateway, {
        "agent.wait": {
          status: "ok",
          startedAt: 111,
          endedAt: 222,
          stopReason: "end_turn",
          livenessState: "paused",
          yielded: true,
        },
      });
      await mod.registerSubagentRun({
        runId: PAUSED_RUN_ID,
        childSessionKey: CHILD_SESSION_KEY,
        task: "wait for the remote job",
      });
      const paused = await waitForFast(() => {
        const run = expectDefined(findRequesterRun(PAUSED_RUN_ID), "paused subagent run");
        expect(run.pauseReason).toBe("sessions_yield");
        return run;
      });
      paused.requesterSettleWake = {
        status: "pending",
        attemptCount: 0,
        requesterYieldBatch: true,
        afterRequesterYield: true,
        rearmGeneration: 1,
        batchRunIds: [SIBLING_RUN_ID, PAUSED_RUN_ID].toSorted(),
      };
      expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
      return paused;
    };

    it("announces to the original requester once the adopted follow-up ends normally", async () => {
      await arrangePausedChildWithYieldedRequester();

      mockGatewayMethods(mocks.callGateway, {
        "agent.wait": {
          status: "ok",
          startedAt: 333,
          endedAt: 444,
          stopReason: "end_turn",
        },
      });
      expect(
        mod.adoptPausedSubagentRunForFollowUp({
          childSessionKey: CHILD_SESSION_KEY,
          runId: FOLLOW_UP_RUN_ID,
          task: "the remote job finished",
        }),
      ).toBe(true);

      expect(findRequesterRun(PAUSED_RUN_ID)).toBeUndefined();
      const adopted = expectDefined(findRequesterRun(FOLLOW_UP_RUN_ID), "adopted follow-up run");
      // Adoption continues the same unit of work: the requester identity that
      // spawned the paused run must survive, or the announce lands on the
      // child's own session instead of the waiting parent.
      expect(adopted.requesterSessionKey).toBe("agent:main:main");
      expect(adopted.task).toBe("the remote job finished");
      expect(adopted.pauseReason).toBeUndefined();
      // The frozen batch is addressed by runId, so the retired id must be
      // remapped or this row drops out of the batch it still gates.
      expect(adopted.requesterSettleWake?.batchRunIds).toEqual(
        [SIBLING_RUN_ID, FOLLOW_UP_RUN_ID].toSorted(),
      );
      expect(adopted.requesterSettleWake).toMatchObject({
        requesterYieldBatch: true,
        rearmGeneration: 1,
      });

      await waitForFast(() => {
        expect(
          expectDefined(findRequesterRun(FOLLOW_UP_RUN_ID), "adopted follow-up run").execution
            .endedAt,
        ).toBe(444);
        expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalled();
      });
    });
  });

  it("ignores a late yield lifecycle event after the paused run is killed", async () => {
    mockPendingAgentWait();
    const runId = "run-yield-killed-before-late-event";
    const childSessionKey = "agent:main:subagent:yield-killed-before-late-event";
    await mod.registerSubagentRun({
      runId,
      childSessionKey,
      task: "stop while paused",
    });
    const lifecycleHandler = getLifecycleHandler();

    lifecycleHandler?.({
      runId,
      stream: "lifecycle",
      data: { phase: "end", startedAt: 111, endedAt: 222, yielded: true },
    });
    expect(await mod.markSubagentRunTerminated({ runId, childSessionKey, reason: "killed" })).toBe(
      1,
    );
    const killed = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((run) => run.runId === runId);
    expect(killed).toMatchObject({
      execution: { status: "terminal", endedAt: 222 },
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      cleanupHandled: true,
      suppressAnnounceReason: "killed",
    });
    expect(killed?.pauseReason).toBeUndefined();
    const killedCleanupAt = killed?.cleanupCompletedAt;

    lifecycleHandler?.({
      runId,
      stream: "lifecycle",
      data: { phase: "end", startedAt: 111, endedAt: 333, yielded: true },
    });

    const afterLateYield = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((run) => run.runId === runId);
    expect(afterLateYield).toMatchObject({
      execution: { status: "terminal", endedAt: 222 },
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      cleanupHandled: true,
      cleanupCompletedAt: killedCleanupAt,
      suppressAnnounceReason: "killed",
    });
    expect(afterLateYield?.pauseReason).toBeUndefined();
  });

  it("accepts an authoritative late yield after non-kill cleanup started", async () => {
    mockPendingAgentWait();
    const runId = "run-yield-after-success-cleanup";
    await mod.registerSubagentRun({
      runId,
      childSessionKey: "agent:main:subagent:yield-after-success-cleanup",
      task: "pause after terminal projection",
    });
    const lifecycleHandler = getLifecycleHandler();
    const run = findRequesterRun(runId);
    expect(run).toBeDefined();
    Object.assign(run!, {
      endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
      execution: {
        ...run!.execution,
        status: "terminal",
        endedAt: 222,
        outcome: { status: "ok" as const },
      },
      cleanupHandled: true,
      cleanupCompletedAt: 223,
      delivery: { status: "delivered" as const, deliveredAt: 223 },
    });

    lifecycleHandler?.({
      runId,
      stream: "lifecycle",
      data: { phase: "end", startedAt: 111, endedAt: 333, yielded: true },
    });

    expect(run).toMatchObject({
      execution: { status: "terminal", endedAt: 333 },
      pauseReason: "sessions_yield",
      cleanupHandled: false,
      delivery: { status: "pending" },
    });
    expect(run?.endedReason).toBeUndefined();
    expect(run?.execution.outcome).toBeUndefined();
    expect(run?.cleanupCompletedAt).toBeUndefined();
  });

  it("cancels a pending grace timer when a yield follows an intermediate aborted terminal (#92448)", async () => {
    // An earlier aborted terminal schedules a deferred kill grace timer; a
    // following yield must clear it, or it fires and settles the now-paused run.
    mockPendingAgentWait();

    await mod.registerSubagentRun({
      runId: "run-yield-after-pending-timeout",
      childSessionKey: "agent:main:subagent:pending-timeout",
      task: "wait for child continuation",
    });

    const lifecycleHandler = getLifecycleHandler();

    // Intermediate aborted terminal → schedules the deferred kill grace timer.
    lifecycleHandler?.({
      runId: "run-yield-after-pending-timeout",
      stream: "lifecycle",
      data: { phase: "end", startedAt: 111, endedAt: 222, aborted: true },
    });
    // Yield terminal → must pause and cancel the pending grace timer.
    lifecycleHandler?.({
      runId: "run-yield-after-pending-timeout",
      stream: "lifecycle",
      data: { phase: "end", startedAt: 111, endedAt: 333, yielded: true, aborted: true },
    });

    await waitForFast(() => {
      const run = findRequesterRun("run-yield-after-pending-timeout");
      expect(run?.pauseReason).toBe("sessions_yield");
    });

    // Advancing well past the 15s grace window must not undo the pause.
    await vi.advanceTimersByTimeAsync(60_000);
    const run = findRequesterRun("run-yield-after-pending-timeout");
    expect(run?.pauseReason).toBe("sessions_yield");
    expect(run?.execution.outcome?.status).not.toBe("error");
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
  });

  it("cancels a pending timeout grace timer when the run is explicitly killed", async () => {
    mockPendingAgentWait();
    const runId = "run-killed-after-pending-timeout";
    await mod.registerSubagentRun({
      runId,
      childSessionKey: "agent:main:subagent:killed-after-pending-timeout",
      task: "stop during timeout grace",
    });

    const lifecycleHandler = getLifecycleHandler();

    lifecycleHandler?.({
      runId,
      stream: "lifecycle",
      data: { phase: "end", startedAt: 111, endedAt: 222, aborted: true },
    });
    expect(await mod.markSubagentRunTerminated({ runId, reason: "manual kill" })).toBe(1);

    await vi.advanceTimersByTimeAsync(60_000);
    const run = findRequesterRun(runId);
    expect(run).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      execution: { outcome: { status: "error", error: "manual kill" } },
    });
    expect(run?.execution.outcome?.status).not.toBe("timeout");
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
  });

  it("cancels a pending grace timer when agent.wait observes the yield after an aborted terminal (#92448)", async () => {
    let resolveWait: (value: {
      status: "ok";
      startedAt: number;
      endedAt: number;
      yielded: true;
    }) => void = () => {};
    const waitResult = new Promise<{
      status: "ok";
      startedAt: number;
      endedAt: number;
      yielded: true;
    }>((resolve) => {
      resolveWait = resolve;
    });
    mockGatewayMethods(mocks.callGateway, {
      "agent.wait": waitResult,
    });

    await mod.registerSubagentRun({
      runId: "run-wait-yield-after-pending-timeout",
      childSessionKey: "agent:main:subagent:pending-wait-timeout",
      task: "wait for child continuation through wait",
    });

    const lifecycleHandler = getLifecycleHandler();

    lifecycleHandler?.({
      runId: "run-wait-yield-after-pending-timeout",
      stream: "lifecycle",
      data: { phase: "end", startedAt: 111, endedAt: 222, aborted: true },
    });
    resolveWait({ status: "ok", startedAt: 111, endedAt: 333, yielded: true });

    await waitForFast(() => {
      const run = findRequesterRun("run-wait-yield-after-pending-timeout");
      expect(run?.pauseReason).toBe("sessions_yield");
    });

    await vi.advanceTimersByTimeAsync(60_000);
    const run = findRequesterRun("run-wait-yield-after-pending-timeout");
    expect(run?.pauseReason).toBe("sessions_yield");
    expect(run?.execution.outcome?.status).not.toBe("timeout");
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "announces blocked agent.wait snapshots as errors instead of success",
      runId: "run-blocked-wait",
      task: "overflow wait",
      wait: {
        status: "ok",
        error: "Context overflow: prompt too large for the model.",
      },
      expectedOutcome: {
        status: "error",
        error: "Context overflow: prompt too large for the model.",
      },
      expectedReason: "subagent-error",
      label: "blocked wait announce",
    },
    {
      name: "announces terminal failures whose diagnostics resemble transport errors",
      runId: "run-diagnostic-transport-wait",
      task: "report failed child",
      wait: {
        status: "error",
        error: "child exited with code 1\nstderr: socket hang up",
        livenessState: undefined,
      },
      expectedOutcome: {
        status: "error",
        error: "child exited with code 1\nstderr: socket hang up",
      },
      expectedReason: "subagent-error",
      label: "diagnostic transport wait announce",
    },
  ] as const)("$name", async ({ runId, task, wait, expectedOutcome, expectedReason, label }) => {
    mockGatewayMethods(mocks.callGateway, {
      "agent.wait": {
        startedAt: 100,
        endedAt: 250,
        livenessState: "blocked",
        ...wait,
      },
    });

    const settleRootWork = observeRootWork();
    try {
      await mod.registerSubagentRun({ runId, task, expectsCompletionMessage: true });
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      await settleRootWork();
    }

    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    const announceParams = expectRecordFields(
      getMockCallArg(mocks.runSubagentAnnounceFlow, 0, 0, label),
      { childRunId: runId },
      `${label} params`,
    );
    expectRecordFields(
      announceParams.outcome,
      { ...expectedOutcome, startedAt: 100, endedAt: 250, elapsedMs: 150 },
      `${label} outcome`,
    );

    const run = findRequesterRun(runId);
    expect(run?.endedReason).toBe(expectedReason);
    expect(run?.execution.outcome?.status).toBe(expectedOutcome.status);
  });

  it("carries producer reply evidence through a provider hard-timeout wait", async () => {
    mockGatewayMethods(mocks.callGateway, {
      "agent.wait": {
        status: "error",
        startedAt: 100,
        endedAt: 250,
        livenessState: "blocked",
        timeoutPhase: "provider",
        providerStarted: true,
        error: "model timed out",
        terminalReply: { disposition: "empty" },
      },
    });

    const settleRootWork = observeRootWork();
    try {
      await mod.registerSubagentRun({
        runId: "run-hard-timeout-terminal-reply",
        task: "provider timeout reply evidence",
        expectsCompletionMessage: true,
      });
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      await settleRootWork();
    }

    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    expect(getMockCallArg(mocks.runSubagentAnnounceFlow, 0, 0, "timeout announce")).toMatchObject({
      childRunId: "run-hard-timeout-terminal-reply",
      outcome: { status: "timeout" },
      terminalReply: { disposition: "empty" },
    });
    expect(findRequesterRun("run-hard-timeout-terminal-reply")?.completion).toMatchObject({
      terminalReply: { disposition: "empty" },
      resultText: null,
    });
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

  it("retires stable operator cancellation despite a late persisted completion", async () => {
    {
      const now = Date.parse("2026-03-24T12:00:00Z");
      const startedAt = now - 10_000;
      const killedAt = now - 1_000;
      const completedAt = now;
      const runId = "run-killed-stable-cancellation";
      const childSessionKey = "agent:main:subagent:stable-cancellation";
      mocks.entries = {
        [childSessionKey]: {
          lifecycleRevision: "revision-stable-cancellation",
          sessionId: "sess-stable-cancellation",
          updatedAt: completedAt,
          status: "done",
          startedAt,
          endedAt: completedAt,
        },
      };
      mod.addSubagentRunForTests(
        makeKilledRun(killedAt, {
          runId,
          childSessionKey,
          task: "preserve operator cancellation",
          killReconciliation: { killedAt, taskCancellationAccepted: true },
          cleanup: "delete",
          expectsCompletionMessage: true,
          createdAt: startedAt,
          startedAt,
          archiveAtMs: Date.now(),
        }),
      );

      expect(killedAt + 5 * 60_000).toBeGreaterThan(Date.now());
      vi.setSystemTime(killedAt + 5 * 60_000);

      await mod.testing.sweepOnceForTests();

      await waitForFast(() => {
        expect(
          mod
            .listSubagentRunsForRequester("agent:main:main")
            .some((entry) => entry.runId === runId),
        ).toBe(false);
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
      });
      expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
    }
  });

  it("restores an explicit timeout that predates stable operator cancellation", async () => {
    {
      const now = Date.parse("2026-03-24T12:00:00Z");
      const startedAt = now - 10_000;
      const timeoutAt = now - 2_000;
      const killedAt = now - 1_000;
      const completedAt = now;
      const runId = "run-completed-before-stable-cancellation";
      const childSessionKey = "agent:main:subagent:completed-before-cancellation";
      mocks.entries = {
        [childSessionKey]: {
          sessionId: "sess-completed-before-cancellation",
          updatedAt: completedAt,
          status: "killed",
          startedAt,
          endedAt: completedAt,
        },
      };
      mod.addSubagentRunForTests(
        makeKilledRun(killedAt, {
          runId,
          childSessionKey,
          task: "preserve earlier completion",
          killReconciliation: { killedAt, taskCancellationAccepted: true },
          expectsCompletionMessage: false,
          createdAt: startedAt,
          startedAt,
          runTimeoutSeconds: 8,
        }),
      );

      vi.setSystemTime(killedAt + 5 * 60_000);
      await mod.testing.sweepOnceForTests();

      await waitForFast(() => {
        const run = findRequesterRun(runId);
        expect(run).toMatchObject({
          endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
          execution: {
            status: "terminal",
            endedAt: timeoutAt,
            outcome: { status: "timeout", startedAt, endedAt: timeoutAt },
          },
        });
        expect(run?.execution.outcome?.error).toBeUndefined();
      });
    }
  });

  it("suppresses registry delivery when cancellation becomes durable during capture", async () => {
    {
      const now = Date.now();
      const killedAt = now - 5 * 60_000;
      const startedAt = killedAt - 10_000;
      const completedAt = killedAt + 1_000;
      const runId = "run-cancelled-during-sweep-capture";
      const childSessionKey = "agent:main:subagent:cancelled-during-sweep-capture";
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
      mod.addSubagentRunForTests(
        makeKilledRun(killedAt, {
          runId,
          childSessionKey,
          task: "cancel during result capture",
          expectsCompletionMessage: false,
          createdAt: startedAt,
          startedAt,
        }),
      );

      const cancelledRun = expectDefined(subagentRuns.get(runId), "cancelled run fixture");
      const settleRootWork = observeRootWork();
      try {
        const sweep = mod.testing.sweepOnceForTests();
        await captureEntered.promise;
        expectDefined(
          cancelledRun.killReconciliation,
          "cancelled run reconciliation",
        ).taskCancellationAccepted = true;
        persistSubagentRunsToDiskOrThrow(subagentRuns, [runId]);
        finishCapture.resolve("late provider result");
        await sweep;
      } finally {
        finishCapture.resolve("late provider result");
        // Sweep completion hands retirement to detached requester-settle work.
        await settleRootWork();
      }

      expect(cancelledRun).toMatchObject({
        endedReason: SUBAGENT_ENDED_REASON_KILLED,
        execution: {
          status: "terminal",
          endedAt: killedAt,
          outcome: { status: "error", error: "manual kill" },
        },
      });
      expect(cancelledRun.completion?.resultText).toBeUndefined();
      expect(cancelledRun.requesterSettleWake).toBeUndefined();
      expect(subagentRuns.has(runId)).toBe(false);
      expect(findRequesterRun(runId)).toBeUndefined();
      expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
    }
  });

  it("uses the kill time when reconciling a yielded run", async () => {
    {
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
      mod.addSubagentRunForTests({
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
    }
  });

  it("expires a tombstone instead of replaying persisted killed state", async () => {
    const startedAt = Date.parse("2026-03-24T11:50:00Z");
    const endedAt = Date.parse("2026-03-24T11:55:00Z");
    mocks.entries = {
      "agent:main:subagent:child": createSessionEntry({
        updatedAt: endedAt,
        status: "killed",
        startedAt,
        endedAt,
      }),
    };
    mod.addSubagentRunForTests(
      makeKilledRun(endedAt, {
        runId: "run-killed-with-persisted-kill",
        task: "expire persisted kill",
        expectsCompletionMessage: false,
        createdAt: startedAt,
        startedAt,
      }),
    );

    await mod.testing.sweepOnceForTests();

    await waitForFast(() => {
      expect(
        mod
          .listSubagentRunsForRequester("agent:main:main")
          .some((entry) => entry.runId === "run-killed-with-persisted-kill"),
      ).toBe(false);
    });
  });

  it("keeps requester stop delivery suppressed after kill reconciliation", async () => {
    const killedAt = Date.now() - 5 * 60_000;
    mod.addSubagentRunForTests(
      makeKilledRun(killedAt, {
        runId: "run-requester-stop-suppressed",
        childSessionKey: "agent:main:subagent:requester-stop-suppressed",
        task: "do not re-inject after stop",
        expectsCompletionMessage: true,
        createdAt: killedAt - 60_000,
        killReconciliation: { killedAt, suppressTaskDelivery: true },
      }),
    );

    await mod.testing.sweepOnceForTests();
    await waitForFast(() => {
      expect(
        mod
          .listSubagentRunsForRequester("agent:main:main")
          .some((entry) => entry.runId === "run-requester-stop-suppressed"),
      ).toBe(false);
    });

    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
  });

  it("retires a superseded tombstone after its newer generation is released", async () => {
    const killedAt = Date.now() - 5 * 60_000;
    const childSessionKey = "agent:main:subagent:released-successor";
    mockPendingAgentWait();
    mod.addSubagentRunForTests(
      makeKilledRun(killedAt, {
        runId: "run-released-successor-old",
        childSessionKey,
        task: "retire only old ownership",
        cleanup: "delete",
        createdAt: killedAt - 60_000,
      }),
    );
    await mod.registerSubagentRun({
      runId: "run-released-successor-new",
      childSessionKey,
      task: "new generation",
    });
    const oldRun = findRequesterRun("run-released-successor-old");
    expect(oldRun?.killReconciliation?.supersededAt).toBe(Date.now());
    mod.releaseSubagentRun("run-released-successor-new");

    await mod.testing.sweepOnceForTests();

    expect(
      mod
        .listSubagentRunsForRequester("agent:main:main")
        .some((entry) => entry.runId === "run-released-successor-old"),
    ).toBe(false);
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(
      mocks.callGateway.mock.calls.some(
        ([request]) => (request as { method?: string } | undefined)?.method === "sessions.delete",
      ),
    ).toBe(false);
  });

  it("does not reconcile an old tombstone from a newer run completion", async () => {
    const oldStartedAt = Date.parse("2026-03-24T11:50:00Z");
    const oldEndedAt = Date.parse("2026-03-24T11:55:00Z");
    const newStartedAt = Date.parse("2026-03-24T11:58:00Z");
    const newEndedAt = Date.parse("2026-03-24T11:59:00Z");
    mocks.entries = {
      "agent:main:subagent:reused": {
        sessionId: "sess-reused",
        updatedAt: newEndedAt,
        status: "done",
        startedAt: newStartedAt,
        endedAt: newEndedAt,
      },
    };
    mocks.getAgentRunContext.mockImplementation((runId: string) =>
      runId === "run-new-generation" ? ({} as never) : undefined,
    );
    mocks.getGlobalHookRunner.mockReturnValue({
      hasHooks: (hookName: string) => hookName === "subagent_ended",
      runSubagentEnded: mocks.runSubagentEnded,
    } as never);
    const attachmentsRootDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-old-tombstone-attachments-"),
    );
    const attachmentsDir = path.join(attachmentsRootDir, "child");
    await fs.mkdir(attachmentsDir, { recursive: true });
    await fs.writeFile(path.join(attachmentsDir, "artifact.txt"), "artifact");
    const oldTranscriptTarget = {
      agentId: "main",
      sessionId: "internal-run-old-tombstone",
      sessionKey: "agent:main:internal-session-effects:run-old-tombstone",
      storePath: "/tmp/test-store",
    };
    mod.addSubagentRunForTests(
      makeKilledRun(oldEndedAt, {
        runId: "run-old-tombstone",
        childSessionKey: "agent:main:subagent:reused",
        task: "old generation",
        cleanup: "delete",
        createdAt: oldStartedAt,
        startedAt: oldStartedAt,
        sessionStartedAt: oldStartedAt,
        archiveAtMs: Date.now(),
        retainAttachmentsOnKeep: true,
        attachmentsDir,
        attachmentsRootDir,
        execution: {
          status: "terminal",
          startedAt: oldStartedAt,
          endedAt: oldEndedAt,
          transcriptTarget: oldTranscriptTarget,
        },
      }),
    );
    mod.addSubagentRunForTests({
      runId: "run-new-generation",
      childSessionKey: "agent:main:subagent:reused",
      task: "new generation",
      createdAt: newStartedAt,
      startedAt: newStartedAt,
      sessionStartedAt: newStartedAt,
    });

    await mod.testing.sweepOnceForTests();

    const runs = mod.listSubagentRunsForRequester("agent:main:main");
    expect(runs.some((entry) => entry.runId === "run-old-tombstone")).toBe(false);
    const newRun = runs.find((entry) => entry.runId === "run-new-generation");
    expect(newRun).toBeDefined();
    expect(newRun?.execution.endedAt).toBeUndefined();
    expect(newRun?.execution.outcome).toBeUndefined();
    expect(mocks.runSubagentEnded).not.toHaveBeenCalled();
    expect(
      mocks.onSubagentEnded.mock.calls.some(
        ([params]) => params.childSessionKey === "agent:main:subagent:reused",
      ),
    ).toBe(false);
    expect(mocks.removeInternalSessionEffectsSession).toHaveBeenCalledWith(oldTranscriptTarget);
    await expect(fs.access(attachmentsDir)).resolves.toBeUndefined();
    expect(
      mocks.callGateway.mock.calls.some(
        ([request]) => (request as { method?: string } | undefined)?.method === "sessions.delete",
      ),
    ).toBe(false);
  });

  it("checks the raw completion time before clamping an old run deadline", async () => {
    {
      const oldStartedAt = Date.parse("2026-03-24T11:50:00Z");
      const oldKilledAt = Date.parse("2026-03-24T11:55:00Z");
      const newStartedAt = Date.parse("2026-03-24T11:58:00Z");
      const newEndedAt = Date.parse("2026-03-24T11:59:00Z");
      const childSessionKey = "agent:main:subagent:reused-no-start";
      mocks.entries = {
        [childSessionKey]: {
          sessionId: "sess-reused-no-start",
          updatedAt: newEndedAt,
          status: "done",
          endedAt: newEndedAt,
        },
      };
      mod.addSubagentRunForTests(
        makeKilledRun(oldKilledAt, {
          runId: "run-old-no-start",
          childSessionKey,
          task: "keep old cancellation canonical",
          createdAt: oldStartedAt,
          startedAt: oldStartedAt,
          runTimeoutSeconds: 60,
        }),
      );
      mod.addSubagentRunForTests({
        runId: "run-new-no-start",
        childSessionKey,
        task: "new generation without persisted start time",
        createdAt: newStartedAt,
        startedAt: newStartedAt,
        generation: 2,
      });

      await mod.testing.sweepOnceForTests();
      expect(resolveSubagentSessionStatus(subagentRuns.get("run-old-no-start"))).not.toBe(
        "timeout",
      );
      expect(
        mod
          .listSubagentRunsForRequester("agent:main:main")
          .some((entry) => entry.runId === "run-old-no-start"),
      ).toBe(false);
    }
  });

  registerSupersededNativeTimingTest({ getRegistry: () => mod, mocks, mockPendingAgentWait });

  it("reconciles an old completion without touching the newer session generation", async () => {
    const oldStartedAt = Date.parse("2026-03-24T11:50:00Z");
    const oldKilledAt = Date.parse("2026-03-24T11:55:00Z");
    const oldCompletedAt = Date.parse("2026-03-24T11:56:00Z");
    const newStartedAt = Date.parse("2026-03-24T11:58:00Z");
    const childSessionKey = "agent:main:subagent:reused-completed";
    mocks.entries = {
      [childSessionKey]: {
        sessionId: "sess-reused-completed",
        updatedAt: oldCompletedAt,
        status: "done",
        startedAt: oldStartedAt,
        endedAt: oldCompletedAt,
      },
    };
    const originalEntry = structuredClone(mocks.entries[childSessionKey]);
    mocks.getAgentRunContext.mockImplementation((runId: string) =>
      runId === "run-new-generation-after-completion" ? ({} as never) : undefined,
    );
    mocks.getGlobalHookRunner.mockReturnValue({
      hasHooks: (hookName: string) => hookName === "subagent_ended",
      runSubagentEnded: mocks.runSubagentEnded,
    } as never);
    mod.addSubagentRunForTests(
      makeKilledRun(oldKilledAt, {
        runId: "run-old-completed-tombstone",
        childSessionKey,
        task: "old completed generation",
        cleanup: "delete",
        createdAt: oldStartedAt,
        startedAt: oldStartedAt,
        sessionStartedAt: oldStartedAt,
      }),
    );
    mod.addSubagentRunForTests({
      runId: "run-new-generation-after-completion",
      childSessionKey,
      task: "new generation",
      createdAt: newStartedAt,
      startedAt: newStartedAt,
      sessionStartedAt: newStartedAt,
    });

    await mod.testing.sweepOnceForTests();

    const runs = mod.listSubagentRunsForRequester("agent:main:main");
    expect(runs.some((entry) => entry.runId === "run-old-completed-tombstone")).toBe(false);
    const newRun = runs.find((entry) => entry.runId === "run-new-generation-after-completion");
    expect(newRun).toBeDefined();
    expect(newRun?.execution.endedAt).toBeUndefined();
    expect(newRun?.execution.outcome).toBeUndefined();
    expect(
      mocks.callGateway.mock.calls.some(
        ([request]) => (request as { method?: string } | undefined)?.method === "sessions.delete",
      ),
    ).toBe(false);
    expect(mocks.entries[childSessionKey]).toEqual(originalEntry);
    expect(
      mocks.emitSessionLifecycleEvent.mock.calls.some(
        ([event]) => (event as { sessionKey?: string }).sessionKey === childSessionKey,
      ),
    ).toBe(false);
    expect(mocks.runSubagentEnded).not.toHaveBeenCalled();
    expect(
      mocks.onSubagentEnded.mock.calls.some(
        ([params]) => params.childSessionKey === childSessionKey,
      ),
    ).toBe(false);
  });

  it("uses session-store start time when sweeping stale explicit-timeout runs", async () => {
    mockPendingAgentWait();
    const createdAt = Date.parse("2026-03-24T11:59:00Z");
    const sessionStartedAt = createdAt + 10_000;
    const sessionEndedAt = createdAt + 65_000;
    mocks.entries = {
      "agent:main:subagent:child": createSessionEntry({
        updatedAt: sessionEndedAt,
        status: "done",
        startedAt: sessionStartedAt,
        endedAt: sessionEndedAt,
      }),
    };

    vi.setSystemTime(createdAt);
    await mod.registerSubagentRun({
      runId: "run-sweep-session-start",
      task: "sweep should respect session store start",
      runTimeoutSeconds: 60,
    });

    vi.setSystemTime(createdAt + 120_000);
    await mod.testing.sweepOnceForTests();

    await waitForFast(() => {
      const run = findRequesterRun("run-sweep-session-start");
      expect(run?.execution.endedAt).toBe(sessionEndedAt);
      expectRecordFields(
        run?.execution.outcome,
        {
          status: "ok",
          startedAt: sessionStartedAt,
          endedAt: sessionEndedAt,
          elapsedMs: 55_000,
        },
        "swept session store observed start outcome",
      );
    });
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
  });

  it("settles restart-aborted runs without redispatching child work", async () => {
    mockPendingAgentWait();
    mocks.entries = {
      "agent:main:subagent:child": createSessionEntry({
        updatedAt: Date.now(),
        status: "running",
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

  it("retries completion after a transient durable registry write failure", async () => {
    mocks.persistSubagentRunsToDiskOrThrow
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error("transient disk error");
      })
      .mockImplementation(() => {});

    await mod.registerSubagentRun({
      runId: "run-retry-durable-completion",
      childSessionKey: "agent:main:subagent:retry-durable-completion",
      task: "retry durable completion",
      expectsCompletionMessage: false,
    });

    await waitForFast(() => {
      const run = findRequesterRun("run-retry-durable-completion");
      expect(run).toMatchObject({
        endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
        execution: {
          status: "terminal",
          endedAt: 222,
          outcome: { status: "ok", startedAt: 111, endedAt: 222 },
        },
      });
      expect(mocks.persistSubagentRunsToDiskOrThrow.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
  });

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
      livenessState: "blocked",
      runId: "run-blocked-end",
      task: "overflow task",
      error: "Context overflow: prompt too large for the model.",
    },
    {
      livenessState: "abandoned",
      runId: "run-abandoned-end",
      task: "incomplete tool chain",
      error: "Agent run ended before producing a complete result.",
    },
  ] as const)(
    "announces $livenessState lifecycle end events as errors instead of success",
    async ({ livenessState, runId, task, error }) => {
      mockPendingAgentWait();

      await mod.registerSubagentRun({
        runId,
        task,
        expectsCompletionMessage: true,
      });

      const lifecycleHandler = getLifecycleHandler();

      lifecycleHandler?.({
        runId,
        stream: "lifecycle",
        data: {
          phase: "start",
          startedAt: 10,
        },
      });
      lifecycleHandler?.({
        runId,
        stream: "lifecycle",
        data: {
          phase: "end",
          startedAt: 10,
          endedAt: 20,
          livenessState,
          ...(livenessState === "blocked" ? { error } : { replayInvalid: true }),
        },
      });

      await waitForFast(() => {
        expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
      });
      const announceParams = expectRecordFields(
        getMockCallArg(mocks.runSubagentAnnounceFlow, 0, 0, `${livenessState} announce`),
        { childRunId: runId },
        `${livenessState} announce params`,
      );
      expectRecordFields(
        announceParams.outcome,
        {
          status: "error",
          error,
          startedAt: 10,
          endedAt: 20,
          elapsedMs: 10,
        },
        `${livenessState} announce outcome`,
      );

      const run = findRequesterRun(runId);
      expect(run?.endedReason).toBe("subagent-error");
      expect(run?.execution.outcome?.status).toBe("error");
    },
  );

  it.each([
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
    mockPendingAgentWait();
    await mod.registerSubagentRun({ runId, task, expectsCompletionMessage: true });

    const lifecycleHandler = getLifecycleHandler();
    if (verifiesAnnouncement) {
      lifecycleHandler?.({
        runId,
        stream: "lifecycle",
        data: { phase: "start", startedAt: 10 },
      });
    }
    lifecycleHandler?.({
      runId,
      stream: "lifecycle",
      data: { phase, startedAt: 10, endedAt: 20, ...event },
    });

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
      const announceParams = expectRecordFields(
        getMockCallArg(mocks.runSubagentAnnounceFlow, 0, 0, "aborted announce"),
        { childRunId: runId },
        "aborted announce params",
      );
      expectRecordFields(
        announceParams.outcome,
        {
          status: "error",
          error: "subagent run terminated",
          startedAt: 10,
          endedAt: 20,
          elapsedMs: 10,
        },
        "aborted announce outcome",
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

  it("finishes canonical killed cleanup when its best-effort hook fails", async () => {
    mockPendingAgentWait();
    mocks.getGlobalHookRunner.mockReturnValue({
      hasHooks: (hookName: string) => hookName === "subagent_ended",
      runSubagentEnded: vi.fn().mockRejectedValueOnce(new Error("ended hook unavailable")),
    } as never);

    await mod.registerSubagentRun({
      runId: "run-killed-recovery",
      task: "killed recovery test",
      expectsCompletionMessage: false,
    });

    const lifecycleHandler = getLifecycleHandler();

    lifecycleHandler?.({
      runId: "run-killed-recovery",
      stream: "lifecycle",
      data: { phase: "start", startedAt: 100 },
    });

    lifecycleHandler?.({
      runId: "run-killed-recovery",
      stream: "lifecycle",
      data: {
        phase: "end",
        startedAt: 100,
        endedAt: 200,
        stopReason: "aborted",
      },
    });

    await waitForFast(() => {
      const run = findRequesterRun("run-killed-recovery");
      expect(run?.execution.outcome?.status).toBe("error");
      expect(run?.endedReason).toBe("subagent-killed");
      expect(run?.suppressAnnounceReason).toBe("killed");
    });
    await mod.testing.sweepOnceForTests();
    await waitForFast(() => {
      expect(
        mod
          .listSubagentRunsForRequester("agent:main:main")
          .some((entry) => entry.runId === "run-killed-recovery"),
      ).toBe(false);
    });
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
  });

  it("retries completion hooks before resuming ended cleanup", async () => {
    const runSubagentEnded = vi
      .fn()
      .mockRejectedValueOnce(new Error("ended hook unavailable"))
      .mockResolvedValue(undefined);
    mocks.getGlobalHookRunner.mockReturnValue({
      hasHooks: (hookName: string) => hookName === "subagent_ended",
      runSubagentEnded,
    } as never);

    await mod.registerSubagentRun({
      runId: "run-hook-retry",
      task: "finish after hook retry",
      expectsCompletionMessage: false,
    });

    await waitForFast(() => {
      expect(runSubagentEnded.mock.calls.length).toBeGreaterThanOrEqual(2);
      const run = findRequesterRun("run-hook-retry");
      expect(run?.cleanupCompletedAt).toBeTypeOf("number");
    });
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
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
    const timeoutAnnounce = expectRecordFields(
      getMockCallArg(mocks.runSubagentAnnounceFlow, 0, 0, "timeout retry announce"),
      { childRunId: "run-timeout-then-ok" },
      "timeout retry announce params",
    );
    expectRecordFields(
      timeoutAnnounce.outcome,
      {
        status: "ok",
        endedAt: 1_250,
      },
      "timeout retry announce outcome",
    );

    await vi.advanceTimersByTimeAsync(20_000);
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
  });

  it("retains delete-mode successful completions through the delivery deadline", async () => {
    const persist = (runs: Map<string, SubagentRunRecord>, runIds?: readonly string[]) =>
      saveSubagentRegistryChangesToSqlite(runs, runIds ?? [...runs.keys()]);
    mocks.persistSubagentRunsToDisk.mockImplementation(persist);
    mocks.persistSubagentRunsToDiskOrThrow.mockImplementation(persist);
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
    expectRecordFields(
      mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-delete-give-up"),
      { runId: "run-delete-give-up", cleanup: "delete" },
      "delete give-up run",
    );

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
      if (cleanup === "delete") {
        mocks.getGlobalHookRunner.mockReturnValue({
          hasHooks: (hookName: string) => hookName === "subagent_ended",
          runSubagentEnded: mocks.runSubagentEnded,
        } as never);
      }
      const runId = `run-resume-${cleanup}`;
      const task = `resume ${cleanup} retry budget`;
      const endedAt = Date.parse("2026-03-24T11:59:30Z");
      const restored = createSubagentRunRecord({
        runId,
        task,
        ...(cleanup === "delete" ? { cleanup } : {}),
        createdAt: Date.parse("2026-03-24T11:58:00Z"),
        startedAt: Date.parse("2026-03-24T11:59:00Z"),
        endedAt,
        expectsCompletionMessage: true,
        ...(cleanup === "keep"
          ? {
              endedReason: "subagent-complete",
              outcome: { status: "ok" as const },
              completion: { required: true, resultText: "child completed successfully" },
            }
          : {}),
        delivery: {
          status: "pending",
          attemptCount: 3,
          lastAttemptAt: Date.parse("2026-03-24T11:59:40Z"),
          ...(cleanup === "keep"
            ? {
                lastError: "gateway request timeout for agent",
                payload: {
                  childRunId: runId,
                  task,
                  endedAt,
                  outcome: { status: "ok" as const },
                  expectsCompletionMessage: true,
                },
              }
            : {}),
        },
      });
      mocks.restoreSubagentRunsFromDisk.mockImplementation(({ runs }) => {
        runs.set(runId, restored);
        return 1;
      });

      const settleRootWork = observeRootWork();
      try {
        hydrateAndActivateRegistry();
      } finally {
        await settleRootWork();
      }

      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledWith(
        expect.objectContaining({ childRunId: runId }),
      );
      const run = findRequesterRun(runId);
      if (cleanup === "delete") {
        expect(run).toBeUndefined();
      } else {
        expect(run?.delivery?.status).toBe("delivered");
        expect(run?.cleanupCompletedAt).toBeTypeOf("number");
        expect(run?.completion?.resultText).toBe("child completed successfully");
      }
    },
  );

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

    mod.addSubagentRunForTests({
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
    expectRecordFields(
      getMockCallArg(mocks.runSubagentAnnounceFlow, 0, 0, "child finished announce"),
      { childRunId: "run-child-finished" },
      "child finished announce params",
    );
    await waitForFast(() => {
      expect(mocks.onSubagentEnded).toHaveBeenCalledWith({
        childSessionKey: "agent:main:subagent:parent",
        reason: "deleted",
        workspaceDir: undefined,
      });
    });
  });

  it("wakes a sessions_yield-paused parent when pending descendants settle", async () => {
    mocks.entries = {
      "agent:main:subagent:parent": {
        sessionId: "sess-parent",
        updatedAt: 1,
      },
      "agent:main:subagent:child": {
        sessionId: "sess-child",
        updatedAt: 1,
      },
    };

    mod.addSubagentRunForTests({
      runId: "run-yielded-parent",
      childSessionKey: "agent:main:subagent:parent",
      task: "yielded parent waiting on descendants",
      createdAt: Date.parse("2026-06-26T02:17:00Z"),
      startedAt: Date.parse("2026-06-26T02:18:00Z"),
      endedAt: Date.parse("2026-06-26T02:19:00Z"),
      pauseReason: "sessions_yield",
      wakeOnDescendantSettle: true,
      cleanupHandled: false,
      cleanupCompletedAt: undefined,
    });

    await mod.registerSubagentRun({
      runId: "run-yielded-child-finished",
      requesterSessionKey: "agent:main:subagent:parent",
      requesterDisplayKey: "parent",
      task: "descendant settles after yield",
    });

    await waitForFast(() => {
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(2);
    });
    expectRecordFields(
      getMockCallArg(mocks.runSubagentAnnounceFlow, 0, 0, "child finished announce"),
      { childRunId: "run-yielded-child-finished" },
      "child finished announce params",
    );
    expectRecordFields(
      getMockCallArg(mocks.runSubagentAnnounceFlow, 1, 0, "yielded parent wake announce"),
      {
        childRunId: "run-yielded-parent",
        wakeOnDescendantSettle: true,
      },
      "yielded parent wake announce params",
    );
  });

  it("defers the killed hook until the provisional result reconciles", async () => {
    mockPendingAgentWait();
    const endedHookRunner = {
      hasHooks: (hookName: string) => hookName === "subagent_ended",
      runSubagentEnded: mocks.runSubagentEnded,
    };
    mocks.getGlobalHookRunner.mockReturnValue(endedHookRunner as never);

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
    expectRecordFields(
      getMockCallArg(mocks.runSubagentEnded, 0, 0, "subagent ended hook"),
      {
        targetSessionKey: "agent:main:subagent:killed",
        reason: "subagent-killed",
        accountId: "acct-1",
        runId: "run-killed-init",
        outcome: "killed",
        error: "manual kill",
      },
      "subagent ended hook params",
    );
    expectRecordFields(
      getMockCallArg(mocks.runSubagentEnded, 0, 1, "subagent ended hook context"),
      {
        runId: "run-killed-init",
        childSessionKey: "agent:main:subagent:killed",
        requesterSessionKey: "agent:main:main",
      },
      "subagent ended hook context",
    );
  });

  it("announces readable failure when an interrupted run is finalized", async () => {
    mod.addSubagentRunForTests({
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

    const updated = await mod.finalizeInterruptedSubagentRun({
      runId: "run-interrupted",
      error:
        "Subagent run was interrupted by a gateway restart or connection loss. Automatic recovery failed after 2 attempts. Please retry.",
      endedAt: 2,
    });

    expect(updated).toBe(1);
    await waitForFast(() => {
      const announceParams = findRecordCallArg(
        mocks.runSubagentAnnounceFlow,
        0,
        "interrupted announce",
        (record) => record.childRunId === "run-interrupted",
      );
      expectRecordFields(
        announceParams,
        {
          childRunId: "run-interrupted",
          requesterSessionKey: "agent:main:main",
          requesterOrigin: { channel: "quietchat", accountId: "acct-interrupted" },
        },
        "interrupted announce params",
      );
      const outcome = expectRecordFields(
        announceParams.outcome,
        { status: "error" },
        "interrupted announce outcome",
      );
      expect(String(outcome.error)).toContain("Automatic recovery failed after 2 attempts");
    });
    const run = findRequesterRun("run-interrupted");
    expect(run?.execution.outcome).toEqual({
      status: "error",
      error:
        "Subagent run was interrupted by a gateway restart or connection loss. Automatic recovery failed after 2 attempts. Please retry.",
      startedAt: 1,
      endedAt: 2,
      elapsedMs: 1,
    });
    expect(run?.terminalOwner).toBe("interrupted-recovery");
    expect(run?.cleanupCompletedAt).toBeTypeOf("number");

    const announceCalls = mocks.runSubagentAnnounceFlow.mock.calls.length;
    await expect(
      mod.finalizeInterruptedSubagentRun({
        runId: "run-interrupted",
        error:
          "Subagent run was interrupted by a gateway restart or connection loss. Automatic recovery failed after 2 attempts. Please retry.",
        endedAt: 2,
      }),
    ).resolves.toBe(1);
    expect(run?.terminalOwner).toBe("interrupted-recovery");
    expect(run?.execution.outcome?.error).toContain("Automatic recovery failed after 2 attempts");
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(announceCalls);
  });

  it("returns zero without mutating the run or task when recovery persistence fails", async () => {
    {
      const runId = "run-interrupted-persist-failure";
      const childSessionKey = "agent:main:subagent:interrupted-persist-failure";
      const entry = createSubagentRunRecord({
        runId,
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "preserve interrupted task",
        cleanup: "keep" as const,
        createdAt: 1,
        execution: { status: "running", startedAt: 1 },
      });
      mod.addSubagentRunForTests(entry);
      const original = structuredClone(entry);
      mocks.persistSubagentRunsToDiskOrThrow.mockImplementationOnce(() => {
        throw new Error("registry store boom");
      });

      await expect(
        mod.finalizeInterruptedSubagentRun({
          runId,
          error: "restart interrupted run",
          endedAt: 2,
        }),
      ).resolves.toBe(0);

      expect(mocks.persistSubagentRunsToDiskOrThrow).toHaveBeenCalledOnce();
      expect(
        mod.listSubagentRunsForRequester("agent:main:main").find((run) => run.runId === runId),
      ).toEqual(original);
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
      mod.addSubagentRunForTests(entry);
      const original = structuredClone(entry);

      await expect(
        mod.finalizeInterruptedSubagentRun({
          runId,
          error: "restart interrupted run",
          endedAt: 3,
        }),
      ).resolves.toBe(expected);

      expect(
        mod.listSubagentRunsForRequester("agent:main:main").find((run) => run.runId === runId),
      ).toEqual(original);
    },
  );

  it("passes stored agentDir through swept context-engine cleanup paths", async () => {
    const now = Date.parse("2026-03-24T12:00:00Z");
    mocks.entries = {
      "agent:alt:session:child-archive": {
        lifecycleRevision: "revision-child-archive",
        sessionId: "session-child-archive",
        updatedAt: now,
      },
    };
    mod.addSubagentRunForTests({
      runId: "run-session-swept-context-engine",
      childSessionKey: "agent:alt:session:child-session",
      controllerSessionKey: "agent:main:session:parent",
      requesterSessionKey: "agent:main:session:parent",
      requesterOrigin: undefined,
      requesterDisplayKey: "parent",
      task: "session cleanup",
      expectsCompletionMessage: undefined,
      spawnMode: "session",
      agentDir: "/tmp/agent-session",
      workspaceDir: "/tmp/workspace-session",
      createdAt: now - 20_000,
      startedAt: now - 10_000,
      sessionStartedAt: now - 10_000,
      accumulatedRuntimeMs: 0,
      endedAt: now - 8_000,
      outcome: { status: "ok", startedAt: now - 10_000, endedAt: now - 8_000, elapsedMs: 2_000 },
      cleanupHandled: true,
      cleanupCompletedAt: now - 6 * 60_000,
    });
    mod.addSubagentRunForTests({
      runId: "run-archive-swept-context-engine",
      childSessionKey: "agent:alt:session:child-archive",
      controllerSessionKey: "agent:main:session:parent",
      requesterSessionKey: "agent:main:session:parent",
      requesterOrigin: undefined,
      requesterDisplayKey: "parent",
      task: "archive cleanup",
      cleanup: "delete",
      expectsCompletionMessage: undefined,
      spawnMode: "run",
      agentDir: "/tmp/agent-archive",
      workspaceDir: "/tmp/workspace-archive",
      createdAt: now - 20_000,
      startedAt: now - 10_000,
      sessionStartedAt: now - 10_000,
      accumulatedRuntimeMs: 0,
      endedAt: now - 8_000,
      outcome: { status: "ok", startedAt: now - 10_000, endedAt: now - 8_000, elapsedMs: 2_000 },
      archiveAtMs: now - 1,
      cleanupHandled: true,
    });

    await mod.testing.sweepOnceForTests();

    await waitForFast(() => {
      findRecordCallArg(
        mocks.resolveContextEngine,
        1,
        "session context engine cleanup",
        (record) =>
          record.agentDir === "/tmp/agent-session" &&
          record.workspaceDir === "/tmp/workspace-session",
      );
      findRecordCallArg(
        mocks.resolveContextEngine,
        1,
        "archive context engine cleanup",
        (record) =>
          record.agentDir === "/tmp/agent-archive" &&
          record.workspaceDir === "/tmp/workspace-archive",
      );
      expect(mocks.resolveContextEngine).toHaveBeenCalledWith(
        {
          agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
          session: { mainKey: "main", scope: "per-sender" },
        },
        {
          agentDir: "/tmp/agent-session",
          workspaceDir: "/tmp/workspace-session",
        },
      );
      expect(mocks.resolveContextEngine).toHaveBeenCalledWith(
        {
          agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
          session: { mainKey: "main", scope: "per-sender" },
        },
        {
          agentDir: "/tmp/agent-archive",
          workspaceDir: "/tmp/workspace-archive",
        },
      );
    });
  });

  it("expires suspended cron final deliveries after seven days", async () => {
    const now = Date.parse("2026-03-24T12:00:00Z");
    const runId = "run-suspended-cron-expired";
    mod.addSubagentRunForTests(
      makeSuspendedDeliveryRun({
        runId,
        childSessionKey: "agent:main:subagent:suspended-cron",
        controllerSessionKey: "agent:main:cron:cron-1:run:parent",
        requesterSessionKey: "agent:main:cron:cron-1:run:parent",
        requesterDisplayKey: "cron",
        task: "cron suspended delivery",
        spawnMode: "session",
        createdAt: now - 8 * 24 * 60 * 60_000,
        endedAt: now - 8 * 24 * 60 * 60_000,
        completion: { required: true, resultText: "large final payload" },
        delivery: {
          lastAttemptAt: now - 7 * 24 * 60 * 60_000 - 1,
          suspendedAt: now - 7 * 24 * 60 * 60_000 - 1,
        },
      }),
    );

    await mod.testing.sweepOnceForTests();

    const run = mod.getSubagentRunByChildSessionKey("agent:main:subagent:suspended-cron");
    expect(run).toMatchObject({
      runId,
      delivery: {
        status: "discarded",
        payload: undefined,
        suspendedAt: undefined,
        suspendedReason: undefined,
        discardedAt: now,
        discardReason: "expired",
      },
      cleanupHandled: true,
      cleanupCompletedAt: now,
    });
    expect(run?.delivery?.discardedPayloadSummary).toEqual({
      requesterSessionKey: "agent:main:cron:cron-1:run:parent",
      childSessionKey: "agent:main:subagent:suspended-cron",
      childRunId: runId,
      endedAt: now - 8 * 24 * 60 * 60_000,
      status: "ok",
      lastError: "gateway request timeout for agent",
    });
    await waitForFast(() => {
      expect(mocks.onSubagentEnded).toHaveBeenCalledWith({
        childSessionKey: "agent:main:subagent:suspended-cron",
        reason: "completed",
        workspaceDir: undefined,
      });
    });
    expect(mocks.persistSubagentRunsToDisk).toHaveBeenCalled();
  });

  it("does not emit ended hooks before suspended delete retirement is durable", async () => {
    const now = Date.parse("2026-03-24T12:00:00Z");
    const runId = "run-suspended-delete-persist-failure";
    const childSessionKey = "agent:main:subagent:suspended-delete-persist-failure";
    mocks.getGlobalHookRunner.mockReturnValue({
      hasHooks: (hookName: string) => hookName === "subagent_ended",
      runSubagentEnded: mocks.runSubagentEnded,
    } as never);
    mocks.persistSubagentRunsToDiskOrThrow.mockImplementationOnce(() => {
      throw new Error("registry deletion failed");
    });
    mod.addSubagentRunForTests(
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
    const original = structuredClone(mod.getSubagentRunByChildSessionKey(childSessionKey));

    await expect(mod.testing.sweepOnceForTests()).rejects.toThrow("registry deletion failed");

    expect(mod.getSubagentRunByChildSessionKey(childSessionKey)).toEqual(original);
    expect(mocks.runSubagentEnded).not.toHaveBeenCalled();
    expect(mocks.onSubagentEnded).not.toHaveBeenCalled();
    expect(mocks.removeInternalSessionEffectsSession).not.toHaveBeenCalled();

    await mod.testing.sweepOnceForTests();

    expect(mod.getSubagentRunByChildSessionKey(childSessionKey)).toBeNull();
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
      mod.getSubagentRunByChildSessionKey(childSessionKey),
      "registered run",
    );
    run.execution.startedAt = startedAt;
    const execution = structuredClone(run.execution);
    mocks.loadSessionEntry.mockClear().mockImplementation(() => {
      throw new Error("simulated sweep failure");
    });

    await mod.testing.sweepOnceForTests();
    await mod.testing.runSweeperTickForTests();

    expect(mocks.loadSessionEntry).toHaveBeenCalled();
    expect(mod.getSubagentRunByChildSessionKey(childSessionKey)?.execution).toEqual(execution);
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
