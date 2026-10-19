import { afterEach, expect, it, vi } from "vitest";
import { buildEmbeddedRunExecutionParams } from "../../auto-reply/reply/agent-runner-utils.js";
import { createTestFollowupRun } from "../../auto-reply/reply/agent-runner.test-fixtures.js";
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
import { waitForSessionMaintenance } from "./coordinator.js";
import { createSessionMaintenanceFollowup, scheduleSessionMaintenance } from "./run.js";

const maintenanceRuntime = vi.hoisted(() => ({
  entry: undefined as SessionEntry | undefined,
  flushOperations: [] as Array<{ operation: ReplyOperation | undefined; current: boolean }>,
  compactions: 0,
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
    runMemoryFlushIfNeeded: async (params: { replyOperation?: ReplyOperation }) => {
      maintenanceRuntime.flushOperations.push({
        operation: params.replyOperation,
        current: params.replyOperation
          ? isCurrentSessionControllerOperation(params.replyOperation)
          : false,
      });
      return {};
    },
    runSessionCompactionIfNeeded: async () => {
      maintenanceRuntime.compactions += 1;
    },
  }),
}));

afterEach(() => {
  maintenanceRuntime.entry = undefined;
  maintenanceRuntime.flushOperations = [];
  maintenanceRuntime.compactions = 0;
  sessionControllers.clear();
  resetPluginRuntimeStateForTest();
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
