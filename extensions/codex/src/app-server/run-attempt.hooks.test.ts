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
  withAdmittedSessionTurnForTest,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import type { CodexAppServerClient } from "./client.js";
import { itemNotification, turnCompleted } from "./protocol.test-helpers.js";
import {
  assistantMessage,
  createCodexRuntimePlanFixture,
  createParams,
  createTestParams,
  createStartedThreadHarness,
  fastWait,
  mockCall,
  queueActiveRunMessageForTest,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  turnStartResult,
} from "./run-attempt-test-harness.js";

type ReplyBackend = Parameters<
  Parameters<Parameters<typeof withAdmittedSessionTurnForTest>[1]>[0]["attachBackend"]
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

// Runs the attempt inside its real controller turn, as a Gateway run would, and
// observes how Codex uses that operation. The turn completes after the attempt.
async function runWithObservedReplyTurn(params: ReturnType<typeof createParams>) {
  const started = createDeferred<{
    run: ReturnType<typeof runCodexAppServerAttempt>;
    attachBackend: ReturnType<typeof vi.fn>;
    detachBackend: ReturnType<typeof vi.fn>;
    freezeAbort: ReturnType<typeof vi.fn>;
  }>();
  const turnSettled = withAdmittedSessionTurnForTest(
    { sessionKey: params.sessionKey!, sessionId: params.sessionId },
    async (operation) => {
      const observed = {
        attachBackend: vi.spyOn(operation, "attachBackend"),
        detachBackend: vi.spyOn(operation, "detachBackend"),
        freezeAbort: vi.spyOn(operation, "freezeAbort"),
        run: runCodexAppServerAttempt(params),
      };
      started.resolve(observed);
      await observed.run.catch(() => undefined);
    },
  );
  void turnSettled.catch(started.reject);
  const observed = await started.promise;
  return {
    ...observed,
    turnSettled,
    replyBackend: () =>
      observed.attachBackend.mock.calls.at(-1)?.[0] as
        | Pick<ReplyBackend, "cancel" | "isAbortable">
        | undefined,
  };
}

function holdAgentEnd() {
  const deferred = createDeferred<void>();
  const agentEnd = vi.fn(() => deferred.promise);
  initializeGlobalHookRunner(
    createMockPluginRegistry([{ hookName: "agent_end", handler: agentEnd }]),
  );
  return { agentEnd, releaseAgentEnd: deferred.resolve };
}

function diagnosticParams(captureContent = false) {
  const params = createTestParams();
  params.config = {
    diagnostics: { enabled: true, otel: { enabled: true, traces: true, captureContent } },
  };
  setRuntimeConfigSnapshot(params.config);
  return params;
}

async function heldAttempt(overrides: Partial<ReturnType<typeof createTestParams>> = {}) {
  const hooks = holdAgentEnd();
  const onAttemptAbort = vi.fn();
  const onAgentEvent = vi.fn<NonNullable<ReturnType<typeof createParams>["onAgentEvent"]>>();
  const params = Object.assign(createTestParams(), { onAttemptAbort, onAgentEvent }, overrides);
  const harness = createStartedThreadHarness();
  const { run, turnSettled, replyBackend, freezeAbort, detachBackend } =
    await runWithObservedReplyTurn(params);
  return {
    ...hooks,
    backend: { read: replyBackend, freezeAbort, detachBackend },
    harness,
    onAttemptAbort,
    onAgentEvent,
    run,
    turnSettled,
  };
}

function captureDiagnostics(publicOnly = false) {
  const events: DiagnosticEventPayload[] = [];
  const content = new Map<string, DiagnosticEventPrivateData>();
  const stop = publicOnly
    ? onInternalDiagnosticEvent((event) => events.push(event))
    : onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
        events.push(event);
        content.set(event.type, privateData);
      });
  onTestFinished(stop);
  const find = <T extends DiagnosticEventPayload["type"]>(type: T) =>
    events.find(
      (event): event is Extract<DiagnosticEventPayload, { type: T }> => event.type === type,
    );
  return { events, content, find };
}

setupRunAttemptTestHooks();

describe("runCodexAppServerAttempt hooks and model diagnostics", () => {
  it("admits result-required input and waits for correlated native consumption", async () => {
    const params = createTestParams();
    params.terminalReplyExpectation = "result-required";
    params.timeoutMs = 60_000;
    const harness = createStartedThreadHarness(async (method, _request, requestOptions) => {
      if (method === "turn/steer") {
        // The controlled transport must run the real physical-write callback.
        (requestOptions as Parameters<CodexAppServerClient["request"]>[2])?.assertCurrent?.();
        return { turnId: "turn-1" };
      }
      return undefined;
    });
    const { run, attachBackend, turnSettled } = await runWithObservedReplyTurn(params);
    await run.waitForTurnAccepted();
    let result: Awaited<typeof run>;
    try {
      expect(attachBackend).toHaveBeenCalledTimes(1);
      const matchingExpectation = "result-required";
      const options = {
        debounceMs: 0,
        isInboundUserMessage: true,
        allowPendingUserInputAnswer: false as const,
        toolAuthorityFingerprint: params.toolAuthorityFingerprint,
      };
      const accepted = vi.fn<(wasAccepted: boolean) => void>();
      const consumed = vi.fn();
      expect(
        queueActiveRunMessageForTest(params.sessionId, "MATCHED_EXPECTATION", {
          ...options,
          terminalReplyExpectation: matchingExpectation,
          waitForTranscriptCommit: true,
          onQueueAccepted: accepted,
          onQueueSettled: consumed,
        }),
      ).toBe(true);
      await vi.waitFor(
        () => expect(harness.requests.some(({ method }) => method === "turn/steer")).toBe(true),
        fastWait,
      );
      expect(accepted).toHaveBeenCalledExactlyOnceWith(true);
      expect(consumed).not.toHaveBeenCalled();
      const steer = harness.requests.find(({ method }) => method === "turn/steer");
      expect(steer?.params).toMatchObject({
        threadId: "thread-1",
        expectedTurnId: "turn-1",
        input: [{ type: "text", text: "MATCHED_EXPECTATION" }],
      });
      const clientId = (steer?.params as { clientUserMessageId?: string } | undefined)
        ?.clientUserMessageId;
      if (!clientId) {
        throw new Error("Native steering frame must carry its consumption identity");
      }
      await harness.notify({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { id: "matched-user", type: "userMessage", clientId },
        },
      });
      await vi.waitFor(() => expect(consumed).toHaveBeenCalledExactlyOnceWith(), fastWait);
      expect(harness.requests.filter(({ method }) => method === "turn/steer")).toHaveLength(1);
    } finally {
      await harness.notify(
        itemNotification("item/completed", {
          id: "expectation-final",
          type: "agentMessage",
          phase: "final_answer",
          text: "SYNTHETIC_EXPECTATION_COMPLETE",
        }),
      );
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      result = await run;
    }
    await turnSettled;
    expect(readAttemptTerminal(result)).toMatchObject({ aborted: false, timedOut: false });
    expect(result.assistantTexts).toContain("SYNTHETIC_EXPECTATION_COMPLETE");
  });

  it("observes each provider response once without changing whole-turn accounting", async () => {
    const { events, find } = captureDiagnostics();
    const harness = createStartedThreadHarness();
    const params = diagnosticParams();
    const run = runCodexAppServerAttempt(params, { nativeHookRelay: { enabled: false } });
    await run.waitForTurnAccepted();
    const usage = {
      inputTokens: 10,
      cachedInputTokens: 3,
      cacheWriteInputTokens: 1,
      outputTokens: 4,
      reasoningOutputTokens: 2,
      totalTokens: 14,
    };
    const response = (id: number, value: Partial<typeof usage> | null = usage) => ({
      method: "rawResponse/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        responseId: `private-response-${id}`,
        usage: value,
      },
    });
    await harness.notify(response(1));
    await harness.notify(response(1));
    const { totalTokens: _total, ...withoutTotal } = usage;
    await harness.notify(response(2, { ...withoutTotal, cacheWriteInputTokens: 0 }));
    const { cacheWriteInputTokens: _cacheWrite, ...withoutCacheWrite } = usage;
    await harness.notify(response(3, withoutCacheWrite));
    await harness.notify(response(4, null));
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
    expect(observations[1]?.upstreamRequestIdHash).not.toBe(observations[0]?.upstreamRequestIdHash);
    const started = find("model.call.started");
    for (const observation of observations) {
      expect(observation.trace).toEqual(started?.trace);
      expect(observation).not.toHaveProperty("durationMs");
      expect(observation).not.toHaveProperty("sourceTimestampMs");
      expect(JSON.stringify(observation)).not.toContain("private-response");
    }
  });

  it("emits gated model-call content diagnostics for codex turns", async () => {
    const { events, content, find } = captureDiagnostics();
    const llmOutput = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "llm_output", handler: llmOutput }]),
    );
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "turn/start") {
        return {
          turn: {
            ...turnStartResult("turn-1", "completed").turn,
            items: [{ id: "msg-1", type: "agentMessage", text: "hello back", status: "completed" }],
          },
        };
      }
      return undefined;
    });
    const params = diagnosticParams(true);
    const sessionManager = openFileBackedSessionManagerForTest(params.sessionFile, {
      sessionId: "diagnostic-session-1",
    });
    sessionManager.appendMessage(assistantMessage("existing context", Date.now()));
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.sessionId = "diagnostic-session-1";
    params.sessionKey = "agent:diagnostic:diagnostic-session-1";
    params.runId = "diagnostic-run-1";
    const run = runCodexAppServerAttempt(params, { nativeHookRelay: { enabled: false } });
    await harness.waitForMethod("turn/start");
    await run;
    await vi.waitFor(() => expect(find("model.call.completed")).toBeDefined(), fastWait);

    const started = find("model.call.started"),
      completed = find("model.call.completed");
    for (const event of [started, completed]) {
      expect(event).toMatchObject({
        callId: "diagnostic-run-1:codex-model:1",
        observationUnit: "turn",
        agentId: "diagnostic",
      });
    }
    expect(started?.trace?.traceId).toBeTypeOf("string");
    expect(JSON.stringify(started)).not.toContain("hello");
    const startedContent = content.get("model.call.started")?.modelContent;
    expect(startedContent?.inputMessages).toEqual([
      expect.objectContaining({ role: "user", content: readTurnStartText(harness) }),
    ]);
    expect(JSON.stringify(started)).not.toContain("existing context");
    expect(startedContent?.systemPrompt).toBeUndefined();
    expect(JSON.stringify(completed)).not.toContain("hello back");
    expect(JSON.stringify(content.get("model.call.completed")?.modelContent)).toContain(
      "hello back",
    );
    expect(completed?.requestPayloadBytes).toBeGreaterThan(0);
    expect(llmOutput).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.type)).not.toContain("model.call.error");
  }, 240_000);

  it("classifies codex model-call timeout diagnostics", async () => {
    // Diagnostic delivery drains through setImmediate after the deadline settles.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const { find } = captureDiagnostics(true);
    createStartedThreadHarness();
    const params = diagnosticParams();
    params.timeoutMs = 60_000;

    const run = runCodexAppServerAttempt(params);
    await run.waitForTurnAccepted();
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await run;
    await waitForDiagnosticEventsDrained();

    expect(readAttemptTerminal(result).timedOut).toBe(true);
    expect(find("model.call.error")).toMatchObject({
      failureKind: "timeout",
      errorCategory: "timeout",
      agentId: "main",
    });
  });

  it("freezes native terminal success locally before agent_end", async () => {
    const { agentEnd, releaseAgentEnd, harness, run, turnSettled, backend, onAgentEvent } =
      await heldAttempt();
    let settled = false;
    void run.then(() => {
      settled = true;
    });

    await harness.waitForMethod("turn/start");
    await harness.notify(
      itemNotification("item/completed", {
        id: "msg-final-1",
        type: "agentMessage",
        text: "Done.",
        status: "completed",
      }),
    );
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await vi.waitFor(() => expect(agentEnd).toHaveBeenCalledTimes(1), fastWait);
    expect(settled).toBe(false);

    const replyBackend = backend.read();
    expect(replyBackend?.isAbortable?.()).toBe(false);
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
    expect(backend.freezeAbort).not.toHaveBeenCalled();
    const terminalLifecycleEvents = onAgentEvent.mock.calls
      .map(([event]) => event)
      .filter(
        (event) =>
          event.stream === "lifecycle" &&
          (event.data.phase === "end" || event.data.phase === "error"),
      );
    expect(terminalLifecycleEvents).toHaveLength(1);
    expect(terminalLifecycleEvents[0]?.data).toMatchObject({ phase: "end" });
    expect(terminalLifecycleEvents[0]?.data.aborted).toBeUndefined();
    expect(backend.detachBackend).toHaveBeenCalledWith(replyBackend);
    await turnSettled;
    expect(resolveActiveEmbeddedRunSessionId("agent:main:session-1")).toBeUndefined();
  });

  it.each(["client close", "failed turn"])(
    "keeps %s cancellable during agent_end",
    async (failure) => {
      const {
        agentEnd,
        releaseAgentEnd,
        harness,
        run,
        turnSettled,
        backend,
        onAttemptAbort,
        onAgentEvent,
      } = await heldAttempt();
      await run.waitForTurnAccepted();
      if (failure === "client close") {
        harness.close();
      } else {
        await harness.notify(
          turnCompleted({
            id: "turn-1",
            status: "failed",
            items: [],
            error: { message: "codex exploded" },
          }),
        );
      }
      await vi.waitFor(() => expect(agentEnd).toHaveBeenCalledTimes(1), fastWait);
      expect(backend.read()?.isAbortable?.()).toBe(true);
      backend.read()?.cancel("user_abort");
      expect(onAttemptAbort).toHaveBeenCalledTimes(1);
      releaseAgentEnd();
      const result = await run;
      const promptError =
        failure === "client close"
          ? "codex app-server client closed before turn completed"
          : "codex exploded";
      expect(readAttemptTerminal(result)).toMatchObject({
        aborted: false,
        promptError,
      });
      expect(backend.freezeAbort).not.toHaveBeenCalled();
      await turnSettled;
      if (failure === "client close") {
        expect(result.codexAppServerFailure).toMatchObject({
          kind: "client_closed_before_turn_completed",
          replaySafe: true,
        });
        return;
      }
      expect(result.agentHarnessResultClassification).toBeUndefined();
      const events = onAgentEvent.mock.calls.map(([event]) => event);
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
    },
  );

  it("keeps ordinary empty completed turns cancellable until the orchestrator settles", async () => {
    const { agentEnd, releaseAgentEnd, harness, run, turnSettled, backend, onAttemptAbort } =
      await heldAttempt();
    await run.waitForTurnAccepted();
    await harness.notify(
      turnCompleted({ id: "turn-1", status: "completed", items: [], error: null }),
    );
    await vi.waitFor(() => expect(agentEnd).toHaveBeenCalledTimes(1), fastWait);

    expect(backend.read()?.isAbortable?.()).toBe(true);
    backend.read()?.cancel("user_abort");
    expect(onAttemptAbort).toHaveBeenCalledTimes(1);

    releaseAgentEnd();
    const result = await run;
    expect(readAttemptTerminal(result)).toMatchObject({ aborted: false, promptError: null });
    expect(result.agentHarnessResultClassification).toBe("empty");
    expect(backend.freezeAbort).not.toHaveBeenCalled();
    await turnSettled;
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
