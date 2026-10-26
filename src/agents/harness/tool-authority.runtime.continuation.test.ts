import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { createQueueTestRun } from "../../auto-reply/reply/queue.test-helpers.js";
import { prepareReplyToolAuthority } from "../../auto-reply/reply/reply-tool-authority.js";
import { prepareSteeringDelivery } from "../../auto-reply/reply/steering-delivery-preparation.js";
import { clearRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
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

const caller = {
  senderIsOwner: true,
  disableTools: false,
  messageProvider: "webchat",
  senderId: "authority-requester",
};
afterEach(() => {
  testing.resetActiveEmbeddedRuns();
  replyTesting.resetSessionControllerForTest();
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
});

it("binds continuation preparation and dispatch to the live maintenance authority", () =>
  admitted(async ({ admittedRunContext, close }) => {
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
          const target = expectDefined(
            captureCurrentReplyMessageInjectionTarget(sessionKey),
            "maintenance target",
          );
          const prepare = (toolsAllow: string[] | undefined, model = attempt.modelId) =>
            prepareReplyMessageContinuation({
              target,
              delivery,
              assertCurrent() {},
              input: {
                kind: "continuation",
                caller: { ...caller, toolsAllow },
                config: attempt.config,
                executionSelection: joinObservation.executionSelection,
                selectedRoute: {
                  provider: attempt.provider,
                  model,
                },
                fallbackAvailability: { kind: "none_configured", source: "inherited" },
              },
            });
          expect(await prepare(undefined)).toMatchObject({
            kind: "deferred",
            reason: "tool_authority_mismatch",
          });
          expect(await prepare([], "other-model")).toMatchObject({
            kind: "deferred",
            reason: "model-fallback-changed",
          });
          expect(queue).not.toHaveBeenCalled();
          const join = await prepare([]);
          expect(join.kind).toBe("prepared");
          if (join.kind !== "prepared") {
            throw new Error("Expected the live attempt owner");
          }
          try {
            const assertCurrent = () => {
              join.read();
            };
            const injection = await beginReplyMessageInjectionTarget(
              target,
              "Correct maintenance",
              {
                isInboundUserMessage: true,
                toolAuthorityFingerprint: join.fingerprint,
                toolAuthorityPreparation: bindPreparedToolAuthority(
                  bindWorkerToolPreparation({
                    authorityKind: "source-bound" as const,
                    assertCurrent,
                    compatAssertCurrent: assertCurrent,
                    prepareCurrent: join.prepareCurrent,
                  }),
                ),
              },
            );
            await expect(injection.outcome).resolves.toMatchObject({ status: "accepted" });
            expect(queue).toHaveBeenCalledOnce();
            close();
            await expect(join.prepareCurrent()).rejects.toThrow(
              "admitted run authority is no longer active",
            );
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
  }));
