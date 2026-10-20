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
import { createSessionMaintenanceFollowup, scheduleSessionMaintenance } from "./run.js";

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
          vi.setSystemTime(Date.now() + 40_000);
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
  "window-elapsed-during-flush",
  "expired-before-admission",
  "self-request",
  "foreground",
  "model-change",
  "account-change",
  "config-change",
  "compacted",
  "failed-delivery",
  "disabled",
] as const)("serves optional compaction safely for %s", async (mode) => {
  vi.useFakeTimers();
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
      defaults: { compaction: { enabled: mode !== "disabled", cacheExpiry: { enabled: true } } },
    },
  };
  const followupRun = createTestFollowupRun({
    sessionKey,
    sessionId: entry.sessionId,
    timeoutMs: 60_000,
    config: cfg,
  });
  setRuntimeConfigSnapshot(cfg);
  scheduleSessionMaintenance(
    {
      prepared: {
        cfg,
        sessionKey,
        storePath: "/synthetic/idle-compaction/sessions.json",
        timeoutMs: 60_000,
      },
      followupRun,
      sessionId: entry.sessionId,
      lifecycleRevision: entry.lifecycleRevision,
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      startedAt: Date.now(),
      expectedCompactionCount: 0,
      expectedSelection: { model: "fixture" },
      cacheExpiry: { observedAt: Date.now(), windowMs: 300_000, basis: "anthropic-ttl" },
      requestedCompaction: mode === "self-request" ? { focus: "Keep pending work" } : undefined,
    },
    Promise.resolve(mode !== "failed-delivery"),
  );
  await waitForSessionMaintenance(sessionKey);
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
    vi.setSystemTime(Date.now() + 300_000);
  }
  await vi.advanceTimersByTimeAsync(270_000);
  await waitForSessionMaintenance(sessionKey);
  expect(maintenanceRuntime.requestedCompactions).toEqual(
    mode === "expiry" || mode === "window-elapsed-during-flush"
      ? [{}]
      : mode === "self-request"
        ? [{ focus: "Keep pending work" }]
        : [],
  );
  expect(maintenanceRuntime.forcedFlushes).toBe(
    mode === "expiry" || mode === "self-request" || mode === "window-elapsed-during-flush" ? 1 : 0,
  );
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
