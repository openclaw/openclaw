import { afterEach, expect, it } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { MessageInjectionAcceptedUnconfirmedError } from "../../auto-reply/reply/message-injection-authority.js";
import type { ReplyBackendMessageInjectionV2 } from "../../auto-reply/reply/reply-run-registry.contracts.js";
import {
  beginReplyMessageInjectionTarget,
  finalizeReplyMessageInjectionAttempt,
  replyRunRegistry,
} from "../../auto-reply/reply/reply-run-registry.js";
import { createTestReplyOperation } from "../../auto-reply/reply/reply-run-registry.test-helpers.js";
import { testing } from "../../auto-reply/reply/reply-run-registry.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { steerActiveSessionWithOptionalDeliveryWait } from "../embedded-agent-runner/run/attempt-queue-message.js";
import {
  queueEmbeddedAgentMessageWithOutcomeAsync,
  setActiveEmbeddedRun,
} from "../embedded-agent-runner/runs.js";
import {
  createEmbeddedRunHandle,
  testing as embeddedTesting,
} from "../embedded-agent-runner/runs.test-support.js";
import { QuestionAnswerUnconfirmedError } from "../harness/gateway-question-dispatch.js";
import {
  createAssistant,
  createTestSession,
  holdAssistantResponse,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";

registerAgentSessionLoopTestLifecycle();
afterEach(() => {
  embeddedTesting.resetActiveEmbeddedRuns();
  testing.resetReplyRunRegistry();
});

it.each(
  (["registry", "embedded"] as const).flatMap((surface) =>
    (["none", "error", "unconfirmed", "question-unconfirmed"] as const).map((observer) => ({
      surface,
      observer,
    })),
  ),
)(
  "classifies withdrawn $surface steering after $observer settlement",
  async ({ surface, observer }) => {
    const { session } = await createTestSession();
    const streaming = createDeferredCore();
    const accepted = createDeferredCore();
    const held = holdAssistantResponse("active response");
    streamMocks.streamSimple.mockImplementationOnce(() => {
      streaming.resolve();
      return held.response;
    });
    const sessionId = `withdrawal-${surface}-${observer}`;
    const sessionKey = `agent:main:${sessionId}`;
    const operation = createTestReplyOperation({ sessionId, sessionKey });
    const injection: ReplyBackendMessageInjectionV2 = {
      version: 2,
      isAvailable: () => true,
      queueMessage: (text, options, assertCurrent) =>
        steerActiveSessionWithOptionalDeliveryWait(session, text, options, undefined, () => {
          assertCurrent();
          return true;
        }),
    };
    const handle = {
      ...createEmbeddedRunHandle({ runId: sessionId, supportsTranscriptCommitWait: true }),
      kind: "embedded" as const,
      cancel() {},
      messageInjectionV2: injection,
    };
    operation.attachBackend(handle);
    operation.setPhase("running");
    setActiveEmbeddedRun(sessionId, handle, sessionKey);
    const active = session.prompt("active prompt");
    let terminated = false;
    let outcome: Promise<unknown> | undefined;
    try {
      await awaitGateBeforeSettlement(streaming.promise, active, "Active prompt never streamed");
      const options = {
        waitForTranscriptCommit: true,
        onQueueAccepted: (value: boolean) => {
          if (value) {
            accepted.resolve();
          }
        },
        onQueueSettled: () => {
          if (observer === "unconfirmed") {
            throw new MessageInjectionAcceptedUnconfirmedError();
          }
          if (observer === "question-unconfirmed") {
            throw new QuestionAnswerUnconfirmedError(new Error("question receipt unavailable"));
          }
          if (observer === "error") {
            throw new Error("settlement observer failed");
          }
        },
      };
      if (surface === "registry") {
        const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(sessionKey)!;
        outcome = beginReplyMessageInjectionTarget(target, "withdraw this input", options).then(
          (attempt) => finalizeReplyMessageInjectionAttempt({ target, attempt }),
        );
      } else {
        outcome = queueEmbeddedAgentMessageWithOutcomeAsync(
          sessionId,
          "withdraw this input",
          options,
        );
      }
      await awaitGateBeforeSettlement(accepted.promise, outcome, "Steering was not accepted");
      expect(session.getSteeringMessages()).toEqual(["withdraw this input"]);
      expect(session.agent.hasQueuedMessages()).toBe(true);
      const failure = createAssistant(testModel, [], "error");
      held.response.push({ type: "error", reason: "error", error: failure });
      held.response.end();
      terminated = true;
      await active;
      const result = await outcome;
      expect(session.getSteeringMessages()).toEqual([]);
      expect(session.agent.hasQueuedMessages()).toBe(false);
      expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
      const unconfirmed = observer === "unconfirmed" || observer === "question-unconfirmed";
      expect(result).toMatchObject(
        surface === "registry"
          ? { status: unconfirmed ? "indeterminate" : "rejected" }
          : { queued: unconfirmed },
      );
    } finally {
      if (!terminated) {
        held.release();
      }
      await Promise.allSettled([active, ...(outcome ? [outcome] : [])]);
      operation.complete();
    }
  },
);
