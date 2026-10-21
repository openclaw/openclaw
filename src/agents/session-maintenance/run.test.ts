import { afterEach, expect, it, vi } from "vitest";
import { buildEmbeddedRunExecutionParams } from "../../auto-reply/reply/agent-runner-utils.js";
import { createTestFollowupRun } from "../../auto-reply/reply/agent-runner.test-fixtures.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  requireActivePluginRegistry,
  resetPluginRuntimeStateForTest,
} from "../../plugins/runtime.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import type { ReplyOperation } from "../../sessions/session-controller.contracts.js";
import { isCurrentSessionControllerOperation } from "../../sessions/session-controller.identity.js";
import { sessionControllers } from "../../sessions/session-controller.state.js";
import { beginForegroundSessionMaintenance, waitForSessionMaintenance } from "./coordinator.js";
import {
  createSessionMaintenanceFollowup,
  scheduleSessionMaintenance,
  type SessionMaintenanceRequest,
} from "./run.js";

const maintenanceRuntime = vi.hoisted(() => ({
  entry: undefined as SessionEntry | undefined,
  flushOperations: [] as Array<{ operation: ReplyOperation | undefined; current: boolean }>,
  compactions: 0,
  forcedFlushes: 0,
  advanceClockDuringFlush: false,
  requestedCompactions: [] as Array<{ focus?: string }>,
}));

vi.mock("../../utils/provider-utils.js", () => ({
  isReasoningTagProvider: () => {
    throw new Error("Prepared runtime hints must not be rediscovered");
  },
}));

vi.mock("../command/runtime-loaders.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../command/runtime-loaders.js")>()),
  loadSessionStoreRuntime: async () => ({
    captureSessionEntryCurrentRead: () => ({
      kind: "incognito",
      assertSourceCurrent: () => {},
      readCurrent: () => maintenanceRuntime.entry,
    }),
    withSessionEntryReadOnlyInWorker: async <T>(
      _scope: unknown,
      assertCurrent: () => void,
      consume: (read: { ok: true; value: SessionEntry | undefined }) => Promise<T>,
    ) => {
      assertCurrent();
      return await consume({ ok: true, value: maintenanceRuntime.entry });
    },
  }),
  loadAgentRunnerMemoryRuntime: async () => ({
    runMemoryFlushIfNeeded: async (params: {
      replyOperation?: ReplyOperation;
      force?: boolean;
    }) => {
      if (params.force) {
        maintenanceRuntime.forcedFlushes += 1;
        if (maintenanceRuntime.advanceClockDuringFlush) {
          vi.setSystemTime(Date.now() + 310_000);
        }
      }
      maintenanceRuntime.flushOperations.push({
        operation: params.replyOperation,
        current: params.replyOperation
          ? isCurrentSessionControllerOperation(params.replyOperation)
          : false,
      });
      return {};
    },
    runSessionCompactionIfNeeded: async (params: { requestedCompaction?: { focus?: string } }) => {
      maintenanceRuntime.compactions += 1;
      if (params.requestedCompaction) {
        maintenanceRuntime.requestedCompactions.push(params.requestedCompaction);
      }
    },
  }),
}));

afterEach(() => {
  maintenanceRuntime.entry = undefined;
  maintenanceRuntime.flushOperations = [];
  maintenanceRuntime.compactions = 0;
  maintenanceRuntime.forcedFlushes = 0;
  maintenanceRuntime.advanceClockDuringFlush = false;
  maintenanceRuntime.requestedCompactions = [];
  sessionControllers.clear();
  resetPluginRuntimeStateForTest();
  clearRuntimeConfigSnapshot();
  vi.useRealTimers();
});

it.each([
  "expiry",
  "expiry-30m",
  "expiry-12h",
  "heuristic",
  "activity-reset",
  "window-elapsed-during-flush",
  "expired-before-admission",
  "self-request",
  "short-window",
  "shorter-window",
  "cache-disabled",
  "cache-default",
  "foreground",
  "model-change",
  "account-change",
  "config-change",
  "compacted",
  "failed-delivery",
  "disabled",
] as const)("serves optional compaction safely for %s", async (mode) => {
  vi.useFakeTimers();
  const halfHour = mode === "expiry-30m" || mode === "heuristic" || mode === "activity-reset";
  const expectExpiry =
    halfHour ||
    mode === "expiry-12h" ||
    mode === "expiry" ||
    mode === "window-elapsed-during-flush";
  requireActivePluginRegistry();
  const sessionKey = "agent:main:idle-compaction";
  const entry: SessionEntry = {
    sessionId: "idle-compaction",
    updatedAt: Date.now(),
    model: "fixture",
    compactionCount: 0,
  };
  maintenanceRuntime.entry = entry;
  const cfg = {
    agents: {
      defaults: {
        compaction: {
          enabled: mode !== "disabled",
          // This case crosses the five-minute cache lead, not its configured work deadline.
          timeoutSeconds: mode === "window-elapsed-during-flush" ? 360 : undefined,
          cacheExpiry: {
            enabled: mode === "cache-default" ? undefined : mode !== "cache-disabled",
          },
        },
      },
    },
  };
  const followupRun = createTestFollowupRun({
    sessionKey,
    sessionId: entry.sessionId,
    // Cross the five-minute lead while keeping the admitted checkpoint within its own budget.
    timeoutMs: 360_000,
    config: cfg,
  });
  setRuntimeConfigSnapshot(cfg);
  const request: SessionMaintenanceRequest = {
    prepared: {
      cfg,
      sessionKey,
      storePath: "/synthetic/idle-compaction/sessions.json",
      timeoutMs: 360_000,
    },
    followupRun,
    sessionId: entry.sessionId,
    lifecycleRevision: entry.lifecycleRevision,
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
    startedAt: Date.now(),
    expectedCompactionCount: 0,
    expectedSelection: { model: "fixture" },
    cacheExpiry: {
      observedAt: Date.now(),
      windowMs:
        mode === "shorter-window"
          ? 60_000
          : mode === "short-window" || mode === "self-request"
            ? 300_000
            : mode === "expiry-12h"
              ? 43_200_000
              : halfHour
                ? 1_800_000
                : 3_600_000,
      basis:
        mode === "heuristic" || mode === "activity-reset"
          ? "codex-idle-heuristic"
          : mode === "expiry-30m" || mode === "expiry-12h"
            ? "openai-minimum"
            : "anthropic-ttl",
    },
    requestedCompaction: mode === "self-request" ? { focus: "Keep pending work" } : undefined,
  };
  scheduleSessionMaintenance(request, Promise.resolve(mode !== "failed-delivery"));
  await waitForSessionMaintenance(sessionKey);
  expect(maintenanceRuntime.compactions).toBe(
    mode === "disabled" || mode === "failed-delivery" ? 0 : 1,
  );
  if (mode === "activity-reset") {
    const release = await beginForegroundSessionMaintenance(sessionKey);
    await vi.advanceTimersByTimeAsync(1_800_000);
    expect(maintenanceRuntime.forcedFlushes).toBe(0);
    release();
    scheduleSessionMaintenance(
      {
        ...request,
        startedAt: Date.now(),
        cacheExpiry: { observedAt: Date.now(), windowMs: 1_800_000, basis: "codex-idle-heuristic" },
      },
      Promise.resolve(true),
    );
    await waitForSessionMaintenance(sessionKey);
  }
  if (mode === "foreground") {
    (await beginForegroundSessionMaintenance(sessionKey))();
  }
  if (mode === "model-change") {
    entry.model = "different-model";
  }
  if (mode === "account-change") {
    entry.authProfileOverride = "different-account";
  }
  if (mode === "config-change") {
    setRuntimeConfigSnapshot({ agents: { defaults: { compaction: { enabled: false } } } });
  }
  if (mode === "compacted") {
    entry.compactionCount = 1;
  }
  maintenanceRuntime.advanceClockDuringFlush = mode === "window-elapsed-during-flush";
  if (mode === "expired-before-admission") {
    vi.setSystemTime(Date.now() + 3_600_000);
  }
  const delay = mode === "expiry-12h" ? 42_900_000 : halfHour ? 1_500_000 : 3_300_000;
  await vi.advanceTimersByTimeAsync(delay - 1);
  await waitForSessionMaintenance(sessionKey);
  expect(maintenanceRuntime.requestedCompactions).toEqual(
    mode === "self-request" ? [{ focus: "Keep pending work" }] : [],
  );
  expect(maintenanceRuntime.forcedFlushes).toBe(mode === "self-request" ? 1 : 0);
  await vi.advanceTimersByTimeAsync(1);
  await waitForSessionMaintenance(sessionKey);
  expect(maintenanceRuntime.requestedCompactions).toEqual(
    expectExpiry ? [{}] : mode === "self-request" ? [{ focus: "Keep pending work" }] : [],
  );
  expect(maintenanceRuntime.forcedFlushes).toBe(expectExpiry || mode === "self-request" ? 1 : 0);
  const count = maintenanceRuntime.compactions;
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(maintenanceRuntime.compactions).toBe(count);
});

it("preserves prepared model facts and restrictive policy without foreground authority", async () => {
  const foreground = createTestFollowupRun({
    provider: "test-provider",
    model: "test-model",
    thinkingCatalog: [{ provider: "test-provider", id: "test-model", input: ["text", "image"] }],
    senderIsOwner: true,
    conversationToolPolicy: { deny: ["read"] },
    toolOverrides: { webSearch: false },
  });
  const maintenance = createSessionMaintenanceFollowup({
    run: foreground.run,
    sessionEntry: { sessionId: "maintenance", updatedAt: 1 },
    sessionKey: "agent:main:maintenance",
    cfg: foreground.run.config,
    provider: "test-provider",
    model: "test-model",
    auth: {},
  });
  const embedded = await buildEmbeddedRunExecutionParams({
    run: maintenance.run,
    provider: "test-provider",
    model: "test-model",
    runId: "maintenance-run",
    sessionCtx: {},
    hasRepliedRef: undefined,
  });
  expect(embedded.modelHasVision).toBe(true);
  expect(embedded.conversationToolPolicy).toEqual({ deny: ["read"] });
  expect(embedded.senderIsOwner).toBe(false);
  expect(embedded.toolOverrides).toBeUndefined();
  expect(embedded.runtimePluginToolGrant).toBeUndefined();
  expect(maintenance.userTurnTranscriptRecorder).toBeUndefined();
});

it("admits maintenance scheduled inside a reply turn as its own turn after that turn settles", async () => {
  // Reply turns schedule maintenance from their own async context; the work runs only
  // after the scheduling turn settles, so it must not resume that retired owner.
  requireActivePluginRegistry();
  const sessionKey = "agent:main:deferred-maintenance";
  const sessionId = "deferred-maintenance-session";
  const storePath = "/synthetic/deferred-maintenance/sessions.json";
  const entry: SessionEntry = { sessionId, updatedAt: 1 };
  maintenanceRuntime.entry = entry;
  const foreground = createTestFollowupRun({ sessionKey, sessionId, timeoutMs: 60_000 });
  let scheduler: ReplyOperation | undefined;

  await withSessionTurn({ sessionKey, sessionId, storePath }, async (operation) => {
    scheduler = operation;
    if (!operation) {
      throw new Error("expected the reply turn to own controller admission");
    }
    scheduleSessionMaintenance(
      {
        prepared: { cfg: foreground.run.config, sessionKey, storePath, timeoutMs: 60_000 },
        followupRun: createSessionMaintenanceFollowup({
          run: foreground.run,
          sessionEntry: entry,
          cfg: foreground.run.config,
          sessionKey,
          provider: "test-provider",
          model: "test-model",
          auth: {},
        }),
        sessionId,
        lifecycleRevision: entry.lifecycleRevision,
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        startedAt: Date.now(),
      },
      operation.ownerSettlement.then(() => operation.result?.kind === "completed"),
    );
  });
  await waitForSessionMaintenance(sessionKey);

  expect(scheduler?.result?.kind).toBe("completed");
  expect(maintenanceRuntime.flushOperations).toHaveLength(1);
  const [flush] = maintenanceRuntime.flushOperations;
  expect(flush?.operation).toBeDefined();
  expect(flush?.operation).not.toBe(scheduler);
  expect(flush?.current).toBe(true);
  expect(maintenanceRuntime.compactions).toBe(1);
});
