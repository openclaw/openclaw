import { setImmediate as drainContinuations } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { buildEmbeddedRunExecutionParams } from "../../auto-reply/reply/agent-runner-utils.js";
import { createTestFollowupRun } from "../../auto-reply/reply/agent-runner.test-fixtures.js";
import { resolveVisibleActiveSessionRunState } from "../../gateway/server-methods/session-active-runs.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import type { ReplyOperation } from "../../sessions/session-controller.contracts.js";
import { isCurrentSessionControllerOperation } from "../../sessions/session-controller.identity.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { waitForSessionMaintenance } from "./coordinator.js";
import { createSessionMaintenanceFollowup } from "./run.js";
import { blockFlush, expectEffects, memory, setup } from "./run.test-support.js";

// mock-isolation: Real admission stores; only optional memory effects are inert.
vi.mock("../command/runtime-loaders.js", () => ({
  loadAgentRunnerMemoryRuntime: async () => (await import("./run.test-support.js")).memory,
  loadSessionStoreRuntime: () => import("../command/session-store.runtime.js"),
}));

vi.mock("../../utils/provider-utils.js", () => ({
  isReasoningTagProvider: () => {
    throw new Error("Prepared runtime hints must not be rediscovered");
  },
}));

it("preserves prepared model facts and restrictive policy without foreground authority", async () => {
  const model = { provider: "test-provider", model: "test-model" };
  const { run } = createTestFollowupRun({
    ...model,
    thinkingCatalog: [{ provider: model.provider, id: model.model, input: ["text", "image"] }],
    senderIsOwner: true,
    conversationToolPolicy: { deny: ["read"] },
    toolOverrides: { webSearch: false },
  });
  const maintenance = createSessionMaintenanceFollowup({
    run,
    ...model,
    sessionEntry: { sessionId: "maintenance", updatedAt: 1 },
    sessionKey: "agent:main:maintenance",
    cfg: run.config,
    auth: {},
  });
  const embedded = await buildEmbeddedRunExecutionParams({
    run: maintenance.run,
    ...model,
    runId: "maintenance-run",
    sessionCtx: {},
    hasRepliedRef: undefined,
  });
  expect(embedded).toMatchObject({ modelHasVision: true, senderIsOwner: false });
  expect(embedded.conversationToolPolicy).toEqual({ deny: ["read"] });
  expect(embedded.toolOverrides).toBeUndefined();
  expect(embedded.runtimePluginToolGrant).toBeUndefined();
  expect(maintenance.userTurnTranscriptRecorder).toBeUndefined();
});

it("keeps optional maintenance out of the finished session's active run state", () =>
  withOpenClawTestState({ label: "maintenance-hidden" }, async ({ env }) => {
    const { scope, schedule } = await setup(env, "maintenance-hidden");
    const flush = blockFlush();
    try {
      schedule();
      await flush.started;
      // Control UI shows a running turn and Stop for any active state on this session.
      expect(
        resolveVisibleActiveSessionRunState({
          requestedKey: scope.sessionKey,
          canonicalKey: scope.sessionKey,
          sessionId: scope.sessionId,
          agentId: scope.agentId,
          storePath: scope.storePath,
        }).active,
      ).toBe(false);
    } finally {
      flush.release();
      await waitForSessionMaintenance(scope.sessionKey);
    }
    expectEffects(1);
  }));

it.each([false, true])(
  "reads before maintenance and drains cleanup (wait for owner: %s)",
  (waitForOwner) =>
    withOpenClawTestState({ label: "maintenance-queued-read" }, async ({ env }) => {
      const { scope, schedule } = await setup(env, "maintenance-queued-read");
      const events: string[] = [];
      const record = (event: string) => events.push(event);
      let scheduler: ReplyOperation | undefined;
      const flush = blockFlush(() => record("flush"));
      memory.runSessionCompactionIfNeeded.mockImplementationOnce(
        async () => void record("compaction"),
      );
      try {
        await withSessionTurn(scope, async (operation) => {
          scheduler = operation;
          const ownerSettles = operation?.ownerSettlement.then(
            () => operation.result?.kind === "completed",
          );
          schedule(waitForOwner ? ownerSettles : undefined);
          const checkpoint = waitForSessionMaintenance(scope.sessionKey).then(() => record("read"));
          await drainContinuations(); // Drain no-I/O admission/checkpoint continuations.
          expect(events).toEqual(["read"]);
          await checkpoint;
        });
        expect(scheduler?.result?.kind).toBe("completed");
        const drained = waitForSessionMaintenance(scope.sessionKey).then(() => record("drained"));
        await flush.started;
        const operation = memory.runMemoryFlushIfNeeded.mock.calls[0]?.[0].replyOperation;
        expect(operation !== undefined && isCurrentSessionControllerOperation(operation)).toBe(
          true,
        );
        expect(operation).not.toBe(scheduler);
        expect(events).toEqual(["read", "flush"]);
        flush.release();
        await drained;
        expect(events).toEqual(["read", "flush", "compaction", "drained"]);
        expectEffects(1);
      } finally {
        flush.release();
        await waitForSessionMaintenance(scope.sessionKey);
      }
    }),
);
