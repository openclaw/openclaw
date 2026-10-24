import { afterEach, expect, it, vi } from "vitest";
import { createQueueTestRun } from "../../auto-reply/reply/queue.test-helpers.js";
import { prepareReplyToolAuthority } from "../../auto-reply/reply/reply-tool-authority.js";
import { prepareSteeringDelivery } from "../../auto-reply/reply/steering-delivery-preparation.js";
import { clearRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { ReplyToolAuthorityOverlay } from "../../sessions/session-controller.contracts.js";
import {
  beginReplyMessageInjectionTarget,
  createReplyOperation,
} from "../../sessions/session-controller.js";
import { captureCurrentReplyMessageInjectionTarget } from "../../sessions/session-controller.message-injection.js";
import { captureReplyMessageJoinObservation } from "../../sessions/session-controller.message-join-observation.js";
import { prepareReplyMessageContinuation } from "../../sessions/session-controller.message-join.js";
import { testing as replyTesting } from "../../sessions/session-controller.test-support.js";
import { testing } from "../embedded-agent-runner/runs.test-support.js";
import { bindWorkerToolPreparation } from "./host-private-capabilities.js";
import { bindPreparedToolAuthority } from "./tool-authority-preparation.js";
import { withPreparedEmbeddedRunToolAuthority } from "./tool-authority.runtime.js";
import {
  admitted,
  attempt,
  publishPreparedHandle,
  sessionId,
  sessionKey,
} from "./tool-authority.runtime.test-support.js";

const own: ReplyToolAuthorityOverlay = {
  senderIsOwner: true,
  disableTools: false,
  traceAuthorized: false,
  messageProvider: "webchat",
  senderId: "authority-requester",
};
function currentTarget() {
  const target = captureCurrentReplyMessageInjectionTarget(sessionKey);
  if (!target) {
    throw new Error("Expected the admitted maintenance owner to be injectable");
  }
  return target;
}
afterEach(() => {
  testing.resetActiveEmbeddedRuns();
  replyTesting.resetSessionControllerForTest();
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
});

it.each(["matching attempt", "different tools", "different model", "revoked source"] as const)(
  "prepares a continuation against the published maintenance authority: %s",
  async (change) => {
    await admitted(async ({ admittedRunContext, close }) => {
      const operation = createReplyOperation({ sessionId, sessionKey, resetTriggered: false });
      const parent = createQueueTestRun({ prompt: "lifecycle-only parent" });
      parent.run.traceAuthorized = true;
      await operation.bindToolAuthoritySnapshotAsync(prepareReplyToolAuthority(parent));
      const joinObservation = captureReplyMessageJoinObservation({
        run: attempt,
        sessionEntry: undefined,
      });
      const delivery = prepareSteeringDelivery({ agentId: "main", assertCurrent() {} });
      try {
        await withPreparedEmbeddedRunToolAuthority(
          { admittedRunContext, replyOperation: operation, joinObservation },
          { ...attempt, toolsAllow: [] },
          undefined,
          async (prepared) => {
            const queue = vi.fn(async () => {});
            expect(operation.toolAuthorityFingerprint).not.toBe(prepared.toolAuthorityFingerprint);
            publishPreparedHandle(prepared.toolAuthorityFingerprint, queue);
            const { traceAuthorized: _trace, ...caller } = own;
            const target = currentTarget();
            const join = await prepareReplyMessageContinuation({
              target,
              delivery,
              assertCurrent() {},
              input: {
                kind: "continuation",
                caller: { ...caller, toolsAllow: change === "different tools" ? undefined : [] },
                config: attempt.config,
                executionSelection: joinObservation.executionSelection,
                selectedRoute: {
                  provider: attempt.provider,
                  model: change === "different model" ? "other-model" : attempt.modelId,
                },
                fallbackAvailability: { kind: "none_configured", source: "inherited" },
              },
            });
            if (change === "different tools" || change === "different model") {
              expect(join).toMatchObject({
                kind: "deferred",
                reason:
                  change === "different model"
                    ? "model-fallback-changed"
                    : "tool_authority_mismatch",
              });
              expect(queue).not.toHaveBeenCalled();
              return;
            }
            expect(join.kind).toBe("prepared");
            if (join.kind !== "prepared") {
              throw new Error("Expected the live attempt owner");
            }
            try {
              if (change === "revoked source") {
                close();
                await expect(join.prepareCurrent()).rejects.toThrow(
                  "admitted run authority is no longer active",
                );
                expect(queue).not.toHaveBeenCalled();
                return;
              }
              const injection = await beginReplyMessageInjectionTarget(
                target,
                "Correct maintenance",
                {
                  isInboundUserMessage: true,
                  toolAuthorityFingerprint: join.fingerprint,
                  toolAuthorityPreparation: bindPreparedToolAuthority(
                    bindWorkerToolPreparation({
                      authorityKind: "source-bound" as const,
                      assertCurrent: () => {
                        join.read();
                      },
                      compatAssertCurrent: () => {
                        join.read();
                      },
                      prepareCurrent: join.prepareCurrent,
                    }),
                  ),
                },
              );
              await expect(injection.outcome).resolves.toMatchObject({ status: "accepted" });
              expect(queue).toHaveBeenCalledOnce();
            } finally {
              join.release();
            }
          },
        );
      } finally {
        delivery.release();
        operation.complete();
      }
    });
  },
);
