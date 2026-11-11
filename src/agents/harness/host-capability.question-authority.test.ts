import { AsyncResource } from "node:async_hooks";
import { expect, it, onTestFinished } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  claimPendingAgentQuestionAnswerFromCaller,
  runAgentHarnessGatewayQuestion,
} from "./gateway-question.js";
import { withQuestionGateway } from "./gateway-question.test-support.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";
import { createBaseAttemptParams } from "./lifecycle.test-support.js";
import { withPreparedEmbeddedRunToolAuthority } from "./tool-authority.runtime.js";

const caller = {
  senderId: "question-owner",
  senderIsOwner: true,
  disableTools: false,
  traceAuthorized: false,
  messageProvider: "telegram",
};
const attempt = {
  ...createBaseAttemptParams(),
  ...caller,
  sessionKey: "agent:main:native-question",
  agentId: "main",
  config: {},
};

it.each(["live", "copied", "closed"] as const)(
  "retains only the actual %s host across a detached callback before handle publication",
  async (mode) => {
    const nativeCallback = new AsyncResource("native-question-callback");
    const host = await createAdmittedHostCapabilityTestFixture(attempt);
    onTestFinished(() => {
      nativeCallback.emitDestroy();
      host.closeHost();
      host.closeAdmission();
    });
    const params = { ...attempt, hostCapabilities: host.hostCapabilities };
    await withQuestionGateway((gateway) =>
      withPreparedEmbeddedRunToolAuthority(host, params, undefined, async () => {
        const controller = new AbortController();
        const delivered = createDeferredCore();
        const hostCapabilities =
          mode === "copied" ? { ...host.hostCapabilities } : host.hostCapabilities;
        const pending = nativeCallback.runInAsyncScope(() =>
          runAgentHarnessGatewayQuestion({
            sessionKey: attempt.sessionKey,
            agentId: attempt.agentId,
            runId: attempt.runId,
            timeoutMs: 10_000,
            signal: controller.signal,
            questions: [{ id: "choice", header: "Choice", question: "Continue?" }],
            delivery: { hostCapabilities, onPartialReply: async () => delivered.resolve() },
          }),
        );
        void pending.catch(() => undefined);
        try {
          await delivered.promise;
          if (mode === "closed") {
            host.closeHost();
          }
          const answer = claimPendingAgentQuestionAnswerFromCaller({
            sessionKey: attempt.sessionKey,
            text: "Continue",
            caller,
            assertSourceCurrent: () => {},
          });
          if (mode === "live") {
            await expect(answer).resolves.toBe(true);
            await expect(pending).resolves.toMatchObject({
              status: "answered",
              answers: { answers: { choice: ["Continue"] } },
            });
          } else {
            await expect(answer).rejects.toThrow(
              mode === "copied" ? "no prepared creator authority" : "no longer active",
            );
            expect(gateway.requests.map(({ method }) => method)).not.toContain("question.resolve");
          }
        } finally {
          controller.abort();
          await pending;
        }
      }),
    );
  },
);
