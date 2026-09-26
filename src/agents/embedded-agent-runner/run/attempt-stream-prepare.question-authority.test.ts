import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { createMessageInjectionAuthority } from "../../../auto-reply/reply/message-injection-authority.js";
import type { ReplyOperation } from "../../../auto-reply/reply/reply-run-registry.contracts.js";
import {
  claimPendingReplyMessageInjectionTarget,
  createReplyOperation,
  replyRunRegistry,
} from "../../../auto-reply/reply/reply-run-registry.js";
import {
  assertPreparedConversationBindingRouteCurrent,
  readPreparedConversationBindingSourceRoutes,
} from "../../../auto-reply/reply/session-conversation-binding.js";
import { buildTestCtx } from "../../../auto-reply/reply/test-ctx.js";
import {
  copyConversationBindingRouteFacts,
  withConversationBindingRouteFacts,
} from "../../../channels/conversation-binding-route-facts.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "../../../infra/outbound/session-binding-service.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../../../sessions/user-turn-transcript.test-support.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  prepareAgentRunAdmission,
  createOperationalRunInstanceRef,
} from "../../admitted-run-context.js";
import { buildToolLifecycleErrorResult } from "../../embedded-agent-tool-results.js";
import {
  PreparedQuestionAnswerRefusedError,
  QuestionDispatchRefusedError,
} from "../../harness/gateway-question-dispatch.js";
import {
  registerPendingAgentQuestion,
  runAgentHarnessGatewayQuestion,
} from "../../harness/gateway-question.js";
import { withQuestionGateway } from "../../harness/gateway-question.test-support.js";
import { withPreparedEmbeddedRunToolAuthority } from "../../harness/tool-authority.runtime.js";
import {
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { isToolResultError } from "../../tool-result-error.js";
import { ACTIVE_EMBEDDED_RUNS, ACTIVE_EMBEDDED_RUN_REGISTRATIONS } from "../run-state.js";

type QuestionDispatcher = Extract<
  Parameters<typeof registerPendingAgentQuestion>[0]["gatewayCall"],
  { version: 2 }
>;

const mocks = vi.hoisted(() => ({
  clearActiveRun: vi.fn(),
  notifyToolActivity: vi.fn(),
  runBeforeFinalizeHook: vi.fn(),
  setActiveRun: vi.fn(),
  subscribe: vi.fn(),
}));

vi.mock("../../embedded-agent-subscribe.js", () => ({
  subscribeEmbeddedAgentSession: mocks.subscribe,
}));
vi.mock("../runs.js", () => ({
  clearActiveEmbeddedRun: mocks.clearActiveRun,
  setActiveEmbeddedRun: mocks.setActiveRun,
}));
vi.mock("./tool-activity-heartbeat.js", () => ({
  notifyToolActivity: mocks.notifyToolActivity,
}));
vi.mock("../../harness/lifecycle-hook-helpers.js", () => ({
  runAgentHarnessBeforeAgentFinalizeHook: mocks.runBeforeFinalizeHook,
}));

import { prepareCatalogExecutor } from "./attempt-stream-prepare.test-support.js";

registerAgentSessionLoopTestLifecycle();

describe("prepareEmbeddedAttemptStream", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  afterEach(async () => {
    const { testing } = await import("../runs.test-support.js");
    testing.resetActiveEmbeddedRuns();
    vi.restoreAllMocks();
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    ACTIVE_EMBEDDED_RUNS.clear();
    const runs = await vi.importActual<typeof import("../runs.js")>("../runs.js");
    mocks.setActiveRun.mockImplementation(runs.setActiveEmbeddedRun);
    mocks.clearActiveRun.mockImplementation(runs.clearActiveEmbeddedRun);
    mocks.subscribe.mockReturnValue({
      unsubscribe: vi.fn(),
      toolMetas: [],
      runToolLifecycle: vi.fn(async ({ args, execute, onTerminal }) => {
        try {
          const result = await execute(() => undefined);
          await onTerminal?.({
            result,
            isError: isToolResultError(result),
            executedArguments: structuredClone(args),
            effectReceipt: { state: "uncertain" },
          });
          return result;
        } catch (error) {
          await onTerminal?.({
            result: buildToolLifecycleErrorResult(error),
            isError: true,
            executedArguments: structuredClone(args),
            effectReceipt: { state: "uncertain" },
          });
          throw error;
        }
      }),
      isCompacting: vi.fn(() => false),
    });
    mocks.runBeforeFinalizeHook.mockResolvedValue({ action: "continue" });
  });

  it.each([
    ["replacement", "steering"],
    ["claim", "steering"],
    ["replacement", "question"],
    ["claim", "question"],
    ["source-close", "question"],
    ["source-throw", "question"],
    ["source-open", "question"],
    ["source-close", "steering"],
    ["source-throw", "steering"],
    ["source-open", "steering"],
    ["source-recovered-false", "steering"],
    ["source-recovered-throw", "steering"],
    ["source-recovered-false", "question"],
    ["source-recovered-throw", "question"],
    ["caller-mismatch", "question"],
  ] as const)(
    "checks %s during real session %s preparation before its effect",
    async (transition, route) => {
      const admission = prepareAgentRunAdmission({
        cfg: {},
        operationalRunInstance: createOperationalRunInstanceRef("run-output-schema"),
        facts: {
          agentId: "main",
          runId: "run-output-schema",
          ingress: { kind: "system", state: "present", boundary: "queue-test" },
        },
      });
      const operation = createReplyOperation({
        sessionKey: "agent:main:main",
        sessionId: "session-output-schema",
        turnKind: "visible",
        resetTriggered: false,
      });
      try {
        const admittedRunContext = await admission.admit("embedded", "queue-test");
        await withPreparedEmbeddedRunToolAuthority(
          { admittedRunContext },
          {
            runId: "run-output-schema",
            sessionId: "session-output-schema",
            sessionKey: "agent:main:main",
            agentId: "main",
            config: {},
            provider: "test-provider",
            modelId: "test-model",
            sessionFile: "/tmp/queue-test-session",
            workspaceDir: "/tmp/queue-test-workspace",
          },
          undefined,
          async (preparedAttempt) => {
            const toolAuthorityFingerprint = preparedAttempt.toolAuthorityFingerprint;
            if (!toolAuthorityFingerprint) {
              throw new Error("expected prepared tool authority fingerprint");
            }
            operation.bindToolAuthoritySnapshot({
              fingerprint: () => toolAuthorityFingerprint,
              project: () =>
                transition === "caller-mismatch" ? "lower-authority" : toolAuthorityFingerprint,
            });
            operation.bindToolAuthorityRoute({ provider: "test-provider", model: "test-model" });
            const { session } = await createTestSession();
            const started = createDeferredCore();
            const release = createDeferredCore();
            const recorder = createUserTurnTranscriptRecorder({
              input: { text: "redirect the original" },
              target: createTestUserTurnTranscriptTarget(),
            });
            const gatewayCall = vi.fn(async () => ({ status: "answered" }));
            const question =
              route === "question"
                ? registerPendingAgentQuestion({
                    questionId: "ask_00000000000000000000000000000000",
                    sessionKey: "agent:main:main",
                    questions: [
                      { id: "answer", header: "Answer", question: "Continue?", options: [] },
                    ],
                    gatewayCall: {
                      version: 2,
                      call: ({ authority }) => {
                        if (authority.kind === "source-bound") {
                          authority.assertCurrent();
                        }
                        return gatewayCall();
                      },
                    } satisfies QuestionDispatcher,
                    answer: Promise.resolve({ status: "pending" }),
                  })
                : undefined;
            question?.attachRegistration(Promise.resolve());
            vi.spyOn(
              recorder,
              route === "question" ? "persistApproved" : "resolveMessage",
            ).mockImplementation(async () => {
              started.resolve();
              await release.promise;
              return undefined;
            });
            const queued = vi.spyOn(session.agent, "steer");
            const prepared = prepareCatalogExecutor([], {
              activeSession: session,
              attempt: { ...preparedAttempt, replyOperation: operation },
            });
            operation.setPhase("running");
            let sourceCurrent = true;
            const assertCurrent = createMessageInjectionAuthority(() => {
              if (!sourceCurrent && transition.includes("throw")) {
                throw new Error("source claim lost");
              }
              return sourceCurrent;
            });
            const questionClaim =
              route === "question"
                ? vi.spyOn(prepared.queueHandle.messageInjectionV2!, "claimPendingUserInputAnswer")
                : undefined;
            const delivery =
              route === "question"
                ? claimPendingReplyMessageInjectionTarget({
                    target: replyRunRegistry.resolveCurrentMessageInjectionTarget(operation.key)!,
                    text: "redirect the original",
                    options: {
                      isInboundUserMessage: true,
                      userTurnTranscriptRecorder: recorder,
                      toolAuthorityOverlay: {
                        senderIsOwner: true,
                        disableTools: false,
                        traceAuthorized: false,
                      },
                    },
                    assertSourceCurrent: assertCurrent,
                  })
                : prepared.queueHandle.messageInjectionV2!.queueMessage(
                    "redirect the original",
                    {
                      isInboundUserMessage: true,
                      userTurnTranscriptRecorder: recorder,
                      toolAuthorityFingerprint: preparedAttempt.toolAuthorityFingerprint,
                    },
                    assertCurrent,
                    "source-bound",
                  );
            const outcome = delivery.then(
              () => "accepted",
              () => "rejected",
            );
            try {
              if (transition !== "caller-mismatch") {
                await started.promise;
              }
              if (transition === "claim") {
                admission.close();
              } else if (transition === "replacement") {
                mocks.setActiveRun(
                  "session-output-schema",
                  { ...prepared.queueHandle },
                  "agent:main:main",
                  preparedAttempt.sessionFile,
                );
              } else if (transition !== "source-open") {
                sourceCurrent = false;
              }
              if (transition.startsWith("source-recovered-")) {
                expect(assertCurrent).toThrow("Message injection authority is no longer current");
                sourceCurrent = true;
                // A fresh injection can proceed; recovery cannot revive this one.
                expect(createMessageInjectionAuthority(() => sourceCurrent)).not.toThrow();
              }
              release.resolve();
              const accepted = transition === "source-open";
              expect(await outcome).toBe(accepted ? "accepted" : "rejected");
              expect(queued).toHaveBeenCalledTimes(accepted && route === "steering" ? 1 : 0);
              expect(gatewayCall).toHaveBeenCalledTimes(accepted && route === "question" ? 1 : 0);
              if (questionClaim) {
                expect(questionClaim).toHaveBeenCalledOnce();
              }
              expect(session.getSteeringMessages()).toEqual(
                accepted && route === "steering" ? ["redirect the original"] : [],
              );
              if (transition.startsWith("source-")) {
                const authority = ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(
                  prepared.queueHandle,
                )?.toolAuthority;
                expect(authority).toBeDefined();
                authority!.assertActive();
                expect(ACTIVE_EMBEDDED_RUNS.get("session-output-schema")).toBe(
                  prepared.queueHandle,
                );
              }
            } finally {
              release.resolve();
              await outcome;
              question?.dispose();
              prepared.subscription.unsubscribe();
              vi.restoreAllMocks();
            }
          },
        );
      } finally {
        admission.close();
        operation.complete();
      }
    },
  );

  it.each([
    "allowed",
    "caller-mismatch",
    "source-revoked",
    "operation-reassigned",
    "binding-reassigned",
    "binding-during-hello",
    "binding-unbound-during-hello",
    "binding-expired-during-hello",
  ] as const)(
    "carries %s authority through the production V2 backend and Gateway transport",
    async (change) => {
      await withQuestionGateway(async (gateway) => {
        const sessionKey = `agent:main:production-question-${change}`;
        const sessionId = `production-question-${change}`;
        const runId = `production-question-${change}-run`;
        const questionId = `ask_production_${change.replaceAll("-", "_")}`;
        const admission = prepareAgentRunAdmission({
          cfg: {},
          operationalRunInstance: createOperationalRunInstanceRef(runId),
          facts: {
            agentId: "main",
            runId,
            ingress: { kind: "system", state: "present", boundary: "queue-test" },
          },
        });
        const operation = createReplyOperation({
          sessionKey,
          sessionId,
          resetTriggered: false,
        });
        let replacement: ReplyOperation | undefined;
        let question: ReturnType<typeof runAgentHarnessGatewayQuestion> | undefined;
        let prepared: ReturnType<typeof prepareCatalogExecutor> | undefined;
        let bindingAdapter: SessionBindingAdapter | undefined;
        let callerMatches = change !== "caller-mismatch";
        const source = new AbortController();
        const target = createTestUserTurnTranscriptTarget({
          sessionId,
          sessionKey,
          storePath: path.join(tempDirs.make(`production-question-${change}-`), "sessions.sqlite"),
        });
        await replaceSessionEntry(target, { sessionId, updatedAt: Date.now() });
        const recorder = createUserTurnTranscriptRecorder({
          input: { text: "Old source answer", idempotencyKey: `${runId}:user` },
          target,
        });
        expect(
          await recorder.stageApproved?.({
            runId,
            assertCurrent: () => source.signal.throwIfAborted(),
          }),
        ).toBe(true);
        try {
          const admittedRunContext = await admission.admit("embedded", "queue-test");
          await withPreparedEmbeddedRunToolAuthority(
            { admittedRunContext },
            {
              runId,
              sessionId,
              sessionKey,
              agentId: "main",
              config: {},
              provider: "test-provider",
              modelId: "test-model",
              sessionFile: `/tmp/${sessionId}.jsonl`,
              workspaceDir: "/tmp/production-question-workspace",
            },
            undefined,
            async (preparedAttempt) => {
              const toolAuthorityFingerprint = preparedAttempt.toolAuthorityFingerprint;
              if (!toolAuthorityFingerprint) {
                throw new Error("expected prepared tool authority fingerprint");
              }
              const bindOperation = (owner: ReplyOperation) => {
                owner.bindToolAuthoritySnapshot({
                  fingerprint: () => toolAuthorityFingerprint,
                  project: () => (callerMatches ? toolAuthorityFingerprint : "lower-authority"),
                });
                const route = { provider: "test-provider", model: "test-model" };
                owner.bindToolAuthorityRoute(route);
              };
              bindOperation(operation);
              const { session } = await createTestSession();
              prepared = prepareCatalogExecutor([], {
                activeSession: session,
                attempt: { ...preparedAttempt, replyOperation: operation },
              });
              operation.setPhase("running");
              const conversation = {
                channel: "webchat",
                accountId: "default",
                conversationId: sessionId,
              };
              const observedBinding: SessionBindingRecord = {
                bindingId: `generic:webchat␟default␟␟${sessionId}`,
                boundAt: 1,
                targetKind: "session",
                targetSessionKey: sessionKey,
                conversation,
                status: "active",
              };
              const expiringBinding: SessionBindingRecord = {
                ...observedBinding,
                expiresAt: Date.now() + 60_000,
              };
              const reassignedBinding: SessionBindingRecord = {
                ...observedBinding,
                bindingId: "binding-reassigned",
                boundAt: 2,
              };
              let liveBinding: SessionBindingRecord | null = observedBinding;
              const checksBinding =
                change === "binding-reassigned" || change === "binding-during-hello";
              if (change === "binding-expired-during-hello") {
                liveBinding = expiringBinding;
              }
              let bindingInspectWaits = change === "binding-reassigned";
              const bindingInspectEntered = createDeferredCore();
              let releaseBindingInspect = () => {};
              const inspectLiveBinding = () =>
                liveBinding?.expiresAt !== undefined && liveBinding.expiresAt <= Date.now()
                  ? null
                  : liveBinding;
              bindingAdapter = {
                channel: conversation.channel,
                accountId: conversation.accountId,
                listBySession: () => (inspectLiveBinding() ? [inspectLiveBinding()!] : []),
                inspectByConversation: inspectLiveBinding,
                inspectByConversationAsync: async () => {
                  if (bindingInspectWaits) {
                    bindingInspectWaits = false;
                    bindingInspectEntered.resolve();
                    await new Promise<void>((resolve) => {
                      releaseBindingInspect = resolve;
                    });
                  }
                  return inspectLiveBinding();
                },
                resolveByConversation: inspectLiveBinding,
                resolveByConversationAsync: async () => inspectLiveBinding(),
                touchAsync: async () => undefined,
              };
              registerSessionBindingAdapter(bindingAdapter);
              const bindingCtx = buildTestCtx({
                Provider: "webchat",
                Surface: "webchat",
                ChatType: "direct",
                From: "user:production-question",
                To: "channel:production-question",
                AgentId: "main",
                SessionKey: sessionKey,
                Body: "Old source answer",
                RawBody: "Old source answer",
                BodyForAgent: "Old source answer",
                BodyForCommands: "Old source answer",
                CommandBody: "Old source answer",
                CommandSource: "text",
                CommandAuthorized: true,
              });
              copyConversationBindingRouteFacts(
                withConversationBindingRouteFacts(
                  { sessionKey, agentId: "main" },
                  { kind: "agent", binding: observedBinding, sessionKey },
                  "main",
                  conversation,
                ),
                bindingCtx,
              );
              const assertPreparedCurrent =
                change === "binding-reassigned"
                  ? () => assertPreparedConversationBindingRouteCurrent(bindingCtx)
                  : undefined;
              const assertSourceCurrent = () => {
                source.signal.throwIfAborted();
              };
              const claimQuestion = (
                owner: ReplyOperation,
                text: string,
                sourceRecorder: typeof recorder | undefined,
                sourceAssertion: () => void,
              ) =>
                claimPendingReplyMessageInjectionTarget({
                  target: replyRunRegistry.resolveCurrentMessageInjectionTarget(owner.key)!,
                  text,
                  options: {
                    isInboundUserMessage: true,
                    questionSourceBindingRoutes:
                      readPreparedConversationBindingSourceRoutes(bindingCtx),
                    userTurnTranscriptRecorder: sourceRecorder,
                    toolAuthorityOverlay: {
                      senderIsOwner: true,
                      disableTools: false,
                      traceAuthorized: false,
                    },
                  },
                  assertSourceCurrent: sourceAssertion,
                  assertPreparedCurrent,
                });
              const sourceBindingRoutes = readPreparedConversationBindingSourceRoutes(bindingCtx);
              expect(sourceBindingRoutes).toBeDefined();
              const promptDelivered = createDeferredCore();
              question = runAgentHarnessGatewayQuestion({
                questionId,
                sessionKey,
                runId,
                questions: [{ id: "answer", header: "Answer", question: "Continue?", options: [] }],
                timeoutMs: 60_000,
                signal: gateway.backingRun.signal,
                delivery: { onBlockReply: async () => promptDelivered.resolve() },
              });
              await Promise.all([gateway.waitStarted, promptDelivered.promise]);

              const heldHello =
                change === "caller-mismatch" || change === "binding-reassigned"
                  ? undefined
                  : gateway.holdNextHello();
              const claim = claimQuestion(
                operation,
                "Old source answer",
                recorder,
                assertSourceCurrent,
              );
              if (change === "binding-reassigned") {
                await bindingInspectEntered.promise;
                liveBinding = reassignedBinding;
                releaseBindingInspect();
              } else if (heldHello) {
                await heldHello.entered;
                if (change === "source-revoked") {
                  source.abort();
                } else if (change === "binding-during-hello") {
                  liveBinding = reassignedBinding;
                } else if (change === "binding-unbound-during-hello") {
                  liveBinding = null;
                } else if (change === "binding-expired-during-hello") {
                  vi.useFakeTimers({ toFake: ["Date"] });
                  vi.setSystemTime(expiringBinding.expiresAt! + 1);
                } else if (change === "operation-reassigned") {
                  operation.complete();
                  replacement = createReplyOperation({
                    sessionKey,
                    sessionId: `${sessionId}-replacement`,
                    resetTriggered: false,
                  });
                  bindOperation(replacement);
                  replacement.attachBackend(prepared.queueHandle);
                  replacement.setPhase("running");
                }
                heldHello.release();
              }

              const resolveRequests = () =>
                gateway.requests.filter((frame) => frame.method === "question.resolve");
              if (change === "allowed") {
                await expect(claim).resolves.toBe(true);
                await expect(question).resolves.toMatchObject({ status: "answered" });
                expect(resolveRequests()).toHaveLength(1);
                expect(gateway.manager.get(questionId)?.status).toBe("answered");
                expect(recorder.hasPersisted()).toBe(true);
                return;
              }

              await expect(claim).rejects.toBeInstanceOf(
                change === "binding-reassigned"
                  ? PreparedQuestionAnswerRefusedError
                  : QuestionDispatchRefusedError,
              );
              const gatewayRejectedBinding =
                change === "binding-during-hello" ||
                change === "binding-unbound-during-hello" ||
                change === "binding-expired-during-hello";
              expect(resolveRequests()).toHaveLength(gatewayRejectedBinding ? 1 : 0);
              expect(gateway.manager.get(questionId)?.status).toBe("pending");
              callerMatches = true;
              if (checksBinding) {
                liveBinding = observedBinding;
              } else if (
                change === "binding-unbound-during-hello" ||
                change === "binding-expired-during-hello"
              ) {
                liveBinding = observedBinding;
              }
              recorder.finishPendingInput?.("interrupted");
              const currentOperation = replacement ?? operation;
              await expect(
                claimQuestion(
                  currentOperation,
                  "Current source answer",
                  undefined,
                  change === "binding-during-hello" ||
                    change === "binding-unbound-during-hello" ||
                    change === "binding-expired-during-hello"
                    ? assertSourceCurrent
                    : () => {},
                ),
              ).resolves.toBe(true);
              await expect(question).resolves.toMatchObject({ status: "answered" });
              expect(resolveRequests()).toHaveLength(gatewayRejectedBinding ? 2 : 1);
            },
          );
        } finally {
          if (bindingAdapter) {
            unregisterSessionBindingAdapter({
              channel: bindingAdapter.channel,
              accountId: bindingAdapter.accountId,
              adapter: bindingAdapter,
            });
          }
          source.abort();
          if (change === "binding-expired-during-hello") {
            vi.useRealTimers();
          }
          gateway.backingRun.abort();
          await question;
          recorder.finishPendingInput?.("interrupted");
          prepared?.subscription.unsubscribe();
          replacement?.complete();
          if (!operation.result) {
            operation.complete();
          }
          admission.close();
        }
      });
    },
  );
});
