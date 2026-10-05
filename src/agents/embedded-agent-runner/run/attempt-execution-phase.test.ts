import { randomUUID } from "node:crypto";
import path from "node:path";
import { createAssistantMessageEventStream, type Message } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  loadTranscriptEventsSync,
  replaceSessionEntrySync,
} from "../../../config/sessions/session-accessor.js";
import { fetchWithSsrFGuard } from "../../../infra/net/fetch-guard.js";
import { captureGuardedFetchRequestAuthority } from "../../../infra/net/fetch-request-authority.js";
import { createDiagnosticEmbeddedRunOwner } from "../../../logging/diagnostic-run-activity.js";
import { runAgentLoop } from "../../../plugin-sdk/agent-core.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import {
  applyAgentAutoCompactionGuard,
  applyAgentCompactionSettingsFromConfig,
} from "../../agent-settings.js";
import { createEmbeddedModelState } from "../../embedded-agent-subscribe.model-state.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import {
  createAssistant,
  createAssistantResultStream,
  createAutoCompactionSettings,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import type { AgentSessionEvent } from "../../sessions/agent-session-types.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { makeZeroUsageSnapshot } from "../../usage.js";
import { resolveEmbeddedAgentStream } from "../stream-resolution.js";

// Register the shared module mocks before importing any runtime dependency.
const { createFixture, mocks } = await vi.hoisted(
  async () => await import("./attempt-execution-phase.test-support.js"),
);

import { runEmbeddedAttemptExecutionPhase } from "./attempt-execution-phase.js";
import { prepareEmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle-prepare.js";
import type { EmbeddedContextAccountingEvent } from "./internal-params.js";
import { claimAgentSessionWriter } from "./session-bootstrap.js";

registerAgentSessionLoopTestLifecycle();
afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runEmbeddedAttemptExecutionPhase", () => {
  it.each([
    { kind: "cron root", key: "agent:main:cron:provider-fence", change: "current", guarded: true },
    { kind: "cron root", key: "agent:main:cron:provider-fence", change: "rotated", guarded: true },
    { kind: "cron root", key: "agent:main:cron:provider-fence", change: "reset", guarded: true },
    {
      kind: "ordinary",
      key: "agent:main:dashboard:provider-fence",
      change: "current",
      guarded: false,
    },
    {
      kind: "exact cron run",
      key: "agent:main:cron:provider-fence:run:cron-run-1",
      change: "current",
      guarded: false,
    },
  ] as const)(
    "scopes the provider generation guard after writer admission ($kind, $change)",
    async ({ key, change, guarded }) => {
      await withOpenClawTestState({ label: "cron-root-provider-fence" }, async (testState) => {
        const fixture = await createFixture({ exerciseTerminalMerges: false });
        const target = {
          agentId: "main",
          sessionKey: key,
          sessionId: "cron-run-1",
          storePath: path.join(testState.agentDir(), "openclaw-agent.sqlite"),
        };
        const original = {
          sessionId: target.sessionId,
          lifecycleRevision: "generation-1",
          updatedAt: 1,
        };
        replaceSessionEntrySync(target, original);
        Object.assign(fixture.input.attempt, {
          ...target,
          sessionTarget: target,
          sessionFile: target.sessionKey,
        });
        const writer = await claimAgentSessionWriter({
          ...target,
          sessionTarget: target,
          runId: fixture.input.attempt.runId,
          workspaceDir: testState.workspaceDir,
          prompt: "reply",
          timeoutMs: 30_000,
        });
        fixture.input.attempt.sessionTarget = { ...target, ...writer };
        const transcript = await prepareEmbeddedAttemptTranscriptLifecycle({
          attempt: fixture.input.attempt,
          externalAbortController: { arm: () => {}, throwIfFiredAfterPrepCleanup: async () => {} },
        });
        fixture.input.sessionLock = transcript;
        const manager = SessionManager.open({ ...target, ...writer });
        const fetchImpl = vi.fn(async () => new Response("ok"));
        fixture.activeSession.prompt.mockImplementation(async () => {
          const requestAuthority = captureGuardedFetchRequestAuthority();
          if (guarded) {
            expect(requestAuthority).toBeTypeOf("function");
          } else {
            expect(requestAuthority).toBeUndefined();
          }
          const response = await fetchWithSsrFGuard({
            url: "https://public.example/provider",
            fetchImpl,
            lookupFn: async () => {
              if (change !== "current") {
                replaceSessionEntrySync(target, {
                  ...original,
                  sessionId: change === "rotated" ? "cron-run-2" : target.sessionId,
                  lifecycleRevision: "generation-2",
                });
              }
              return [{ address: "93.184.216.34", family: 4 }];
            },
          });
          await response.release();
        });
        mocks.runSettledPhase.mockImplementation(async (settled) => {
          await settled.preparedStreamRuntime.promptActiveSession("reply");
          return fixture.result;
        });
        try {
          const execution = runEmbeddedAttemptExecutionPhase(fixture.input);
          if (change === "current") {
            await execution;
            expect(fetchImpl).toHaveBeenCalledOnce();
            await transcript.withOwnedTranscriptWrite(() =>
              manager.appendMessage({ role: "user", content: "allowed", timestamp: 1 }),
            );
            expect(loadTranscriptEventsSync(target)).toMatchObject([
              { type: "session" },
              { type: "message", message: { role: "user", content: "allowed" } },
            ]);
          } else {
            await expect(execution).rejects.toThrow(
              "original session generation no longer accepts",
            );
            expect(fetchImpl).not.toHaveBeenCalled();
            await expect(
              transcript.withOwnedTranscriptWrite(() =>
                manager.appendMessage({ role: "user", content: "stale", timestamp: 1 }),
              ),
            ).rejects.toThrow();
            expect(loadTranscriptEventsSync(target)).toEqual([]);
          }
        } finally {
          await transcript.transcriptLifecycle.dispose();
        }
      });
    },
  );

  it.each([
    ["stop", 10_000, "event"],
    ["stop", 0, "event"],
    ["toolUse", 10_000, "event"],
    ["error", 10_000, "event"],
    ["aborted", 10_000, "event"],
    ["stop", 10_000, "result"],
    ["stop", 0, "result"],
    ["error", 10_000, "result"],
    ["output-limit", 10_000, "event"],
    ["output-limit", 10_000, "result"],
  ] as const)(
    "observes terminal %s usage once across async-tool fragments (cacheRead=%s, completion=%s)",
    async (stopReason, cacheRead, completion) => {
      const terminalStopReason = stopReason === "output-limit" ? "error" : stopReason;
      const fixture = await createFixture();
      const recordStage = vi.fn();
      const runtime = fixture.input.prepared.sessionRuntime;
      Object.assign(fixture.input.attempt, {
        model: testModel,
        modelId: testModel.id,
        provider: testModel.provider,
        sessionId: randomUUID(),
      });
      Object.assign(runtime, {
        anthropicPayloadLogger: undefined,
        isOpenAIResponsesApi: false,
        cacheTrace: { recordStage, wrapStreamFn: (streamFn: unknown) => streamFn },
      });
      const toolCall = {
        type: "toolCall",
        name: "read",
        id: "read-1",
        arguments: {},
        async: true,
      } as const;
      const message = createAssistant(
        testModel,
        [toolCall, { type: "text", text: "Done." }],
        terminalStopReason,
      );
      if (stopReason === "output-limit") {
        message.errorCode = "incomplete_tool_call";
        message.diagnostics = [
          {
            type: "openai_responses_terminal",
            timestamp: 1,
            details: {
              eventType: "response.incomplete",
              stopReason: "length",
              incompleteReason: "max_output_tokens",
            },
          },
        ];
      }
      message.usage = {
        ...makeZeroUsageSnapshot(),
        input: 100,
        output: 5,
        cacheRead,
        totalTokens: cacheRead + 105,
      };
      const response = createAssistantMessageEventStream();
      response.push({
        type: "start",
        partial: { ...message, content: [], usage: makeZeroUsageSnapshot() },
      });
      response.push({
        type: "toolcall_end",
        contentIndex: 0,
        toolCall,
        partial: { ...message, content: [toolCall], usage: makeZeroUsageSnapshot() },
      });
      if (completion === "result") {
        response.end(message);
      } else if (terminalStopReason === "error" || terminalStopReason === "aborted") {
        response.push({ type: "error", reason: terminalStopReason, error: message });
      } else {
        response.push({ type: "done", reason: terminalStopReason, message });
      }
      response.end();
      const providerStream = vi.fn(() => response);
      runtime.agentSession.activeSession.agent.streamFn = providerStream;
      const { installEmbeddedAttemptStreamGuards } =
        await vi.importActual<typeof import("./attempt-stream.js")>("./attempt-stream.js");
      const guards = installEmbeddedAttemptStreamGuards(fixture.input, {
        onRejectedProviderReplayRepaired: vi.fn(),
        onIdleTimeout: vi.fn(),
        diagnosticOwner: createDiagnosticEmbeddedRunOwner({
          runId: "async-fragment",
          sessionId: fixture.input.attempt.sessionId,
        }),
      });
      const modelState = createEmbeddedModelState(
        {
          session: runtime.agentSession.activeSession,
          runId: "async-fragment",
          onModelUsage: guards.onModelUsage,
        },
        { warn: vi.fn() },
      );
      const fragments: number[] = [];
      const observed = () => recordStage.mock.calls.filter(([stage]) => stage === "cache:result");
      const context = {
        systemPrompt: "stable prefix",
        messages: [],
        tools: [
          {
            name: "read",
            label: "Read",
            description: "Read",
            parameters: Type.Object({}),
            execute: async () => ({ content: [], details: {}, terminate: true }),
          },
        ],
      };
      guards.onModelRequest?.(testModel, context);
      await runAgentLoop(
        [{ role: "user", content: "Read once", timestamp: 0 }],
        context,
        { model: testModel, convertToLlm: (messages) => messages as Message[] },
        (event) => {
          if (
            event.type === "message_start" ||
            event.type === "message_update" ||
            event.type === "message_end"
          ) {
            modelState.captureModelEvent(event);
          }
          if (event.type === "message_end" && event.message.role === "assistant") {
            fragments.push(event.message.usage.cacheRead);
            if (fragments.length === 1) {
              expect(observed()).toEqual([]);
            }
          }
        },
        undefined,
        runtime.agentSession.activeSession.agent.streamFn,
      );
      expect(providerStream).toHaveBeenCalledOnce();
      expect(fragments).toEqual([0, cacheRead]);
      expect(observed()).toEqual([
        [
          "cache:result",
          {
            options: {
              requestIndex: 1,
              broke: false,
              previousCacheRead: undefined,
              input: 100,
              cacheRead,
              cacheWrite: 0,
              changes: null,
            },
          },
        ],
      ]);
      expect(runtime.contextGuards.recordCacheTouch).toHaveBeenCalledTimes(
        terminalStopReason === "error" || terminalStopReason === "aborted" ? 0 : 1,
      );
    },
  );

  it.each([
    ["active", "during summarization"],
    ["replaced", "during summarization"],
    ["closed", "during summarization"],
    ["replaced", "before installation"],
    ["closed", "before installation"],
    ["cancelled", "before installation"],
  ] as const)("fences automatic memory compaction with admission %s %s", async (owner, phase) => {
    const fixture = await createFixture({ exerciseTerminalMerges: false });
    const { admission } = fixture;
    const replacement = prepareSystemAgentRunAdmission({}, "run-1", "main", "compaction-test");
    const admittedRunContext = await admission.admit("embedded");
    const model = { ...testModel, api: "compaction-test-api", contextWindow: 4_096 };
    const settingsManager = createAutoCompactionSettings();
    applyAgentCompactionSettingsFromConfig({ settingsManager, contextTokenBudget: 4_096 });
    applyAgentAutoCompactionGuard({ settingsManager, compactionMode: "default" });
    const sessionManager = guardSessionManager(SessionManager.inMemory(), { runId: "run-1" });
    sessionManager.appendMessage({ role: "user", content: "Remember Blue Heron", timestamp: 1 });
    sessionManager.appendMessage({
      ...createAssistant(model, [{ type: "text", text: "Blue Heron is the project." }]),
      timestamp: 2,
    });
    const { session } = await createTestSession({
      model,
      sessionManager,
      settingsManager,
      contextOverflowRecoveryOwner: "caller",
    });
    session.agent.streamFn = resolveEmbeddedAgentStream({
      currentStreamFn: session.agent.streamFn,
      model,
      sessionId: session.sessionId,
      signal: fixture.input.runAbortController.signal,
    }).streamFn;
    const summaryStarted = createDeferred();
    const releaseSummary = createDeferred();
    const events: EmbeddedContextAccountingEvent[] = [];
    const ends: AgentSessionEvent[] = [];
    let summarySignalAborted: boolean | undefined;
    session.subscribe((event) => {
      if (event.type === "compaction_end") {
        ends.push(event);
        if (event.outcome.status === "completed") {
          expect(events).toHaveLength(1);
          expect(fixture.skillInstructionDeliveryCache.size).toBe(0);
        }
      }
    });
    let requests = 0;
    streamMocks.streamSimple.mockImplementation((activeModel, _context, options) => {
      if (++requests === 1) {
        return createAssistantResultStream(
          createAssistant(
            activeModel,
            [{ type: "text", text: "Blue Heron answer" }],
            "stop",
            4_090,
          ),
        );
      }
      const response = createAssistantMessageEventStream();
      summaryStarted.resolve();
      void releaseSummary.promise.then(() => {
        summarySignalAborted = options?.signal?.aborted;
        const message = createAssistant(activeModel, [
          { type: "text", text: "Blue Heron summary" },
        ]);
        response.push({ type: "done", reason: "stop", message });
        response.end();
      });
      return response;
    });
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected network request"));
    Object.assign(fixture.input.attempt, {
      admittedRunContext,
      model,
      modelId: model.id,
      provider: model.provider,
      sessionManager,
      onContextAccountingEvent: (event: EmbeddedContextAccountingEvent) => events.push(event),
    });
    Object.assign(fixture.input.prepared.sessionRuntime, {
      sessionManager,
      cacheTrace: undefined,
      anthropicPayloadLogger: undefined,
      isOpenAIResponsesApi: false,
    });
    Object.assign(fixture.input.prepared.sessionRuntime.agentSession, {
      activeSession: session,
      settingsManager,
    });
    const { installEmbeddedAttemptStreamGuards } =
      await vi.importActual<typeof import("./attempt-stream.js")>("./attempt-stream.js");
    mocks.installStreamGuards.mockImplementation(installEmbeddedAttemptStreamGuards);
    mocks.runSettledPhase.mockImplementation(async ({ preparedStreamRuntime }) => {
      await preparedStreamRuntime.promptActiveSession("Continue Blue Heron");
      return fixture.result;
    });
    const retireAdmission = async () => {
      if (owner === "replaced") {
        await replacement.admit("embedded");
      } else if (owner === "closed" || owner === "cancelled") {
        await admission.close();
        if (owner === "cancelled") {
          fixture.input.runAbortController.abort(cancelled);
        }
      }
    };
    const cancelled = new Error("caller stopped during preparation");
    let entriesBefore = structuredClone(sessionManager.getEntries());
    let messagesBefore = structuredClone(session.messages);
    if (phase === "before installation") {
      await retireAdmission();
    }
    const work = runEmbeddedAttemptExecutionPhase(fixture.input);
    const outcome = work.then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      expect(session.autoCompactionEnabled).toBe(true);
      if (phase === "during summarization") {
        await Promise.race([summaryStarted.promise, work]);
        expect(session.isCompacting).toBe(true);
        entriesBefore = structuredClone(sessionManager.getEntries());
        messagesBefore = structuredClone(session.messages);
        await retireAdmission();
      }
      releaseSummary.resolve();
      const error = await outcome;
      if (phase === "during summarization") {
        expect(summarySignalAborted).toBe(false);
      }
      const compacted = sessionManager.getEntries().filter((entry) => entry.type === "compaction");
      expect(compacted).toHaveLength(owner === "active" ? 1 : 0);
      if (phase === "before installation") {
        if (owner === "cancelled") {
          expect(error).toBe(cancelled);
        } else {
          expect(error).toMatchObject({
            message: expect.stringContaining("active admitted run"),
          });
        }
        expect(requests).toBe(0);
        expect(ends).toEqual([]);
      } else {
        expect(error).toBeUndefined();
        expect(ends).toMatchObject([
          {
            type: "compaction_end",
            reason: "threshold",
            outcome: { status: owner === "active" ? "completed" : "failed" },
          },
        ]);
      }
      expect(events).toHaveLength(owner === "active" ? 1 : 0);
      expect(fixture.skillInstructionDeliveryCache.size).toBe(owner === "active" ? 0 : 1);
      if (owner !== "active") {
        expect(sessionManager.getEntries()).toEqual(entriesBefore);
        expect(session.messages).toEqual(messagesBefore);
      }
      expect(network).not.toHaveBeenCalled();
    } finally {
      releaseSummary.resolve();
      await Promise.allSettled([work]);
      await admission.close();
      await replacement.close();
    }
  });

  it("prepares guarded history, stream handling, deadlines, and settlement in order", async () => {
    const fixture = await createFixture();

    const result = await runEmbeddedAttemptExecutionPhase(fixture.input);

    expect(result).toBe(fixture.result);
    expect(fixture.setContextReplacementHook).toHaveBeenCalledOnce();
    const replacementHook = fixture.setContextReplacementHook.mock.calls[0]?.[0];
    expect(replacementHook).toEqual(expect.any(Function));
    replacementHook?.(40, 120);
    expect(fixture.skillInstructionDeliveryCache.size).toBe(0);
    expect(fixture.order).toEqual([
      "guards",
      "stream-ready",
      "history",
      "abort",
      "set-run-abort",
      "stream",
      "set-catalog",
      "set-compaction-state",
      "timeout",
      "settled-phase",
    ]);
    expect(fixture.state).toEqual(
      expect.objectContaining({
        terminal: {
          aborted: true,
          kind: "timeout",
          phase: "compaction",
          source: "external",
        },
      }),
    );
    expect(fixture.prepStages.mark).toHaveBeenCalledWith("stream-setup");
    expect(fixture.emitPrepStageSummary).toHaveBeenCalledWith("stream-ready");
    expect(fixture.setToolSearchCatalogExecutor).toHaveBeenCalledWith(
      fixture.toolSearchCatalogExecutor,
    );

    const settledInput = mocks.runSettledPhase.mock.calls[0]?.[0];
    expect(settledInput).toEqual(
      expect.objectContaining({
        preparedStreamRuntime: expect.objectContaining({
          cache: {
            onModelRequest: expect.any(Function),
            getObservation: expect.any(Function),
          },
          history: expect.objectContaining({ contextEngineAssemblySucceeded: true }),
          isProbeSession: false,
          stream: fixture.streamResult,
          timeout: fixture.timeoutResult,
        }),
      }),
    );

    expect(fixture.runAbort).toHaveBeenCalledWith(true, expect.any(Error));

    const abortInput = mocks.createRunAbort.mock.calls[0]?.[0];
    expect(abortInput.abortActiveSession).toBe(fixture.abortActiveSession);
    const streamInput = mocks.prepareStream.mock.calls[0]?.[0];
    expect(streamInput.agentSession.activeSession).toBe(fixture.activeSession);
    expect(streamInput.agentSession.trustedLocalMediaToolNames).toEqual(new Set(["read"]));
    expect(streamInput.onModelUsage).toBe(
      mocks.installStreamGuards.mock.results[0]?.value.onModelUsage,
    );
    expect(streamInput.getRunState()).toEqual({
      aborted: true,
      promptError: null,
      timedOut: true,
      yieldDetected: true,
    });
    expect(streamInput.isReplaySafeTool(fixture.replaySafeTool)).toBe(true);
    expect(fixture.externalAbortController.setCompactionState).toHaveBeenCalledWith({
      isPendingOrRetrying: fixture.subscription.isCompacting,
      isInFlight: expect.any(Function),
    });
    expect(mocks.prepareTimeout).toHaveBeenCalledWith(
      expect.objectContaining({
        abortRun: fixture.runAbort,
        compactionState: fixture.subscription,
      }),
    );

    await settledInput.preparedStreamRuntime.promptActiveSession("hello");
    expect(fixture.activeSession.prompt).toHaveBeenCalledWith("hello", undefined);
    expect(fixture.trackPromptSettlePromise).toHaveBeenCalledOnce();
  });

  it("publishes the replacement fact and invalidates the skill cache before attempt cleanup throws", async () => {
    const fixture = await createFixture({ exerciseTerminalMerges: false });
    const events: EmbeddedContextAccountingEvent[] = [];
    Object.assign(fixture.input.attempt, {
      onContextAccountingEvent: (event: EmbeddedContextAccountingEvent) => {
        events.push(event);
      },
    });
    const cleanupError = new Error("attempt cleanup failed after compaction committed");
    let eventsBeforeCleanup: EmbeddedContextAccountingEvent[] | undefined;
    let cacheSizeBeforeCleanup: number | undefined;
    mocks.runSettledPhase.mockImplementationOnce(async () => {
      const replacementHook = fixture.setContextReplacementHook.mock.calls[0]?.[0];
      if (typeof replacementHook !== "function") {
        throw new Error("expected the attempt-owned context replacement hook");
      }
      replacementHook(40, 120);
      eventsBeforeCleanup = [...events];
      cacheSizeBeforeCleanup = fixture.skillInstructionDeliveryCache.size;
      throw cleanupError;
    });

    await expect(runEmbeddedAttemptExecutionPhase(fixture.input)).rejects.toBe(cleanupError);

    expect(eventsBeforeCleanup).toEqual([{ kind: "compaction", tokensAfter: 40 }]);
    expect(cacheSizeBeforeCleanup).toBe(0);
  });

  it("does not start a prompt after external cancellation", async () => {
    const fixture = await createFixture();
    await runEmbeddedAttemptExecutionPhase(fixture.input);
    const reason = new Error("run cancelled");
    const abortError = new Error("run cancelled", { cause: reason });
    abortError.name = "AbortError";
    fixture.input.runAbortController.abort(reason);
    mocks.abortable.mockImplementationOnce((_signal, _promise) => Promise.reject(abortError));
    const settledInput = mocks.runSettledPhase.mock.calls[0]?.[0];

    await expect(
      settledInput.preparedStreamRuntime.promptActiveSession("must not start"),
    ).rejects.toThrow("run cancelled");

    expect(fixture.activeSession.prompt).not.toHaveBeenCalled();
  });

  it("closes the real execution deadline when the provider idle owner aborts locally", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fixture = await createFixture({ exerciseTerminalMerges: false });
    fixture.input.attempt.timeoutMs = 100;
    const onAttemptDeadlineChanged = vi.fn();
    fixture.input.attempt.onAttemptDeadlineChanged = onAttemptDeadlineChanged;
    const idleError = new Error("provider idle timeout");
    fixture.runAbort.mockImplementation(() => fixture.input.runAbortController.abort(idleError));
    const { prepareEmbeddedAttemptTimeout } = await vi.importActual<
      typeof import("./attempt-timeout-prepare.js")
    >("./attempt-timeout-prepare.js");
    mocks.prepareTimeout.mockImplementationOnce(prepareEmbeddedAttemptTimeout);
    mocks.runSettledPhase.mockImplementationOnce(async (settledInput) => {
      try {
        expect(onAttemptDeadlineChanged.mock.calls).toEqual([
          [{ kind: "bounded", deadlineAtMs: 100 }],
        ]);
        mocks.installStreamGuards.mock.calls[0]?.[1].onIdleTimeout(idleError);
        await vi.advanceTimersByTimeAsync(200);

        expect(fixture.runAbort).toHaveBeenCalledExactlyOnceWith(true, idleError);
        expect(fixture.state.terminal).toEqual({
          kind: "timeout",
          phase: "prompt",
          source: "idle",
        });
        expect(onAttemptDeadlineChanged).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
        return fixture.result;
      } finally {
        settledInput.preparedStreamRuntime.timeout.clearTimers();
      }
    });
    try {
      await expect(runEmbeddedAttemptExecutionPhase(fixture.input)).resolves.toBe(fixture.result);
    } finally {
      vi.useRealTimers();
    }
  });

  it("attributes an idle timeout during authoritative compaction to compaction", async () => {
    const fixture = await createFixture({ exerciseTerminalMerges: false });
    fixture.activeSession.isCompacting = true;
    await runEmbeddedAttemptExecutionPhase(fixture.input);
    const idleError = new Error("idle timeout");
    const guardCallbacks = mocks.installStreamGuards.mock.calls[0]?.[1];

    guardCallbacks.onIdleTimeout(idleError);

    expect(fixture.state.terminal).toEqual({
      kind: "timeout",
      phase: "compaction",
      source: "idle",
    });
    expect(fixture.runAbort).toHaveBeenCalledWith(true, idleError);
  });

  it.each(["flushed", "rejected"] as const)(
    "disposes after a %s tool-result flush when history preparation fails",
    async (outcome) => {
      const fixture = await createFixture({ aborted: true });
      const failure = new Error("history failed");
      const flush = createDeferred();
      mocks.prepareHistory.mockRejectedValueOnce(failure);
      mocks.flushPendingToolResultsAfterIdle.mockReturnValueOnce(flush.promise);

      const execution = expect(runEmbeddedAttemptExecutionPhase(fixture.input)).rejects.toBe(
        failure,
      );
      await vi.waitFor(() => expect(mocks.flushPendingToolResultsAfterIdle).toHaveBeenCalledOnce());
      expect(fixture.activeSession.dispose).not.toHaveBeenCalled();
      if (outcome === "rejected") {
        flush.reject(new Error("transcript writer retired"));
      } else {
        flush.resolve();
      }
      await execution;

      expect(mocks.flushPendingToolResultsAfterIdle).toHaveBeenCalledWith({
        agent: fixture.activeSession.agent,
        sessionManager: fixture.sessionManager,
        timeoutMs: 0,
        abortSignal: fixture.input.attempt.abortSignal,
      });
      expect(fixture.activeSession.dispose).toHaveBeenCalledOnce();
    },
  );
});
