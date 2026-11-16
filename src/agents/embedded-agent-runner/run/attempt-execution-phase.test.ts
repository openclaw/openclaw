import { randomUUID } from "node:crypto";
import path from "node:path";
import { createAssistantMessageEventStream, type Message } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimResponsesCompactRequest } from "../../../../packages/ai/src/transports/openai-responses-compact-request.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import {
  loadTranscriptEventsSync,
  replaceSessionEntrySync,
} from "../../../config/sessions/session-accessor.js";
import { fetchWithSsrFGuard } from "../../../infra/net/fetch-guard.js";
import { captureGuardedFetchRequestAuthority } from "../../../infra/net/fetch-request-authority.js";
import { createDiagnosticEmbeddedRunOwner } from "../../../logging/diagnostic-run-activity.js";
import { convertToLlm, runAgentLoop } from "../../../plugin-sdk/agent-core.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
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
import { withSessionManagerWrite } from "../../sessions/session-manager-write-admission.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { SettingsManager } from "../../sessions/settings-manager.js";
import { makeZeroUsageSnapshot } from "../../usage.js";
import { resolveEmbeddedAgentStream } from "../stream-resolution.js";

// Register the shared module mocks before importing any runtime dependency.
const { createFixture, mocks } = await vi.hoisted(
  async () => await import("./attempt-execution-phase.test-support.js"),
);

import { runEmbeddedAttemptExecutionPhase } from "./attempt-execution-phase.js";
import { prepareEmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle-prepare.js";
import { createChatGPTV2CompactionBoundary } from "./chatgpt-v2-compaction.js";
import type { EmbeddedContextAccountingEvent } from "./internal-params.js";
import { streamWithIdleTimeout } from "./llm-idle-timeout.js";
import { MidTurnPrecheckSignal } from "./midturn-precheck.js";
import { claimAgentSessionWriter } from "./session-bootstrap.js";

registerAgentSessionLoopTestLifecycle();
afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
  vi.clearAllMocks();
});

async function createOwnedTranscript(
  testState: OpenClawTestState,
  sessionKey: string,
  entry: { sessionId: string; lifecycleRevision?: string },
) {
  setRuntimeConfigSnapshot({});
  const fixture = await createFixture({ exerciseTerminalMerges: false });
  const target = {
    agentId: "main",
    sessionKey,
    sessionId: entry.sessionId,
    storePath: path.join(testState.agentDir(), "openclaw-agent.sqlite"),
  };
  const original = { ...entry, updatedAt: 1 };
  replaceSessionEntrySync(target, original);
  Object.assign(fixture.input.attempt, {
    ...target,
    sessionTarget: target,
    sessionFile: sessionKey,
  });
  const writer = await claimAgentSessionWriter({
    ...target,
    sessionTarget: target,
    runId: fixture.input.attempt.runId,
    workspaceDir: testState.workspaceDir,
    prompt: "reply",
    timeoutMs: 30_000,
  });
  const selected = {
    ...target,
    expectedLifecycleRevision: writer?.expectedLifecycleRevision,
    expectedWriterRunId: writer?.expectedWriterRunId,
  };
  fixture.input.attempt.sessionTarget = selected;
  const transcript = await prepareEmbeddedAttemptTranscriptLifecycle({
    attempt: fixture.input.attempt,
    externalAbortController: { arm: () => {}, throwIfFiredAfterPrepCleanup: async () => {} },
  });
  fixture.input.sessionLock = transcript;
  return { fixture, target, original, selected, transcript };
}

describe("runEmbeddedAttemptExecutionPhase", () => {
  it.each([
    ["cron", "current"],
    ["cron", "rotated"],
    ["cron", "reset"],
    ["dashboard", "current"],
  ] as const)(
    "scopes the provider generation guard after writer admission (%s, %s)",
    async (kind, change) => {
      await withOpenClawTestState({ label: "cron-root-provider-fence" }, async (testState) => {
        const { fixture, target, original, selected, transcript } = await createOwnedTranscript(
          testState,
          `agent:main:${kind}:provider-fence`,
          { sessionId: "cron-run-1", lifecycleRevision: "generation-1" },
        );
        const manager = SessionManager.open(selected);
        const fetchImpl = vi.fn(async () => new Response("ok"));
        fixture.activeSession.prompt.mockImplementation(async () => {
          const requestAuthority = captureGuardedFetchRequestAuthority();
          if (kind === "cron") {
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

  it("keeps history metadata and subsequent messages in the resident transcript actor", async () => {
    await withOpenClawTestState({ label: "history-metadata-owner" }, async (testState) => {
      const { fixture, selected, transcript } = await createOwnedTranscript(
        testState,
        "agent:main:history-metadata-owner",
        { sessionId: "history-metadata-owner" },
      );
      try {
        const manager = await transcript.withOwnedTranscriptWrite(() =>
          SessionManager.openAsync(selected, testState.workspaceDir),
        );
        fixture.input.prepared.sessionRuntime.sessionManager = manager;
        const actor = transcript.ownedTranscriptWriteContext.sessionActor?.actor;
        if (!actor) {
          throw new Error("Expected the attempt's durable transcript actor");
        }
        const authority = {
          assertCurrent: () => actor.assertCurrent(),
          authorize: () => actor.assertCurrent(),
        };
        const before = await actor.read(authority);
        const snapshot = { provider: "test", modelId: "test-model", timestamp: 1 };
        let metadataId: string | undefined;
        mocks.prepareHistory.mockImplementation(async () => {
          metadataId = await manager.appendCustomEntryAsync("model-snapshot", snapshot);
          return { contextEnginePromptAuthority: "assembled" };
        });
        mocks.runSettledPhase.mockResolvedValue(fixture.result);

        await runEmbeddedAttemptExecutionPhase(fixture.input);

        const after = actor.snapshot(authority);
        expect(after).toMatchObject({
          version: { epoch: before.version.epoch },
          transcript: { watermark: { maxSeq: 1 } },
        });
        const message = { role: "user" as const, content: "after history", timestamp: 2 };
        const messageId = await transcript.withOwnedTranscriptWrite(() =>
          manager.appendMessageAsync(message),
        );
        const reopened = await transcript.withOwnedTranscriptWrite(() =>
          SessionManager.openAsync(selected, testState.workspaceDir),
        );
        expect(reopened.getEntries()).toMatchObject([
          {
            id: metadataId,
            parentId: null,
            type: "custom",
            customType: "model-snapshot",
            data: snapshot,
          },
          { id: messageId, parentId: metadataId, type: "message", message },
        ]);
      } finally {
        await transcript.transcriptLifecycle.dispose();
      }
    });
  });

  it.each(["stop", "toolUse", "aborted", "output-limit"] as const)(
    "observes terminal %s usage once across async-tool fragments",
    async (stopReason) => {
      const terminalStopReason = stopReason === "output-limit" ? "error" : stopReason;
      const cacheRead = 10_000;
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
      if (terminalStopReason === "error" || terminalStopReason === "aborted") {
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
      await guards.onModelRequest?.(testModel, context);
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
      expect(fragments).toEqual([0, cacheRead]);
      expect(observed()).toHaveLength(1);
      expect(observed()[0]?.[1]).toMatchObject({ options: { input: 100, cacheRead } });
      expect(runtime.contextGuards.recordCacheTouch).toHaveBeenCalledTimes(
        terminalStopReason === "error" || terminalStopReason === "aborted" ? 0 : 1,
      );
    },
  );

  it.each(["replaced", "closed", "cancelled"] as const)(
    "rejects %s admission before installing memory compaction",
    async (owner) => {
      const fixture = await createFixture({ exerciseTerminalMerges: false });
      const replacement = prepareSystemAgentRunAdmission({}, "run-1", "main", "compaction-test");
      const cancelled = new Error("caller stopped during preparation");
      try {
        if (owner === "replaced") {
          await replacement.admit("embedded");
        } else {
          fixture.admission.close();
          if (owner === "cancelled") {
            fixture.input.runAbortController.abort(cancelled);
          }
        }
        const work = expect(runEmbeddedAttemptExecutionPhase(fixture.input)).rejects;
        if (owner === "cancelled") {
          await work.toBe(cancelled);
        } else {
          await work.toThrow("active admitted run");
        }
        expect(fixture.setContextReplacementHook).not.toHaveBeenCalled();
        expect(mocks.installStreamGuards).not.toHaveBeenCalled();
      } finally {
        replacement.close();
      }
    },
  );

  it.each(["active", "replaced", "closed"] as const)(
    "fences automatic memory compaction with %s admission during summarization",
    async (owner) => {
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
        ...createAssistant(model, "Blue Heron is the project."),
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
            createAssistant(activeModel, "Blue Heron answer", "stop", 4_090),
          );
        }
        const response = createAssistantMessageEventStream();
        summaryStarted.resolve();
        void releaseSummary.promise.then(() => {
          summarySignalAborted = options?.signal?.aborted;
          const message = createAssistant(activeModel, "Blue Heron summary");
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
        } else if (owner === "closed") {
          admission.close();
        }
      };
      const work = runEmbeddedAttemptExecutionPhase(fixture.input);
      const outcome = work.then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        expect(session.autoCompactionEnabled).toBe(true);
        await Promise.race([summaryStarted.promise, work]);
        expect(session.isCompacting).toBe(true);
        const entriesBefore = structuredClone(sessionManager.getEntries());
        const messagesBefore = structuredClone(session.messages);
        await retireAdmission();
        releaseSummary.resolve();
        expect(await outcome).toBeUndefined();
        expect(summarySignalAborted).toBe(false);
        const compacted = sessionManager
          .getEntries()
          .filter((entry) => entry.type === "compaction");
        expect(compacted).toHaveLength(owner === "active" ? 1 : 0);
        expect(ends).toMatchObject([
          {
            type: "compaction_end",
            reason: "threshold",
            outcome: { status: owner === "active" ? "completed" : "failed" },
          },
        ]);
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
        admission.close();
        replacement.close();
      }
    },
  );

  it("publishes the replacement fact and invalidates the skill cache before attempt cleanup throws", async () => {
    const fixture = await createFixture({ exerciseTerminalMerges: false });
    const events: EmbeddedContextAccountingEvent[] = [];
    fixture.input.attempt.onContextAccountingEvent = (event) => events.push(event);
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

  it("preserves session watchdog attribution through model-call recovery", async () => {
    const fixture = await createFixture({ exerciseTerminalMerges: false });
    mocks.installStreamGuards.mockImplementationOnce(() => ({
      onModelRequest: vi.fn(),
      onModelUsage: vi.fn(),
      getPromptCacheObservation: vi.fn(),
      isModelCallActive: () => true,
    }));
    fixture.runAbort.mockImplementation((_timeout, reason) =>
      fixture.input.runAbortController.abort(reason),
    );
    await runEmbeddedAttemptExecutionPhase(fixture.input);

    const streamInput = mocks.prepareStream.mock.calls[0]?.[0];
    expect(streamInput.recoverStalledModelCall()).toBe(true);
    expect(fixture.input.runAbortController.signal.aborted).toBe(true);
    expect(fixture.input.runAbortController.signal.reason).toMatchObject({
      code: "OPENCLAW_SESSION_WATCHDOG",
    });
    expect(fixture.state.terminal).toMatchObject({ kind: "timeout", source: "idle" });
  });

  it("lets the compaction owner fall back after a request-local idle timeout", async () => {
    const fixture = await createFixture({ exerciseTerminalMerges: false });
    const model = {
      ...testModel,
      api: "openai-chatgpt-responses" as const,
      provider: "openai",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      contextWindow: 32_000,
    };
    const manager = SessionManager.inMemory();
    manager.appendMessage({
      role: "user",
      content: "synthetic history ".repeat(2_000),
      timestamp: 1,
    });
    const { session } = await createTestSession({
      model,
      sessionManager: manager,
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: true, reserveTokens: 2_000 },
      }),
    });
    Object.defineProperty(fixture.activeSession, "isCompacting", {
      get: () => session.isCompacting,
    });
    fixture.runAbort.mockImplementation((_timeout, error) =>
      fixture.input.runAbortController.abort(error),
    );
    await runEmbeddedAttemptExecutionPhase(fixture.input);
    const onIdleTimeout = mocks.installStreamGuards.mock.calls[0]?.[1].onIdleTimeout;
    const started = createDeferred();
    let requestSignal: AbortSignal | undefined;
    const streamFn = streamWithIdleTimeout(
      (_model, _context, options) => {
        const stream = createAssistantMessageEventStream();
        const request = claimResponsesCompactRequest(options);
        if (!request || !options?.signal) {
          throw new Error("expected a prepared compaction request");
        }
        requestSignal = options.signal;
        options.signal.addEventListener(
          "abort",
          () => {
            request.reject(options.signal?.reason);
            const message = createAssistant(model, [], "aborted");
            stream.push({ type: "error", reason: "aborted", error: message });
            stream.end();
          },
          { once: true },
        );
        started.resolve();
        return stream;
      },
      25,
      onIdleTimeout,
    );
    const onFallback = vi.fn();
    const boundary = createChatGPTV2CompactionBoundary({
      session,
      contextTokenBudget: 8_000,
      reserveTokens: 2_000,
      timeoutMs: 1_000,
      assertActive: () => fixture.input.runAbortController.signal.throwIfAborted(),
      withTranscriptWrite: (write) => withSessionManagerWrite(manager, write),
      onFallback,
    });
    vi.useFakeTimers();
    try {
      const result = boundary(
        streamFn,
        model,
        { messages: convertToLlm(session.messages) },
        {
          signal: fixture.input.runAbortController.signal,
        },
      );
      const failure = result.then(
        () => undefined,
        (error: unknown) => error,
      );
      await started.promise;
      await vi.advanceTimersByTimeAsync(25);
      expect(await failure).toBeInstanceOf(MidTurnPrecheckSignal);
      expect(requestSignal?.aborted).toBe(true);
      expect(fixture.input.runAbortController.signal.aborted).toBe(false);
      expect(fixture.runAbort).not.toHaveBeenCalled();
      expect(fixture.state.terminal).toEqual({ kind: "ok" });
      expect(onFallback).toHaveBeenCalledOnce();
      expect(session.isCompacting).toBe(false);
      expect(manager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
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

      expect(fixture.activeSession.dispose).toHaveBeenCalledOnce();
    },
  );
});
