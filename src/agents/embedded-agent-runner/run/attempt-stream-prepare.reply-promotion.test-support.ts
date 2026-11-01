import { expect, it, vi } from "vitest";
import {
  clearAgentRunContext,
  registerAgentRunContext,
} from "../../../infra/agent-run-registry.js";
import type { Context } from "../../../llm/types.js";
import {
  beginReplyMessageInjectionTarget,
  captureReplyMessageInjectionTarget,
  createReplyOperation,
} from "../../../sessions/session-controller.js";
import { captureSessionTarget } from "../../../sessions/session-controller.lifecycle.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  createAdmittedRunOperatorAuthority,
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../admitted-run-context.js";
import { registerPendingAgentQuestion } from "../../harness/gateway-question.js";
import { withPreparedEmbeddedRunToolAuthority } from "../../harness/tool-authority.runtime.js";
import { prepareOperatorModelPolicy } from "../../operator-model-policy.js";
import {
  resolveReplyCompletion,
  resolveReplyExpectation,
  shouldDeliverMissingReplyNotice,
} from "../../reply-completion.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  holdAssistantResponse,
  streamMocks,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { prepareCatalogExecutor } from "./attempt-stream-prepare.test-support.js";

type QuestionDispatcher = Extract<
  Parameters<typeof registerPendingAgentQuestion>[0]["gatewayCall"],
  { version: 2 }
>;

/** Uses the owning stream suite's real registration and session lifecycle. */
export function registerReplyPromotionTests() {
  it.each([
    ["required", "required", undefined],
    ["result-required", "result-required", undefined],
    ["collaborative-required", "required", undefined],
    ["collaborative-result-required", "result-required", undefined],
    ["hidden", "required", "input_visibility_mismatch"],
    ["closed", "required", "injection_unavailable"],
    ["wrong-authority", "required", "tool_authority_mismatch"],
  ] as const)(
    "adopts the human reply obligation only with real session acceptance: %s",
    async (scenario, expectation, rejection) => {
      const runId = `human-reply-${scenario}`;
      const sessionId = `session-${runId}`;
      const sessionKey = "agent:main:synthetic-human-reply";
      const collaborative = scenario.startsWith("collaborative-");
      const config = { session: { store: "/synthetic-workspace/sessions.sqlite" } };
      const operator = (profileId: string) =>
        createAdmittedRunOperatorAuthority({
          profileId,
          scopes: ["operator.read", "operator.write"],
          gatewayAccessGrant: null,
          modelPolicy: prepareOperatorModelPolicy({ cfg: config, policy: {} }),
          assertCurrent() {},
        });
      const admission = prepareAgentRunAdmission({
        cfg: {},
        operatorAuthority: collaborative ? operator("synthetic-owner") : undefined,
        operationalRunInstance: createOperationalRunInstanceRef(runId),
        facts: {
          agentId: "main",
          runId,
          ingress: { kind: "system", state: "present", boundary: "reply-promotion-test" },
        },
      });
      const operation = createReplyOperation({
        sessionId,
        sessionKey,
        turnKind: "direct",
        resetTriggered: false,
        target: captureSessionTarget({
          storeScope: config.session.store,
          sessionKey,
          incarnation: sessionId,
        }),
      });
      operation.setPhase("running");
      try {
        const admittedRunContext = await admission.admit("embedded", "reply-promotion-test");
        registerAgentRunContext(runId, {
          isControlUiVisible: scenario !== "hidden",
          projectSessionMessages: scenario !== "hidden",
        });
        await withPreparedEmbeddedRunToolAuthority(
          { admittedRunContext, replyOperation: operation },
          {
            runId,
            sessionId,
            sessionKey,
            agentId: "main",
            config,
            provider: "test-provider",
            modelId: "test-model",
            workspaceDir: "/synthetic-workspace",
            sessionFile: sessionKey,
            ...(collaborative
              ? {
                  messageProvider: "webchat",
                  conversationId: "synthetic-collaborative-conversation",
                  senderId: "synthetic-owner",
                  senderIsOwner: true,
                }
              : {}),
          },
          undefined,
          async (preparedAttempt) => {
            const { session } = await createTestSession();
            const firstRequest = createDeferredCore();
            const held = holdAssistantResponse("Synthetic completion draft.");
            const requests: Context[] = [];
            streamMocks.streamSimple.mockImplementation((model, context: Context) => {
              requests.push(context);
              if (requests.length === 1) {
                firstRequest.resolve();
                return held.response;
              }
              return createAssistantResultStream(createAssistant(model, "Synthetic human answer."));
            });
            const attempt = {
              ...preparedAttempt,
              admittedRunContext,
              terminalReplyExpectation: "optional" as const,
            };
            const prepared = prepareCatalogExecutor({
              activeSession: session,
              attempt,
              sessionKey,
              replyOperation: operation,
            });
            const target = captureReplyMessageInjectionTarget(operation);
            const answerQuestion = vi.fn(async () => ({ status: "answered" }));
            const pendingQuestion = collaborative
              ? registerPendingAgentQuestion({
                  questionId: `${runId}-owner-question`,
                  sessionKey,
                  questions: [
                    { id: "answer", header: "Answer", question: "Continue?", options: [] },
                  ],
                  gatewayCall: { version: 2, call: answerQuestion } satisfies QuestionDispatcher,
                  answer: Promise.resolve({ status: "pending" }),
                })
              : undefined;
            pendingQuestion?.attachRegistration(Promise.resolve());
            const prompt = session.prompt("Process the synthetic completion.");
            try {
              await firstRequest.promise;
              if (scenario === "closed") {
                prepared.stopAcceptingSteerMessages();
              }
              const injection = await beginReplyMessageInjectionTarget(
                target!,
                "Answer this human correction.",
                {
                  isInboundUserMessage: true,
                  // This control is ordinary steering, not a hidden question answer.
                  ...(scenario === "hidden" ? { allowPendingUserInputAnswer: false as const } : {}),
                  terminalReplyExpectation: expectation,
                  ...(collaborative
                    ? {
                        allowCollaborativeSteering: true,
                        toolAuthorityOverlay: {
                          operatorAuthority: operator("synthetic-collaborator"),
                          senderIsOwner: true,
                          disableTools: false,
                          traceAuthorized: false,
                          messageProvider: "webchat",
                          conversationId: "synthetic-collaborative-conversation",
                          senderId: "synthetic-collaborator",
                        },
                      }
                    : {}),
                  toolAuthorityFingerprint:
                    scenario === "wrong-authority"
                      ? "different-authority"
                      : preparedAttempt.toolAuthorityFingerprint,
                  waitForTranscriptCommit: true,
                  assertCurrent: () => {},
                },
              );
              const accepted = rejection === undefined;
              expect(await injection.acceptance).toBe(accepted);
              // A copied retry must read the logical run's accepted input, not its old policy.
              expect(resolveReplyExpectation({ ...attempt })).toBe(
                accepted ? expectation : "optional",
              );
              expect(prepared.queueHandle.terminalReplyExpectation).toBe(
                accepted ? expectation : "optional",
              );
              if (collaborative) {
                expect(answerQuestion).not.toHaveBeenCalled();
                expect(pendingQuestion?.isCancellationRequested()).toBe(false);
                expect(
                  resolveReplyCompletion(resolveReplyExpectation({ ...attempt }), "empty"),
                ).toMatchObject({ expectation, outcome: "missing" });
                expect(shouldDeliverMissingReplyNotice({ ...attempt })).toBe(true);
              }
              held.release();
              expect(await injection.outcome).toMatchObject(
                rejection ? { status: "rejected", reason: rejection } : { status: "accepted" },
              );
              await prompt;
              expect(requests).toHaveLength(accepted ? 2 : 1);
              if (accepted) {
                expect(JSON.stringify(requests[1]?.messages)).toContain(
                  "Answer this human correction.",
                );
                expect(session.messages.at(-1)).toMatchObject({
                  role: "assistant",
                  content: [{ type: "text", text: "Synthetic human answer." }],
                });
              }
              expect(session.getSteeringMessages()).toEqual([]);
            } finally {
              pendingQuestion?.dispose();
              held.release();
              await prompt;
              prepared.subscription.unsubscribe();
            }
          },
        );
      } finally {
        operation.complete();
        admission.close();
        clearAgentRunContext(runId);
      }
    },
  );
}
