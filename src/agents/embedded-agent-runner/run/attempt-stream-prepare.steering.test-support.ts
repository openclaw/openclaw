import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { nextEventLoopTurn } from "../../../../test/helpers/promise.js";
import type { Context } from "../../../llm/types.js";
import {
  claimSessionControllerTask,
  releaseSessionControllerClaim,
  reserveSessionControllerSource,
  retireSessionControllerInput,
} from "../../../sessions/session-controller.mailbox.js";
import { captureReplyMessageInjectionTarget } from "../../../sessions/session-controller.message-injection.js";
import { createReplyOperation } from "../../../sessions/session-controller.operation.js";
import { beginSessionControllerSteer } from "../../../sessions/session-controller.steer.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  streamMocks,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { prepareCatalogExecutor } from "./attempt-stream-prepare.test-support.js";

/** Uses the owning stream suite's registration and session lifecycle. */
export function registerPreparationSteeringTests() {
  it("steers at the next model boundary past a source committed to a separate turn", async () => {
    const sessionKey = "agent:main:queued-native-predecessor";
    const fingerprint = "synthetic-compatible-steering-tools";
    const operation = createReplyOperation({
      sessionKey,
      sessionId: "session-output-schema",
      resetTriggered: false,
    });
    operation.setPhase("running");
    const older = reserveSessionControllerSource(sessionKey, { policy: { mode: "followup" } });
    const correction = reserveSessionControllerSource(sessionKey, { policy: { mode: "steer" } });
    const requests: Context[] = [];
    const started = vi.fn();
    let task: ReturnType<typeof claimSessionControllerTask> | undefined;
    let admission: ReturnType<typeof beginSessionControllerSteer> | undefined;
    const { session } = await createTestSession({
      customTools: [
        {
          name: "work",
          label: "Work",
          description: "Complete one synthetic work batch",
          parameters: Type.Object({}),
          async execute() {
            task = claimSessionControllerTask(older, started);
            const target = captureReplyMessageInjectionTarget(operation);
            if (!target) {
              throw new Error("Missing real runtime target");
            }
            admission = beginSessionControllerSteer({
              input: correction,
              target,
              text: "Correct the ongoing work",
              options: {
                waitForTranscriptCommit: true,
                isInboundUserMessage: true,
                toolAuthorityFingerprint: fingerprint,
              },
            });
            // All ingress here is in-memory; let its current preparation microtasks drain.
            await nextEventLoopTurn();
            return { content: [{ type: "text" as const, text: "Batch complete" }], details: {} };
          },
        },
      ],
    });
    const prepared = prepareCatalogExecutor({
      activeSession: session,
      replyOperation: operation,
      sessionKey,
      attempt: { toolAuthorityFingerprint: fingerprint },
    });
    streamMocks.streamSimple.mockImplementation((model, context) => {
      requests.push(context);
      const first = requests.length === 1;
      return createAssistantResultStream(
        createAssistant(
          model,
          first ? [{ type: "toolCall", id: "work-1", name: "work", arguments: {} }] : "Done",
          first ? "toolUse" : "stop",
        ),
      );
    });
    try {
      await session.prompt("Continue working");
      expect(started).not.toHaveBeenCalled();
      expect(requests).toHaveLength(2);
      expect(requests[1]?.messages).toContainEqual(
        expect.objectContaining({
          role: "user",
          content: [{ type: "text", text: "Correct the ongoing work" }],
        }),
      );
      await expect((await admission)?.outcome).resolves.toMatchObject({ status: "accepted" });
    } finally {
      operation.complete();
      if (task) {
        const claim = await task;
        releaseSessionControllerClaim(claim);
        await claim.settlement.promise;
      }
      const attempt = await admission;
      await attempt?.outcome;
      retireSessionControllerInput(older);
      retireSessionControllerInput(correction);
      prepared.subscription.unsubscribe();
    }
  });

  it.each([true, false])(
    "withdraws preparation-time steering on closure (wait for commit: %s)",
    async (waitForTranscriptCommit) => {
      const { session } = await createTestSession();
      vi.useFakeTimers();
      const prepared = prepareCatalogExecutor({ activeSession: session });
      const abort = new AbortController();
      const accepted = createDeferredCore<boolean>();
      const settled = vi.fn();
      await session.steer("unrelated control");
      const receipt = prepared.queueHandle
        .queueMessage("queued during preparation", {
          waitForTranscriptCommit,
          abortSignal: abort.signal,
          onQueueAccepted: accepted.resolve,
          onQueueSettled: settled,
        })
        .then(
          () => ({ error: undefined }),
          (error: unknown) => ({ error }),
        );
      try {
        await expect(accepted.promise).resolves.toBe(true);
        expect(settled).not.toHaveBeenCalled();
        prepared.stopAcceptingSteerMessages();
        await vi.advanceTimersByTimeAsync(0);

        expect(settled).toHaveBeenCalledOnce();
        expect(session.getSteeringMessages()).toEqual(["unrelated control"]);
        expect(await receipt).toEqual({
          error: waitForTranscriptCommit
            ? expect.objectContaining({ name: "MessageInjectionWithdrawnError" })
            : undefined,
        });
        expect(prepared.queueHandle.isAborted?.()).toBe(false);
      } finally {
        abort.abort();
        await vi.advanceTimersByTimeAsync(0);
        await receipt;
        prepared.subscription.unsubscribe();
        vi.useRealTimers();
      }
    },
  );
}
