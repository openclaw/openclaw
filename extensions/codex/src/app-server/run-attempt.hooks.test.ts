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
  createTestParams,
  createStartedThreadHarness,
  fastWait,
  mockCall,
  queueActiveRunMessageForTest,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
} from "./run-attempt-test-harness.js";

type ReplyBackend = Parameters<
  Parameters<Parameters<typeof withAdmittedSessionTurnForTest>[1]>[0]["attachBackend"]
>[0];
type Params = ReturnType<typeof createTestParams>;
type Harness = ReturnType<typeof createStartedThreadHarness>;
type Attempt = ReturnType<typeof runCodexAppServerAttempt>;

const complete = (harness: Harness) =>
  harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
const agentMessage = (id: string, text: string, extra: Record<string, string>) =>
  itemNotification("item/completed", { id, type: "agentMessage", text, ...extra });
const steeringRequests = (harness: Harness) =>
  harness.requests.filter(({ method }) => method === "turn/steer");

async function startSteeringAttempt(terminalReplyExpectation: Params["terminalReplyExpectation"]) {
  const params = { ...createTestParams(), terminalReplyExpectation, timeoutMs: 60_000 };
  const harness = createStartedThreadHarness(async (method, _request, requestOptions) => {
    if (method === "turn/steer") {
      // Assert live transport authority at the physical write.
      (requestOptions as Parameters<CodexAppServerClient["request"]>[2])?.assertCurrent?.();
      return { turnId: "turn-1" };
    }
    return undefined;
  });
  const observed = await runWithObservedReplyTurn(params);
  await observed.run.waitForTurnAccepted();
  expect(observed.replyBackend()?.terminalReplyExpectation).toBe(terminalReplyExpectation);
  return { params, harness, ...observed };
}

// Runs the attempt inside its real controller turn, as a Gateway run would, and
// observes how Codex uses that operation. The turn completes after the attempt.
async function runWithObservedReplyTurn(params: Params) {
  const started = createDeferred<{
    run: Attempt;
    replyBackend: () => ReplyBackend | undefined;
  }>();
  const turnSettled = withAdmittedSessionTurnForTest(
    { sessionKey: params.sessionKey!, sessionId: params.sessionId },
    async (operation) => {
      const attachBackend = vi.spyOn(operation, "attachBackend");
      const observed = {
        replyBackend: () => attachBackend.mock.calls.at(-1)?.[0],
        run: runCodexAppServerAttempt(params),
      };
      started.resolve(observed);
      await observed.run.catch(() => undefined);
    },
  );
  void turnSettled.catch(started.reject);
  return { ...(await started.promise), turnSettled };
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

async function heldAttempt(overrides: Partial<Params> = {}) {
  const hooks = holdAgentEnd();
  const onAttemptAbort = vi.fn();
  const onAgentEvent = vi.fn<NonNullable<Params["onAgentEvent"]>>();
  const params = Object.assign(createTestParams(), { onAttemptAbort, onAgentEvent }, overrides);
  const harness = createStartedThreadHarness();
  return {
    ...hooks,
    ...(await runWithObservedReplyTurn(params)),
    harness,
    params,
    onAttemptAbort,
    onAgentEvent,
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
  it.each(["optional", "result-required"] as const)(
    "publishes native %s reply authority for human input",
    async (terminalReplyExpectation) => {
      const { params, harness, run, turnSettled } =
        await startSteeringAttempt(terminalReplyExpectation);
      let result: Awaited<typeof run>;
      try {
        expect(
          queueActiveRunMessageForTest(params.sessionId, "ORDINARY_HUMAN", {
            debounceMs: 0,
            isInboundUserMessage: true,
            toolAuthorityFingerprint: params.toolAuthorityFingerprint,
            terminalReplyExpectation: "required",
          }),
        ).toBe(terminalReplyExpectation !== "optional");
        if (terminalReplyExpectation !== "optional") {
          await harness.waitForMethod("turn/steer");
          expect(steeringRequests(harness)).toMatchObject([
            {
              params: {
                threadId: "thread-1",
                expectedTurnId: "turn-1",
                input: [{ type: "text", text: "ORDINARY_HUMAN" }],
              },
            },
          ]);
          const steer = steeringRequests(harness)[0]?.params as { clientUserMessageId: string };
          await harness.notify(
            itemNotification("item/completed", {
              id: "human-input",
              type: "userMessage",
              clientId: steer.clientUserMessageId,
            }),
          );
        } else {
          expect(steeringRequests(harness)).toEqual([]);
        }
      } finally {
        await harness.notify(
          agentMessage("final", "SYNTHETIC_EXPECTATION_COMPLETE", { phase: "final_answer" }),
        );
        await complete(harness);
        result = await run;
        await turnSettled;
      }
      expect(readAttemptTerminal(result)).toMatchObject({ aborted: false, timedOut: false });
      expect(result.assistantTexts).toContain("SYNTHETIC_EXPECTATION_COMPLETE");
    },
  );

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
    await complete(harness);
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
    const harness = createStartedThreadHarness();
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
    await run.waitForTurnAccepted();
    await harness.notify(agentMessage("msg-1", "hello back", { status: "completed" }));
    await complete(harness);
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
    const turn = harness.requests.find(({ method }) => method === "turn/start")?.params as {
      input: Array<{ text: string }>;
    };
    expect(turn.input[0]?.text).toBeTypeOf("string");
    expect(startedContent?.inputMessages).toEqual([
      expect.objectContaining({ role: "user", content: turn.input[0]?.text }),
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

  it.each([false, true])(
    "keeps the persisted request in agent_end (steering: %s)",
    async (steer) => {
      let pendingRefresh = false;
      const persistedUser = {
        role: "user" as const,
        content: "Remember alpha",
        timestamp: 1,
        ...(steer ? { idempotencyKey: "turn-1:user" } : {}),
      };
      const { agentEnd, releaseAgentEnd, harness, params, run, turnSettled } = await heldAttempt({
        prompt: "Remember alpha",
        suppressNextUserMessagePersistence: true,
        ...(steer ? { pluginRuntimeRefreshPending: () => pendingRefresh } : {}),
        userTurnTranscriptRecorder: {
          message: persistedUser,
          getAdmissionReceipt: () => undefined,
          getPersistedMessage: () => persistedUser,
        } as unknown as NonNullable<Params["userTurnTranscriptRecorder"]>,
      });
      await run.waitForTurnAccepted();
      if (steer) {
        expect(
          queueActiveRunMessageForTest(params.sessionId!, "Also beta", {
            debounceMs: 0,
            isInboundUserMessage: true,
            toolAuthorityFingerprint: params.toolAuthorityFingerprint,
          }),
        ).toBe(true);
        await harness.waitForMethod("turn/steer");
        const request = steeringRequests(harness)[0];
        const clientUserMessageId = (
          request?.params as { clientUserMessageId?: string } | undefined
        )?.clientUserMessageId;
        if (!clientUserMessageId) {
          throw new Error("turn/steer clientUserMessageId missing");
        }
        await harness.notify(
          itemNotification("item/completed", {
            id: "steered-user-message",
            type: "userMessage",
            clientId: clientUserMessageId,
          }),
        );
      }

      pendingRefresh = steer;
      await harness.notify(agentMessage("msg-final-steer", "Done.", { status: "completed" }));
      await complete(harness);
      await vi.waitFor(() => expect(agentEnd).toHaveBeenCalledTimes(1), fastWait);

      const event = mockCall(agentEnd, "agent_end")[0] as {
        messages: Array<{ role: string; content: unknown }>;
      };
      const observedUsers = event.messages.filter((message) => message.role === "user");
      expect(observedUsers).toEqual([
        expect.objectContaining(persistedUser),
        ...(steer ? [expect.objectContaining({ role: "user", content: "Also beta" })] : []),
      ]);
      expect(event.messages.filter((message) => message.role === "assistant")).toHaveLength(1);

      releaseAgentEnd();
      await run;
      await turnSettled;
    },
  );

  it.each(["success", "client close", "failed turn"])(
    "preserves %s terminal authority while agent_end is pending",
    async (outcome) => {
      const f = await heldAttempt();
      const settled = vi.fn();
      void f.run.then(settled);
      await f.run.waitForTurnAccepted();
      if (outcome === "success") {
        await f.harness.notify(agentMessage("msg-final-1", "Done.", { status: "completed" }));
        await complete(f.harness);
      } else if (outcome === "client close") {
        f.harness.close();
      } else {
        await f.harness.notify(
          turnCompleted({ id: "turn-1", status: "failed", error: { message: "codex exploded" } }),
        );
      }
      await vi.waitFor(() => expect(f.agentEnd).toHaveBeenCalledTimes(1), fastWait);
      expect(settled).not.toHaveBeenCalled();
      expect(f.replyBackend()?.isAbortable?.()).toBe(outcome !== "success");
      if (outcome === "success") {
        expect(abortAgentHarnessRun("session-1")).toBe(false);
        expect(resolveActiveEmbeddedRunSessionId("agent:main:session-1")).toBe("session-1");
      } else {
        f.replyBackend()?.cancel("user_abort");
        expect(f.onAttemptAbort).toHaveBeenCalledTimes(1);
      }
      f.releaseAgentEnd();
      const result = await f.run;
      const promptError =
        outcome === "client close"
          ? "codex app-server client closed before turn completed"
          : outcome === "failed turn"
            ? "codex exploded"
            : null;
      expect(readAttemptTerminal(result)).toMatchObject({
        aborted: false,
        promptError,
      });
      await f.turnSettled;
      if (outcome === "success") {
        expect(readAttemptTerminal(result).timedOut).toBe(false);
        expect(settled).toHaveBeenCalledOnce();
        expect(mockCall(f.agentEnd, "agent_end")[0]).toMatchObject({ success: true });
        const terminal = f.onAgentEvent.mock.calls.flatMap(([event]) =>
          event.stream === "lifecycle" &&
          (event.data.phase === "end" || event.data.phase === "error")
            ? [event.data]
            : [],
        );
        expect(terminal).toHaveLength(1);
        expect(terminal[0]).toMatchObject({ phase: "end" });
        expect(terminal[0]?.aborted).toBeUndefined();
        expect(resolveActiveEmbeddedRunSessionId("agent:main:session-1")).toBeUndefined();
        return;
      }
      if (outcome === "client close") {
        expect(result.codexAppServerFailure).toMatchObject({
          kind: "client_closed_before_turn_completed",
          replaySafe: true,
        });
        return;
      }
      expect(result.agentHarnessResultClassification).toBeUndefined();
      const events = f.onAgentEvent.mock.calls.map(([event]) => event);
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
      expect(mockCall(f.agentEnd, "agent_end")).toMatchObject([
        { success: false, error: "codex exploded" },
        { runId: "run-1", sessionId: "session-1" },
      ]);
    },
  );

  it("does not wait for agent_end hooks before resolving channel-backed codex turns", async () => {
    const { agentEnd, releaseAgentEnd } = holdAgentEnd();
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    params.messageChannel = "discord";
    params.messageProvider = "discord";
    const run = runCodexAppServerAttempt(params);

    await harness.waitForMethod("turn/start");
    await complete(harness);
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
