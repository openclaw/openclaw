import { expect, it, vi } from "vitest";
import { buildEmbeddedRunExecutionParams } from "../../auto-reply/reply/agent-runner-utils.js";
import { createTestFollowupRun } from "../../auto-reply/reply/agent-runner.test-fixtures.js";
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

it.each([false, true])(
  "reads before maintenance and drains cleanup (wait for owner: %s)",
  async (waitForOwner) => {
    await withOpenClawTestState({ label: "maintenance-queued-read" }, async ({ env }) => {
      const { scope, schedule } = await setup(env, "maintenance-queued-read");
      const events: string[] = [];
      let scheduler: ReplyOperation | undefined;
      const flush = blockFlush(() => events.push("flush"));
      memory.runSessionCompactionIfNeeded.mockImplementationOnce(async () => {
        events.push("compaction");
      });
      try {
        await withSessionTurn(scope, async (operation) => {
          scheduler = operation;
          expect(operation).toBeDefined();
          const ownerSettles = operation?.ownerSettlement.then(
            () => operation.result?.kind === "completed",
          );
          schedule(waitForOwner ? ownerSettles : undefined);
          const checkpoint = waitForSessionMaintenance(scope.sessionKey).then(() => {
            events.push("read");
          });
          // Both admission and the checkpoint have only no-I/O continuations before blocking.
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(events).toEqual(["read"]);
          await checkpoint;
        });
        expect(scheduler?.result?.kind).toBe("completed");
        const drained = waitForSessionMaintenance(scope.sessionKey).then(() =>
          events.push("drained"),
        );
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
    });
  },
);
