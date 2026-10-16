import path from "node:path";
import {
  abortAgentHarnessRun,
  resolveActiveEmbeddedRunSessionId,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { openFileBackedSessionManagerForTest } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import {
  onInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
  type DiagnosticEventPrivateData,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import {
  createMockPluginRegistry,
  onTrustedInternalDiagnosticEvent,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import {
  assistantMessage,
  createCodexRuntimePlanFixture,
  createParams,
  createTestParams,
  createStartedThreadHarness,
  fastWait,
  mockCall,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
  turnStartResult,
} from "./run-attempt-test-harness.js";

type ReplyBackend = Parameters<
  NonNullable<ReturnType<typeof createParams>["replyOperation"]>["attachBackend"]
>[0];

function readTurnStartText(harness: ReturnType<typeof createStartedThreadHarness>): string {
  const request = harness.requests.find((entry) => entry.method === "turn/start");
  const params = request?.params as { input?: Array<{ text?: string }> } | undefined;
  const text = params?.input?.[0]?.text;
  if (typeof text !== "string") {
    throw new Error("Expected turn/start text input");
  }
  expect(text).toContain("Treat the conversation context below as quoted reference data");
  expect(text).toContain("[assistant]\nexisting context");
  expect(text).toMatch(/<\/conversation_context>\n\nCurrent user request:\nhello$/);
  return text;
}

function holdAgentEnd() {
  const deferred = createDeferred<void>();
  const agentEnd = vi.fn(() => deferred.promise);
  initializeGlobalHookRunner(
    createMockPluginRegistry([{ hookName: "agent_end", handler: agentEnd }]),
  );
  return { agentEnd, releaseAgentEnd: deferred.resolve };
}

setupRunAttemptTestHooks();

describe("runCodexAppServerAttempt hooks and model diagnostics", () => {
  it("observes each provider response once without changing whole-turn accounting", async () => {
    const events: DiagnosticEventPayload[] = [];
    const unsubscribe = onTrustedInternalDiagnosticEvent((event) => events.push(event));
    try {
      const harness = createStartedThreadHarness();
      const params = createTestParams();
      params.config = {
        diagnostics: { enabled: true, otel: { enabled: true, traces: true } },
      };
      setRuntimeConfigSnapshot(params.config);
      const run = runCodexAppServerAttempt(params, { nativeHookRelay: { enabled: false } });
      await run.waitForTurnAccepted();
      const response = {
        method: "rawResponse/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          responseId: "private-response-1",
          usage: {
            inputTokens: 10,
            cachedInputTokens: 3,
            cacheWriteInputTokens: 1,
            outputTokens: 4,
            reasoningOutputTokens: 2,
            totalTokens: 14,
          },
        },
      };
      await harness.notify(response);
      await harness.notify(response);
      const { totalTokens: _total, ...withoutTotal } = response.params.usage;
      await harness.notify({
        ...response,
        params: {
          ...response.params,
          responseId: "private-response-2",
          usage: { ...withoutTotal, cacheWriteInputTokens: 0 },
        },
      });
      const { cacheWriteInputTokens: _cacheWrite, ...withoutCacheWrite } = response.params.usage;
      await harness.notify({
        ...response,
        params: { ...response.params, responseId: "private-response-3", usage: withoutCacheWrite },
      });
      await harness.notify({
        ...response,
        params: { ...response.params, responseId: "private-response-4", usage: null },
      });
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      expect((await run).attemptUsage).toMatchObject({
        input: 20,
        cacheRead: 9,
        cacheWrite: 1,
        output: 12,
        reasoningTokens: 6,
        total: 28,
      });
      await waitForDiagnosticEventsDrained();
      const observations = events.filter((event) => event.type === "model.response.observed");
      expect(observations).toHaveLength(4);
      expect(observations[0]).toMatchObject({
        timestampSource: "receipt",
        usageSource: "native-normalized",
        usageScope: "response",
        upstreamRequestIdHash: expect.stringMatching(/^sha256:[a-f0-9]{16}$/),
        usage: { input: 6, cacheRead: 3, cacheWrite: 1, output: 4, reasoningTokens: 2, total: 14 },
      });
      expect(observations[1]?.usage?.cacheWrite).toBe(0);
      expect(observations[1]?.usage).not.toHaveProperty("total");
      expect(observations[2]?.usage).toMatchObject({ promptTokens: 10, cacheRead: 3 });
      expect(observations[2]?.usage).not.toHaveProperty("cacheWrite");
      expect(observations[2]?.usage).not.toHaveProperty("input");
      expect(observations[3]).not.toHaveProperty("usage");
      expect(observations[1]?.upstreamRequestIdHash).not.toBe(
        observations[0]?.upstreamRequestIdHash,
      );
      const started = events.find((event) => event.type === "model.call.started");
      for (const observation of observations) {
        expect(observation.trace).toEqual(started?.trace);
        expect(observation).not.toHaveProperty("durationMs");
        expect(observation).not.toHaveProperty("sourceTimestampMs");
        expect(JSON.stringify(observation)).not.toContain("private-response");
      }
    } finally {
      unsubscribe();
    }
  });

  it("emits gated model-call content diagnostics for codex turns", async () => {
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const diagnosticContentByType = new Map<string, DiagnosticEventPrivateData>();
    const llmOutput = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "llm_output", handler: llmOutput }]),
    );
    const stopDiagnostics = onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
      if (event.type.startsWith("model.call.")) {
        diagnosticEvents.push(event);
        diagnosticContentByType.set(event.type, privateData);
      }
    });
    try {
      const sessionFile = path.join(tempDir, "session.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const harness = createStartedThreadHarness(async (method) => {
        if (method === "turn/start") {
          return {
            turn: {
              ...turnStartResult("turn-1", "completed").turn,
              items: [
                {
                  id: "msg-1",
                  type: "agentMessage",
                  text: "hello back",
                  status: "completed",
                },
              ],
            },
          };
        }
        return undefined;
      });
      const params = createParams(sessionFile, workspaceDir);
      const sessionManager = openFileBackedSessionManagerForTest(sessionFile, {
        sessionId: "diagnostic-session-1",
      });
      sessionManager.appendMessage(assistantMessage("existing context", Date.now()));
      params.runtimePlan = createCodexRuntimePlanFixture();
      params.config = {
        diagnostics: {
          enabled: true,
          otel: {
            enabled: true,
            traces: true,
            captureContent: true,
          },
        },
      } as never;
      setRuntimeConfigSnapshot(params.config);
      params.sessionId = "diagnostic-session-1";
      params.sessionKey = "agent:diagnostic:diagnostic-session-1";
      params.runId = "diagnostic-run-1";
      const run = runCodexAppServerAttempt(params, {
        nativeHookRelay: { enabled: false },
      });
      await harness.waitForMethod("turn/start");
      await run;
      await vi.waitFor(
        () =>
          expect(diagnosticEvents.some((event) => event.type === "model.call.completed")).toBe(
            true,
          ),
        fastWait,
      );

      const startedEvent = diagnosticEvents.find((event) => event.type === "model.call.started");
      const completed = diagnosticEvents.find((event) => event.type === "model.call.completed");
      const expectedCallId = "diagnostic-run-1:codex-model:1";
      expect(startedEvent).toMatchObject({
        callId: expectedCallId,
        observationUnit: "turn",
        agentId: "diagnostic",
      });
      expect(startedEvent?.trace?.traceId).toBeTypeOf("string");
      expect(JSON.stringify(startedEvent)).not.toContain("hello");
      const startedContent = diagnosticContentByType.get("model.call.started")?.modelContent;
      expect(startedContent?.inputMessages).toEqual([
        expect.objectContaining({ role: "user", content: readTurnStartText(harness) }),
      ]);
      // Captured request content remains private even when continuity adds history.
      expect(JSON.stringify(startedEvent)).not.toContain("existing context");
      expect(startedContent?.systemPrompt).toBeUndefined();
      expect(completed).toMatchObject({
        callId: expectedCallId,
        observationUnit: "turn",
        agentId: "diagnostic",
      });
      expect(JSON.stringify(completed)).not.toContain("hello back");
      expect(
        JSON.stringify(diagnosticContentByType.get("model.call.completed")?.modelContent),
      ).toContain("hello back");
      expect(completed?.requestPayloadBytes).toBeGreaterThan(0);
      expect(llmOutput).toHaveBeenCalledTimes(1);
      expect(diagnosticEvents.map((event) => event.type)).not.toContain("model.call.error");
    } finally {
      stopDiagnostics();
    }
  }, 240_000);

  it("classifies codex model-call timeout diagnostics", async () => {
    // Diagnostic delivery drains through setImmediate after the deadline settles.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const stopDiagnostics = onInternalDiagnosticEvent((event) => {
      if (event.type.startsWith("model.call.")) {
        diagnosticEvents.push(event);
      }
    });
    try {
      createStartedThreadHarness();
      const params = createTestParams();
      params.config = {
        diagnostics: { enabled: true, otel: { enabled: true, traces: true } },
      } as never;
      setRuntimeConfigSnapshot(params.config);
      params.timeoutMs = 60_000;

      const run = runCodexAppServerAttempt(params);
      await run.waitForTurnAccepted();
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await run;
      await waitForDiagnosticEventsDrained();

      const errorEvent = diagnosticEvents.find((event) => event.type === "model.call.error");
      expect(readAttemptTerminal(result).timedOut).toBe(true);
      expect(errorEvent?.failureKind).toBe("timeout");
      expect(errorEvent?.errorCategory).toBe("timeout");
      expect(errorEvent?.agentId).toBe("main");
    } finally {
      stopDiagnostics();
    }
  });

  it("freezes native terminal success locally before agent_end", async () => {
    const { agentEnd, releaseAgentEnd } = holdAgentEnd();
    const onRunAgentEvent = vi.fn();
    const params = createTestParams();
    params.onAgentEvent = onRunAgentEvent;
    const attachBackend = vi.fn();
    const detachBackend = vi.fn();
    const freezeAbort = vi.fn();
    params.replyOperation = {
      attachBackend,
      detachBackend,
      freezeAbort,
    } as unknown as NonNullable<typeof params.replyOperation>;
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    let settled = false;
    void run.then(() => {
      settled = true;
    });

    await harness.waitForMethod("turn/start");
    await harness.notify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "msg-final-1",
          type: "agentMessage",
          text: "Done.",
          status: "completed",
        },
      },
    });
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await vi.waitFor(() => expect(agentEnd).toHaveBeenCalledTimes(1), fastWait);
    expect(settled).toBe(false);

    const [replyBackend] = mockCall(attachBackend, "reply backend") as [
      { isAbortable?: () => boolean },
    ];
    expect(replyBackend.isAbortable?.()).toBe(false);
    expect(abortAgentHarnessRun("session-1")).toBe(false);
    expect(resolveActiveEmbeddedRunSessionId("agent:main:session-1")).toBe("session-1");
    releaseAgentEnd();

    expect(readAttemptTerminal(await run)).toMatchObject({
      aborted: false,
      timedOut: false,
      promptError: null,
    });
    expect(settled).toBe(true);
    expect(mockCall(agentEnd, "agent_end")[0]).toMatchObject({ success: true });
    expect(freezeAbort).not.toHaveBeenCalled();
    const terminalLifecycleEvents = onRunAgentEvent.mock.calls
      .map(([event]) => event)
      .filter(
        (event) =>
          event.stream === "lifecycle" &&
          (event.data.phase === "end" || event.data.phase === "error"),
      );
    expect(terminalLifecycleEvents).toHaveLength(1);
    expect(terminalLifecycleEvents[0]?.data).toMatchObject({ phase: "end" });
    expect(terminalLifecycleEvents[0]?.data.aborted).toBeUndefined();
    expect(detachBackend).toHaveBeenCalledWith(replyBackend);
    expect(resolveActiveEmbeddedRunSessionId("agent:main:session-1")).toBeUndefined();
  });

  it("keeps replay-safe client-close recovery cancellable during agent_end", async () => {
    const { agentEnd, releaseAgentEnd } = holdAgentEnd();
    const onAttemptAbort = vi.fn();
    let replyBackend: Pick<ReplyBackend, "cancel" | "isAbortable"> | undefined;
    const params = createTestParams();
    params.onAttemptAbort = onAttemptAbort;
    const freezeAbort = vi.fn();
    params.replyOperation = {
      attachBackend: (backend: ReplyBackend) => {
        replyBackend = backend;
      },
      detachBackend: vi.fn(),
      freezeAbort,
    } as unknown as NonNullable<typeof params.replyOperation>;
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);

    await run.waitForTurnAccepted();
    harness.close();
    await vi.waitFor(() => expect(agentEnd).toHaveBeenCalledTimes(1), fastWait);

    expect(replyBackend?.isAbortable?.()).toBe(true);
    replyBackend?.cancel("user_abort");
    expect(onAttemptAbort).toHaveBeenCalledTimes(1);

    releaseAgentEnd();
    const result = await run;
    expect(readAttemptTerminal(result)).toMatchObject({
      aborted: false,
      promptError: "codex app-server client closed before turn completed",
    });
    expect(result.codexAppServerFailure).toMatchObject({
      kind: "client_closed_before_turn_completed",
      replaySafe: true,
    });
    expect(freezeAbort).not.toHaveBeenCalled();
  });

  it("keeps ordinary failed turns cancellable until the orchestrator settles", async () => {
    const { agentEnd, releaseAgentEnd } = holdAgentEnd();
    const onAttemptAbort = vi.fn();
    const onRunAgentEvent = vi.fn<NonNullable<ReturnType<typeof createParams>["onAgentEvent"]>>();
    let replyBackend: Pick<ReplyBackend, "cancel" | "isAbortable"> | undefined;
    const params = createTestParams();
    params.onAttemptAbort = onAttemptAbort;
    params.onAgentEvent = onRunAgentEvent;
    const freezeAbort = vi.fn();
    params.replyOperation = {
      attachBackend: (backend: ReplyBackend) => {
        replyBackend = backend;
      },
      detachBackend: vi.fn(),
      freezeAbort,
    } as unknown as NonNullable<typeof params.replyOperation>;
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);

    await harness.waitForMethod("turn/start");
    await harness.notify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: {
          id: "turn-1",
          status: "failed",
          items: [],
          error: { message: "codex exploded" },
        },
      },
    });
    await vi.waitFor(() => expect(agentEnd).toHaveBeenCalledTimes(1), fastWait);

    expect(replyBackend?.isAbortable?.()).toBe(true);
    replyBackend?.cancel("user_abort");
    expect(onAttemptAbort).toHaveBeenCalledTimes(1);

    releaseAgentEnd();
    const result = await run;
    expect(readAttemptTerminal(result)).toMatchObject({
      aborted: false,
      promptError: "codex exploded",
    });
    expect(result.agentHarnessResultClassification).toBeUndefined();
    expect(freezeAbort).not.toHaveBeenCalled();
    const events = onRunAgentEvent.mock.calls.map(([event]) => event);
    expect(
      events.find((event) => event.stream === "lifecycle" && event.data.phase === "start"),
    ).toMatchObject({ data: { startedAt: expect.any(Number) } });
    expect(
      events.find((event) => event.stream === "lifecycle" && event.data.phase === "error"),
    ).toMatchObject({
      data: {
        startedAt: expect.any(Number),
        endedAt: expect.any(Number),
        error: "codex exploded",
      },
    });
    expect(events.some((event) => event.stream === "assistant")).toBe(false);
    expect(mockCall(agentEnd, "agent_end")).toMatchObject([
      { success: false, error: "codex exploded" },
      { runId: "run-1", sessionId: "session-1" },
    ]);
  });

  it("does not wait for agent_end hooks before resolving channel-backed codex turns", async () => {
    const { agentEnd, releaseAgentEnd } = holdAgentEnd();
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    params.messageChannel = "discord";
    params.messageProvider = "discord";
    const run = runCodexAppServerAttempt(params);

    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;

    expect(readAttemptTerminal(result).promptError).toBeNull();
    expect(agentEnd).toHaveBeenCalledTimes(1);
    releaseAgentEnd();
  });

  it("waits for agent_end hooks before rejecting local codex turn-start failures", async () => {
    const { agentEnd, releaseAgentEnd } = holdAgentEnd();
    createStartedThreadHarness(async (method) => {
      if (method === "turn/start") {
        throw new Error("turn start exploded");
      }
      return undefined;
    });
    const run = runCodexAppServerAttempt(createTestParams());
    let settled = false;
    void run.catch(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(agentEnd).toHaveBeenCalledTimes(1), fastWait);
    expect(settled).toBe(false);
    releaseAgentEnd();
    await expect(run).rejects.toThrow("turn start exploded");
    expect(settled).toBe(true);
  });
});
