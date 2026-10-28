import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMessageInjectionAuthority } from "../../../auto-reply/reply/message-injection-authority.js";
import type { Context } from "../../../llm/types.js";
import { createReplyOperation } from "../../../sessions/session-controller.js";
import { captureSessionTarget } from "../../../sessions/session-controller.lifecycle.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../../../sessions/user-turn-transcript.test-support.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  prepareAgentRunAdmission,
  createOperationalRunInstanceRef,
} from "../../admitted-run-context.js";
import type { SubscribeEmbeddedAgentSessionParams } from "../../embedded-agent-subscribe.types.js";
import { registerPendingAgentQuestion } from "../../harness/gateway-question.js";
import { withPreparedEmbeddedRunToolAuthority } from "../../harness/tool-authority.runtime.js";
import { isAgentRunRestartAbortReason } from "../../run-termination.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { getActiveNativeAttempt, getEmbeddedRunAttachment } from "../run-state.js";
import { registerReplyPromotionTests } from "./attempt-stream-prepare.reply-promotion.test-support.js";
import { registerPreparationSteeringTests } from "./attempt-stream-prepare.steering.test-support.js";
import type { EmbeddedRunAttemptInternalParams } from "./internal-params.js";

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
// mock-isolation: Synthetic stream handles must not register with the live native-run owner.
vi.mock("../runs.js", () => ({
  detachActiveEmbeddedRun: mocks.clearActiveRun,
  attachActiveEmbeddedRun: mocks.setActiveRun,
}));
vi.mock("../../../shared/tool-activity-heartbeat.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../shared/tool-activity-heartbeat.js")>()),
  notifyToolActivity: mocks.notifyToolActivity,
}));
vi.mock("../../harness/lifecycle-hook-helpers.js", () => ({
  runAgentHarnessBeforeAgentFinalizeHook: mocks.runBeforeFinalizeHook,
}));

import {
  createEmbeddedAttemptExternalAbortController,
  createEmbeddedAttemptRunAbort,
} from "./attempt-finalize.js";
import { SESSIONS_YIELD_ABORT_REASON } from "./attempt-sessions-yield.js";
import {
  createBeforeFinalizeEvent,
  createCatalogSubscription,
  observeTerminalRunActivity,
  createHeldSettlementSession,
  createTurnHandoffSession,
  prepareCatalogExecutor,
  trackPreparedStreamSubscriptions,
} from "./attempt-stream-prepare.test-support.js";

registerAgentSessionLoopTestLifecycle();

const steeringOptions = {
  isInboundUserMessage: true,
  toolAuthorityFingerprint: "test-steering",
  // Source-bound steering is checked again at final dispatch.
  assertCurrent: () => {},
};

function prepareDeferredSteering(
  session: NonNullable<Parameters<typeof prepareCatalogExecutor>[0]>["activeSession"],
  withFinalizeHook = false,
) {
  return prepareCatalogExecutor({
    activeSession: session,
    ...(withFinalizeHook
      ? { hookRunner: { hasHooks: (name: string) => name === "before_agent_finalize" } as never }
      : {}),
    attempt: {
      deferTerminalLifecycle: true,
      onDeferredLifecycleOwner: () => {},
      toolAuthorityFingerprint: steeringOptions.toolAuthorityFingerprint,
    },
  });
}

async function useRealSubscription() {
  const actual = await vi.importActual<typeof import("../../embedded-agent-subscribe.js")>(
    "../../embedded-agent-subscribe.js",
  );
  mocks.subscribe.mockImplementation(actual.subscribeEmbeddedAgentSession);
}

describe("prepareEmbeddedAttemptStream", () => {
  afterEach(async () => {
    const { testing } = await import("../runs.test-support.js");
    testing.resetActiveEmbeddedRuns();
    vi.restoreAllMocks();
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    const runs = await vi.importActual<typeof import("../runs.js")>("../runs.js");
    // Stream preparation retains its already imported spies. Fixture admission
    // must bind the real registry, not recursively call those registration spies.
    vi.doUnmock("../runs.js");
    const { testing, registerTestEmbeddedRun } = await import("../runs.test-support.js");
    testing.resetActiveEmbeddedRuns();
    mocks.setActiveRun.mockImplementation(registerTestEmbeddedRun);
    mocks.clearActiveRun.mockImplementation(runs.detachActiveEmbeddedRun);
    mocks.subscribe.mockReturnValue(createCatalogSubscription());
    mocks.runBeforeFinalizeHook.mockResolvedValue({ action: "continue" });
  });

  registerPreparationSteeringTests();

  it("projects only subscriber facts while preserving real stream reads and effects", async () => {
    const { session, listeners } = await trackPreparedStreamSubscriptions((subscribe) => {
      mocks.subscribe.mockImplementation(subscribe);
    });
    const actual = await vi.importActual<typeof import("../../embedded-agent-subscribe.js")>(
      "../../embedded-agent-subscribe.js",
    );
    let effects: unknown[] = [];
    const record = (...values: unknown[]) => {
      effects.push(values);
    };
    // Populate all inherited subscriber facts, including optional undefined values,
    // so the legacy spread and projection can compare property presence as well.
    const attempt = {
      runId: "stream-projection",
      sessionId: "stream-projection-session",
      lifecycleGeneration: undefined,
      initialReplayState: undefined,
      assistantErrorTranscript: undefined,
      verboseLevel: "full" as const,
      toolResultFormat: "markdown" as const,
      toolProgressDetail: "raw" as const,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => true,
      sourceReplyDeliveryMode: undefined,
      messageToolFinalByDefault: undefined,
      onToolResult: record,
      onAgentToolResult: record,
      observeToolTerminal: undefined,
      onReasoningStream: record,
      streamReasoningInNonStreamModes: true,
      onReasoningEnd: record,
      blockReplyBreak: "message_end" as const,
      blockReplyChunking: undefined,
      onPartialReply: record,
      onAssistantMessageStart: record,
      // A callback here causes the real subscriber to spread its input again;
      // keeping it absent lets the Proxy observe the nested event consumers.
      onAgentEvent: undefined,
      onExecutionPhase: record,
      onToolStreamBoundary: record,
      enforceFinalTag: false,
      silentExpected: false,
      suppressLiveStreamOutput: false,
      config: {},
      sessionPersistence: "detached" as const,
      sessionKey: "agent:main:stream-projection",
      currentChannelId: "synthetic-channel",
      currentMessagingTarget: undefined,
      currentMessageId: "synthetic-message",
      replyToMode: undefined,
      hasRepliedRef: { value: false },
      internalEvents: undefined,
      compactionCountOwner: "caller" as const,
      onContextAccountingEvent: record,
      prompt: "Unrelated attempt state must not enter the subscriber",
    } satisfies Partial<EmbeddedRunAttemptInternalParams>;
    const captured: SubscribeEmbeddedAgentSessionParams[] = [];
    mocks.subscribe.mockImplementation((params: SubscribeEmbeddedAgentSessionParams) => {
      captured.push(params);
      return createCatalogSubscription();
    });
    const prepared = prepareCatalogExecutor({ activeSession: session, attempt });
    const projected = captured[0];
    if (!projected) {
      throw new Error("expected stream preparation to subscribe");
    }
    expect(Object.hasOwn(projected, "prompt")).toBe(false);
    expect(Object.hasOwn(projected, "activeSession")).toBe(false);
    expect(projected.config).toBe(attempt.config);
    expect(projected.builtinToolNames).toBe(prepared.input.agentSession.builtinToolNames);

    // These are precisely the explicit overrides of the former spread caller.
    const legacy: SubscribeEmbeddedAgentSessionParams = {
      ...prepared.input.attempt,
      ...prepared.input.agentSession,
      session: projected.session,
      onModelUsage: projected.onModelUsage,
      messageChannel: projected.messageChannel,
      hookRunner: projected.hookRunner,
      reasoningMode: projected.reasoningMode,
      thinkingLevel: projected.thinkingLevel,
      hasDeliveredMessageToolOnlySourceReply: projected.hasDeliveredMessageToolOnlySourceReply,
      onDeliveredMessageToolOnlySourceReply: projected.onDeliveredMessageToolOnlySourceReply,
      trajectoryRecorder: projected.trajectoryRecorder,
      onBlockReply: projected.onBlockReply,
      onBlockReplyFlush: projected.onBlockReplyFlush,
      onBeforeTerminalDelivery: projected.onBeforeTerminalDelivery,
      deferTerminalDelivery: projected.deferTerminalDelivery,
      terminalLifecyclePhase: projected.terminalLifecyclePhase,
      isTerminalAborted: projected.isTerminalAborted,
      resolveTerminalStopReason: projected.resolveTerminalStopReason,
      onBeforeLifecycleTerminal: projected.onBeforeLifecycleTerminal,
      providerOwner: projected.providerOwner,
      currentAccountId: projected.currentAccountId,
      currentThreadId: projected.currentThreadId,
      agentId: projected.agentId,
    };
    type Read = { key: PropertyKey; present: boolean; value: unknown };
    const observe = (input: SubscribeEmbeddedAgentSessionParams, reads: Read[]) =>
      new Proxy(input, {
        get(target, key, receiver) {
          const value: unknown = Reflect.get(target, key, receiver);
          reads.push({ key, present: Object.hasOwn(target, key), value });
          return value;
        },
      });
    const exercise = async (input: SubscribeEmbeddedAgentSessionParams) => {
      const reads: Read[] = [];
      effects = [];
      const subscription = actual.subscribeEmbeddedAgentSession(observe(input, reads));
      const emit = async (event: Parameters<Parameters<typeof session.subscribe>[0]>[0]) => {
        for (const listener of listeners) {
          await listener(event);
        }
        await subscription.waitForPendingEvents();
      };
      try {
        const message = makeAgentAssistantMessage({
          content: [{ type: "text", text: "Projected stream answer" }],
          timestamp: 1,
        });
        await emit({ type: "agent_start" });
        await emit({ type: "message_start", message });
        await emit({
          type: "message_update",
          message,
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: "Projected stream answer",
            partial: message,
          },
        });
        await emit({ type: "message_end", message });
        await subscription.runToolLifecycle({
          toolName: "read",
          toolCallId: "projection-tool",
          args: { path: "synthetic.txt" },
          execute: async (started) => {
            started();
            return { content: [{ type: "text", text: "synthetic tool output" }] };
          },
        });
        await emit({
          type: "compaction_end",
          reason: "threshold",
          outcome: { status: "completed", tokensBefore: 100, tokensAfter: 50, willRetry: false },
        });
        await emit({ type: "agent_end", messages: [message], willRetry: false });
        return {
          reads,
          effects: effects.slice(),
          assistantTexts: subscription.assistantTexts.slice(),
          compactions: subscription.getCompactionCount(),
        };
      } finally {
        subscription.unsubscribe();
      }
    };
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const legacyResult = await exercise(legacy);
    const projectedResult = await exercise(projected);
    expect(projectedResult).toEqual(legacyResult);
    expect(projectedResult.effects.length).toBeGreaterThan(0);
    expect(projectedResult.assistantTexts).toEqual(["Projected stream answer"]);
    expect(projectedResult.compactions).toBe(1);
    // Every real callee read is present, including inherited attempt callbacks.
    expect([
      ...new Set(projectedResult.reads.filter((read) => !read.present).map((read) => read.key)),
    ]).toEqual([]);
    prepared.subscription.unsubscribe();
  });

  it("keeps exact stream owners current when physical stores share a session ID", async () => {
    const sessionId = "shared-stream-session";
    const runs = await vi.importActual<typeof import("../runs.js")>("../runs.js");
    const owners = await Promise.all(
      ["first", "second"].map(async (name) => {
        const sessionKey = `agent:main:stream-${name}`;
        const operation = createReplyOperation({
          sessionId,
          sessionKey,
          resetTriggered: false,
          target: captureSessionTarget({
            storeScope: `/synthetic/stream-${name}/sessions.sqlite`,
            sessionKey,
            incarnation: sessionId,
          }),
        });
        operation.setPhase("running");
        const { session } = await createTestSession();
        const recover = vi.fn(() => true);
        const prepared = prepareCatalogExecutor({
          activeSession: session,
          replyOperation: operation,
          recoverStalledModelCall: recover,
          sessionKey,
          attempt: { runId: `stream-${name}`, sessionId, sessionFile: `stream-${name}.jsonl` },
        });
        const answer = vi.fn(async () => ({ status: "answered" }));
        const question = registerPendingAgentQuestion({
          questionId: `ask-stream-${name}`,
          sessionKey,
          questions: [{ id: "answer", header: "Answer", question: "Continue?", options: [] }],
          gatewayCall: { version: 2, call: answer } satisfies QuestionDispatcher,
          answer: Promise.resolve({ status: "pending" }),
        });
        question.attachRegistration(Promise.resolve());
        return { name, sessionKey, operation, session, prepared, recover, answer, question };
      }),
    );
    try {
      expect(getActiveNativeAttempt(sessionId)).toBeUndefined();
      for (const owner of owners) {
        await owner.prepared.queueHandle.queueMessage(`steer ${owner.name}`);
        expect(owner.session.getSteeringMessages()).toContain(`steer ${owner.name}`);
        await expect(
          owner.prepared.queueHandle.claimPendingUserInputAnswer?.("continue", {
            isInboundUserMessage: true,
          }),
        ).resolves.toBe(true);
        expect(owner.answer).toHaveBeenCalledOnce();
        expect(owner.prepared.queueHandle.recoverStalledModelCall?.()).toBe(true);
        expect(owner.recover).toHaveBeenCalledOnce();
      }
      const first = owners[0]!;
      const second = owners[1]!;
      runs.detachActiveEmbeddedRun(sessionId, first.prepared.queueHandle);
      await expect(first.prepared.queueHandle.queueMessage("retired")).rejects.toThrow(
        "active session is finalizing",
      );
      expect(first.prepared.queueHandle.recoverStalledModelCall?.()).toBe(false);
      await second.prepared.queueHandle.queueMessage("still current");
      expect(second.session.getSteeringMessages()).toContain("still current");
      expect(second.prepared.queueHandle.recoverStalledModelCall?.()).toBe(true);
    } finally {
      for (const owner of owners) {
        owner.question.dispose();
        owner.prepared.subscription.unsubscribe();
        runs.detachActiveEmbeddedRun(sessionId, owner.prepared.queueHandle);
        owner.operation.complete();
      }
    }
  });

  it("preserves transcript routing and run-local media trust at the subscription", () => {
    const trustedLocalMediaToolNames = new Set(["plugin_media"]);
    const sessionKey = "agent:main:internal-session-effects:companion-run";
    prepareCatalogExecutor({
      trustedLocalMediaToolNames,
      sessionKey,
      attempt: { sandboxSessionKey: "agent:main:main" },
    });
    expect(mocks.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ trustedLocalMediaToolNames, sessionKey }),
    );
  });

  it("tells the subscriber a bot sent the turn, so its questions go to the owner", () => {
    prepareCatalogExecutor({ attempt: { senderIsBot: true } });
    expect(mocks.subscribe).toHaveBeenCalledWith(expect.objectContaining({ senderIsBot: true }));
  });

  registerReplyPromotionTests();

  it("borrows live fork history until the fork owner creates an isolated context", async () => {
    const { session } = await createTestSession();
    const model = session.model!;
    const content = [{ type: "text" as const, text: "parent history" }];
    const message = createAssistant(model, content);
    session.agent.state.messages = [message];
    const prepared = prepareCatalogExecutor({
      activeSession: session,
      attempt: { model, sessionFile: "agent:main:main" },
    });
    expect(prepared.queueHandle.readSessionForkContext?.()?.messages).toBe(session.messages);

    const { prepareEmbeddedSessionForkContext } = await import("../session-fork-context.js");
    const context = await prepareEmbeddedSessionForkContext({
      target: {
        agentId: "main",
        sessionId: "session-output-schema",
        sessionKey: "agent:main:main",
      },
      sessionFile: "agent:main:main",
      model,
      workspaceDir: "/synthetic/fork",
      agentDir: "/synthetic/fork/agent",
      agentId: "main",
      assertCurrent() {},
    });
    expect(context.messages).toEqual([message]);
    const forkContent = context.messages[0]?.content;
    if (!Array.isArray(forkContent) || forkContent[0]?.type !== "text") {
      throw new Error("expected fork text content");
    }
    forkContent[0].text = "child edit";
    context.messages.push({ role: "user", content: "child turn", timestamp: 2 });
    expect(session.messages).toEqual([message]);
    expect(content[0]?.text).toBe("parent history");
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
    ["source-recovered-false", "question"],
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
            const queued = vi.spyOn(session.agent, "admitSteeringMessage");
            const prepared = prepareCatalogExecutor({
              activeSession: session,
              attempt: preparedAttempt,
            });
            let sourceCurrent = true;
            const assertCurrent = createMessageInjectionAuthority(() => {
              if (!sourceCurrent && transition.includes("throw")) {
                throw new Error("source claim lost");
              }
              return sourceCurrent;
            });
            const delivery = prepared.queueHandle.messageInjectionV2!.queueMessage(
              "redirect the original",
              { isInboundUserMessage: true, userTurnTranscriptRecorder: recorder },
              assertCurrent,
              "source-bound",
            );
            const outcome = delivery.then(
              () => "accepted",
              () => "rejected",
            );
            try {
              await started.promise;
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
              expect(session.getSteeringMessages()).toEqual(
                accepted && route === "steering" ? ["redirect the original"] : [],
              );
              if (transition.startsWith("source-")) {
                const authority = getEmbeddedRunAttachment(prepared.queueHandle)?.toolAuthority;
                expect(authority).toBeDefined();
                authority!.assertActive();
                expect(getActiveNativeAttempt("session-output-schema")).toBe(prepared.queueHandle);
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
      }
    },
  );

  it.each([
    [undefined, "check git status"],
    ["raw", "check git status, `git status`"],
  ] as const)(
    "renders %s progress detail through the real subscription",
    async (toolProgressDetail, meta) => {
      await useRealSubscription();
      const onAgentEvent = vi.fn();
      const prepared = prepareCatalogExecutor({ toolProgressDetail, onAgentEvent });
      try {
        await prepared.toolSearchCatalogExecutor({
          tool: {
            name: "exec",
            execute: async () => ({ content: [{ type: "text", text: "clean" }] }),
          } as never,
          toolName: "exec",
          source: "openclaw",
          toolCallId: "progress-detail-exec",
          input: { command: "git status" },
          acceptResultBeforeProjection: async (result) => result,
        });
        expect(onAgentEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            stream: "item",
            data: expect.objectContaining({ phase: "start", kind: "tool", name: "exec", meta }),
          }),
        );
      } finally {
        prepared.subscription.unsubscribe();
      }
    },
  );

  it.each([false, true])(
    "keeps finalization closed after revision or unsubscribe (unsubscribe: %s)",
    async (unsubscribeDuringHook) => {
      let resolveHook:
        | ((value: { action: "revise"; reason: string } | { action: "continue" }) => void)
        | undefined;
      const enteredHook = createDeferredCore();
      const runBeforeAgentFinalize = vi.fn(
        (_event: { messages: unknown[] }) =>
          new Promise((resolve) => {
            resolveHook = resolve;
            enteredHook.resolve();
          }),
      );
      const actualHooks = await vi.importActual<
        typeof import("../../harness/lifecycle-hook-helpers.js")
      >("../../harness/lifecycle-hook-helpers.js");
      mocks.runBeforeFinalizeHook.mockImplementation(
        actualHooks.runAgentHarnessBeforeAgentFinalizeHook,
      );
      const messages = [{ role: "user", content: "Question" }];
      const prepared = prepareCatalogExecutor({
        attempt: {
          runId: "run-finalize-id",
          sessionId: "session-finalize-id",
          maxBeforeAgentFinalizeRevisions: 3,
          beforeAgentFinalizeRevisionAttempts: 0,
        },
        activeSession: {
          agent: { hasQueuedMessages: () => false },
          isStreaming: false,
          messages,
          pendingMessageCount: 0,
          subscribe: () => () => {},
        } as never,
        hookRunner: {
          hasHooks: (name: string) => name === "before_agent_finalize",
          runBeforeAgentFinalize,
        } as never,
      });
      const subscriptionInput = mocks.subscribe.mock.calls.at(-1)?.[0] as {
        onBeforeTerminalDelivery?: (event: unknown) => Promise<unknown>;
      };
      const decision = subscriptionInput.onBeforeTerminalDelivery?.(createBeforeFinalizeEvent());

      try {
        await enteredHook.promise;
        expect(runBeforeAgentFinalize).toHaveBeenCalledOnce();
        const hookMessages = runBeforeAgentFinalize.mock.calls[0]?.[0].messages;
        expect(hookMessages).not.toBe(messages);
        expect(hookMessages?.[0]).toBe(messages[0]);
        messages.push({ role: "user", content: "Later message" });
        expect(hookMessages).toHaveLength(1);
        expect(prepared.queueHandle.isStopped?.()).toBe(true);
        await expect(prepared.queueHandle.queueMessage("too late")).rejects.toThrow(
          "active session is finalizing",
        );

        if (unsubscribeDuringHook) {
          prepared.subscription.unsubscribe();
          resolveHook?.({ action: "continue" });
          await expect(decision).resolves.toBeUndefined();
          expect(prepared.getBeforeAgentFinalizeRevisionEntryId()).toBeUndefined();
        } else {
          resolveHook?.({ action: "revise", reason: "Tighten the answer" });
          await expect(decision).resolves.toEqual({ suppressTerminalDelivery: true });
          expect(prepared.getBeforeAgentFinalizeRevisionEntryId()).toBe("canonical-entry-id");
        }
        expect(hookMessages).toHaveLength(1);
        expect(prepared.queueHandle.isStopped?.()).toBe(true);
      } finally {
        resolveHook?.({ action: "continue" });
        await decision;
        prepared.subscription.unsubscribe();
      }
    },
  );

  it("keeps already-started steering authoritative over finalization", async () => {
    let resolveSteer: (() => void) | undefined;
    const activeSession = {
      agent: { hasQueuedMessages: () => false },
      isStreaming: false,
      messages: [],
      pendingMessageCount: 0,
      steer: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveSteer = resolve;
          }),
      ),
      subscribe: vi.fn(() => () => {}),
    };
    const prepared = prepareCatalogExecutor({
      attempt: {
        runId: "run-finalize-steer",
        sessionId: "session-finalize-steer",
        maxBeforeAgentFinalizeRevisions: 3,
        beforeAgentFinalizeRevisionAttempts: 0,
      },
      activeSession: activeSession as never,
      hookRunner: { hasHooks: (name: string) => name === "before_agent_finalize" } as never,
    });
    const queued = prepared.queueHandle.queueMessage("new user input");
    const subscriptionInput = mocks.subscribe.mock.calls.at(-1)?.[0] as {
      onBeforeTerminalDelivery?: (event: unknown) => Promise<unknown>;
    };

    try {
      await expect(
        subscriptionInput.onBeforeTerminalDelivery?.(createBeforeFinalizeEvent()),
      ).resolves.toBeUndefined();

      expect(mocks.runBeforeFinalizeHook).not.toHaveBeenCalled();
      expect(prepared.queueHandle.isStopped?.()).toBe(false);
    } finally {
      resolveSteer?.();
      try {
        await queued;
      } finally {
        prepared.subscription.unsubscribe();
      }
    }
  });

  it("rejects steering after session settlement while its lifecycle owner remains published", async () => {
    const sessionId = "session-output-schema";
    const { session, settled, releaseSettlement } = await createHeldSettlementSession();
    const steer = vi.spyOn(session.agent, "admitSteeringMessage");
    await useRealSubscription();
    const prepared = prepareDeferredSteering(session, true);
    const prompt = session.prompt("Finish this turn.");
    let nestedPrompt: Promise<void> | undefined;
    let unsubscribeNested: (() => void) | undefined;
    try {
      await settled.promise;
      expect(getActiveNativeAttempt(sessionId)).toBe(prepared.queueHandle);
      const { steerTestSessionTurn: queueMessage } = await import("../runs.test-support.js");
      const expected = { status: "rejected", reason: "injection_unavailable" };
      // The nonwaiting call makes the old late-admission bug fail without a delivery timeout.
      await expect(
        queueMessage(sessionId, "Start the next turn.", steeringOptions),
      ).resolves.toMatchObject(expected);
      await expect(
        queueMessage(sessionId, "Wait for the next turn.", {
          ...steeringOptions,
          waitForTranscriptCommit: true,
        }),
      ).resolves.toMatchObject(expected);
      const nestedEnd = createDeferredCore<Awaited<ReturnType<typeof queueMessage>>>();
      unsubscribeNested = session.subscribe((event) => {
        if (event.type !== "agent_end") {
          return undefined;
        }
        unsubscribeNested?.();
        return queueMessage(sessionId, "Stale owner.", steeringOptions).then(
          nestedEnd.resolve,
          nestedEnd.reject,
        );
      });
      nestedPrompt = session.prompt("Run a nested turn during cleanup.");
      await expect(
        nestedEnd.promise,
        "a nested turn must not reopen settled admission",
      ).resolves.toMatchObject(expected);
      expect(mocks.runBeforeFinalizeHook).toHaveBeenCalledTimes(2);
      expect(steer).not.toHaveBeenCalled();
      expect(session.getSteeringMessages()).toEqual([]);
    } finally {
      unsubscribeNested?.();
      releaseSettlement.resolve();
      await Promise.all([prompt, nestedPrompt]);
      prepared.stopAcceptingSteerMessages();
      await prepared.deferredLifecycleOwner?.discard();
      prepared.subscription.unsubscribe();
    }
  });

  it("keeps registered steering open across an agent-end continuation", async () => {
    const { session } = await createTestSession();
    const requests: Context[] = [];
    streamMocks.streamSimple.mockImplementation((model, context: Context) => {
      requests.push(context);
      return createAssistantResultStream(createAssistant(model, [{ type: "text", text: "Done." }]));
    });
    const prepared = prepareDeferredSteering(session);
    const { steerTestSessionTurn: queueMessage } = await import("../runs.test-support.js");
    const events: string[] = [];
    let queued: Awaited<ReturnType<typeof queueMessage>> | undefined;
    // Register after preparation so an accidental raw agent_end closure is observable.
    const unsubscribe = session.subscribe(async (event) => {
      if (event.type === "agent_settled") {
        events.push(event.type);
      }
      if (event.type !== "agent_end") {
        return;
      }
      events.push(event.type);
      if (events.length === 1) {
        queued = await queueMessage(
          "session-output-schema",
          "Continue this turn.",
          steeringOptions,
        );
      }
    });
    try {
      await session.prompt("Begin this turn.");
      expect(queued).toMatchObject({ status: "accepted" });
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[1]?.messages)).toContain("Continue this turn.");
      expect(events).toEqual(["agent_end", "agent_end", "agent_settled"]);
      expect(session.agent.hasQueuedMessages()).toBe(false);
    } finally {
      unsubscribe();
      await prepared.deferredLifecycleOwner?.discard();
      prepared.subscription.unsubscribe();
    }
  });

  it("rejects registered steering after a real turn handoff", async () => {
    const session = await createTurnHandoffSession();
    const prepared = prepareDeferredSteering(session);
    const events: string[] = [];
    const unsubscribe = session.subscribe((event) => {
      events.push(event.type);
    });
    const { steerTestSessionTurn: queueMessage } = await import("../runs.test-support.js");
    try {
      await session.prompt("Hand off this turn.");
      expect(events).toContain("agent_handoff");
      expect(events).not.toContain("agent_settled");
      expect(getActiveNativeAttempt("session-output-schema")).toBe(prepared.queueHandle);
      await expect(
        queueMessage("session-output-schema", "Too late.", steeringOptions),
      ).resolves.toMatchObject({ status: "rejected", reason: "injection_unavailable" });
      expect(session.getSteeringMessages()).toEqual([]);
    } finally {
      unsubscribe();
      await prepared.deferredLifecycleOwner?.discard();
      prepared.subscription.unsubscribe();
    }
  });

  it.each(["ordinary", "deferred cancellation", "pending task"] as const)(
    "publishes terminal activity under %s ownership",
    async (scenario) => {
      const result = await observeTerminalRunActivity(scenario, (subscribe) =>
        mocks.subscribe.mockImplementation(subscribe),
      );
      const deferred = scenario === "deferred cancellation";
      const active = deferred || scenario === "pending task";
      expect(result).toEqual({
        activeBefore: true,
        terminalEvents: [{ phase: deferred ? "finishing" : "end", active }],
        activeAfter: active,
      });
    },
  );

  it.each(["deferred lifecycle adoption"] as const)(
    "releases acquired stream subscriptions when %s fails",
    async (stage) => {
      const { session, listeners, releases } = await trackPreparedStreamSubscriptions((subscribe) =>
        mocks.subscribe.mockImplementation(subscribe),
      );
      const failure = new Error(`${stage} failed`);
      const fail = () => {
        throw failure;
      };
      expect(() =>
        prepareCatalogExecutor({
          activeSession: session,
          attempt: {
            deferTerminalLifecycle: true,
            onDeferredLifecycleOwner: fail,
          },
        }),
      ).toThrow(failure);
      expect(releases).toHaveLength(2);
      expect(listeners.size).toBe(0);
      for (const release of releases) {
        expect(release).toHaveBeenCalledOnce();
      }
      expect(Boolean(getActiveNativeAttempt("session-output-schema"))).toBe(false);
    },
  );

  it("releases each stream subscription once through complete cleanup", async () => {
    const { session, listeners, releases } = await trackPreparedStreamSubscriptions((subscribe) =>
      mocks.subscribe.mockImplementation(subscribe),
    );
    const runAbortController = new AbortController();
    const prepared = prepareCatalogExecutor({
      activeSession: session,
      runAbortController,
      abortRun: (_isTimeout, reason) => runAbortController.abort(reason),
      attempt: { deferTerminalLifecycle: true, onDeferredLifecycleOwner: () => {} },
    });
    expect(listeners.size).toBe(2);
    await prepared.deferredLifecycleOwner!.complete();

    expect(prepared.queueHandle.isStopped?.()).toBe(true);
    expect(listeners.size).toBe(0);
    prepared.stopAcceptingSteerMessages();
    prepared.subscription.unsubscribe();
    await prepared.deferredLifecycleOwner!.discard();
    prepared.subscription.unsubscribe();
    expect(listeners.size).toBe(0);
    for (const release of releases) {
      expect(release).toHaveBeenCalledOnce();
    }
  });

  it("distinguishes an accepted abort from normal steering closure and sessions_yield", () => {
    const runAbortController = new AbortController();
    let aborted = false;
    const prepared = prepareCatalogExecutor({
      runAbortController,
      getRunState: () => ({
        aborted,
        promptError: undefined,
        timedOut: false,
        yieldDetected: false,
      }),
    });

    expect(prepared.queueHandle.isAborted?.()).toBe(false);
    prepared.stopAcceptingSteerMessages();
    expect(prepared.queueHandle.isStopped?.()).toBe(true);
    expect(prepared.queueHandle.isAborted?.()).toBe(false);

    runAbortController.abort(SESSIONS_YIELD_ABORT_REASON);
    expect(prepared.queueHandle.isAborted?.()).toBe(false);

    aborted = true;
    expect(prepared.queueHandle.isAborted?.()).toBe(true);
  });

  it("processes aliased cancel and abort through one external-abort sequence", () => {
    const markExternalAbort = vi.fn();
    const onAttemptAbort = vi.fn();
    const abortRun = vi.fn();
    const prepared = prepareCatalogExecutor({
      markExternalAbort,
      onAttemptAbort,
      abortRun,
    });

    prepared.queueHandle.abort("restart");
    prepared.queueHandle.cancel("user_abort");

    expect(markExternalAbort).toHaveBeenCalledOnce();
    expect(onAttemptAbort).toHaveBeenCalledOnce();
    expect(abortRun).toHaveBeenCalledOnce();
    expect(abortRun.mock.calls[0]?.[0]).toBe(false);
    expect(isAgentRunRestartAbortReason(abortRun.mock.calls[0]?.[1])).toBe(true);
  });

  it("runs attempt cleanup once when reply cancellation re-enters through its abort signal", () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-output-schema",
      resetTriggered: false,
    });
    const attemptAbortController = new AbortController();
    const runAbortController = new AbortController();
    const markExternalAbort = vi.fn();
    const abortActiveSession = vi.fn(async () => {});
    const abortState: Parameters<typeof createEmbeddedAttemptRunAbort>[0]["state"] = {
      terminal: { kind: "ok" },
    };
    const externalAbortController = createEmbeddedAttemptExternalAbortController({
      abortSignal: attemptAbortController.signal,
      cleanupAfterEarlyAbort: vi.fn(async () => {}),
      runAbortController,
      runId: "run-output-schema",
      state: abortState,
    });
    let queueHandle: ReturnType<typeof prepareCatalogExecutor>["queueHandle"] | undefined;
    const abortRun = createEmbeddedAttemptRunAbort({
      abortActiveSession,
      activeSession: { abortCompaction: vi.fn(), isCompacting: false },
      attempt: {
        runId: "run-output-schema",
        sessionFile: "agent:main:main",
        sessionId: "session-output-schema",
        sessionKey: "agent:main:main",
      },
      getQueueHandle: () => queueHandle,
      isProbeSession: true,
      log: { warn: vi.fn() },
      runAbortController,
      state: abortState,
    });
    externalAbortController.setRunAbort(abortRun);
    externalAbortController.arm();
    const relayReplyAbort = () => {
      attemptAbortController.abort(operation.abortSignal.reason);
    };
    operation.abortSignal.addEventListener("abort", relayReplyAbort, { once: true });
    const onAttemptAbort = vi.fn(() => {
      if (!operation.abortSignal.aborted) {
        operation.abortByUser();
      }
    });

    try {
      operation.setPhase("running");
      const prepared = prepareCatalogExecutor({
        replyOperation: operation,
        markExternalAbort,
        onAttemptAbort,
        abortRun,
      });
      queueHandle = prepared.queueHandle;
      const cancel = vi.spyOn(prepared.queueHandle, "cancel");

      expect(operation.abortForStall()).toBe(true);

      expect(markExternalAbort).toHaveBeenCalledOnce();
      expect(onAttemptAbort).toHaveBeenCalledOnce();
      expect(abortState.terminal).toEqual({ kind: "aborted", source: "external" });
      expect(abortActiveSession).toHaveBeenCalledOnce();
      expect(cancel).toHaveBeenCalledExactlyOnceWith("superseded");
      // The controller signal reaches the attempt before backend cancellation;
      // reentrant cancellation must preserve that first owner-provided reason.
      expect(runAbortController.signal.reason).toBe(operation.abortSignal.reason);
      expect(runAbortController.signal.reason).toMatchObject({ name: "AbortError" });
      expect(operation.result).toEqual({ kind: "failed", code: "run_stalled" });
      expect(operation.abortSignal.aborted).toBe(true);
    } finally {
      externalAbortController.dispose();
      operation.abortSignal.removeEventListener("abort", relayReplyAbort);
      operation.complete();
    }
  });
});
