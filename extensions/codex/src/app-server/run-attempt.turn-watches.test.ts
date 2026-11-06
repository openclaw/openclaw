// Native terminal authority, elapsed execution limits, and bounded local settlement.
import path from "node:path";
import { resolveActiveEmbeddedRunSessionId } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as mediaStore from "openclaw/plugin-sdk/media-store";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { awaitGateBeforeSettlement } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import {
  expectSuccessfulAttempt,
  expectTimedOutAttempt,
  projectAttemptResult,
} from "./attempt-terminal.test-support.js";
import {
  TURN_FINALIZE_DRAIN_ABORT_GRACE_MS,
  TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS,
} from "./attempt-timeouts.js";
import * as elicitationBridge from "./elicitation-bridge.js";
import type { CodexServerNotification, JsonObject } from "./protocol.js";
import { itemNotification, rawItemCompleted, turnCompleted } from "./protocol.test-helpers.js";
import {
  bindProductionHarnessHostCapabilitiesForTest,
  createTestParams,
  createStartedThreadHarness,
  fastWait,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
  turnStartResult,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

const tinyPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

const notification = (method: string, params: JsonObject): CodexServerNotification => ({
  method,
  params: { threadId: "thread-1", turnId: "turn-1", ...params },
});

const nativeCompleted = (items: JsonObject[]): CodexServerNotification => ({
  method: "turn/completed",
  params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items } },
});

function completedAssistant(id: string, text: string): CodexServerNotification {
  return itemNotification("item/completed", {
    id,
    type: "agentMessage",
    text,
    status: "completed",
  });
}

function finalizationHookNotification(
  method: "hook/started" | "hook/completed",
  status: "running" | "completed",
): CodexServerNotification {
  return notification(method, {
    run: {
      id: "stop-hook-1",
      eventName: "stop",
      handlerType: "command",
      executionMode: "sync",
      scope: "turn",
      source: "project",
      sourcePath: "/workspace/.codex/hooks.json",
      status,
      statusMessage: null,
      entries: [],
    },
  });
}

function commandNotification(id: string, command: string, completed = true) {
  return itemNotification(completed ? "item/completed" : "item/started", {
    id,
    type: "commandExecution",
    command,
    status: completed ? "completed" : "inProgress",
  });
}

type TestParams = ReturnType<typeof createTestParams>;

function makeTestParams(overrides: Partial<TestParams> = {}): TestParams {
  return { ...createTestParams(), ...overrides };
}

function startAttempt(params: TestParams) {
  const settled = vi.fn();
  const run = runCodexAppServerAttempt(params);
  void run.then(settled, settled);
  return { run, settled };
}

const makeAgentMessageDelta = (delta: string, itemId = "msg-partial-1") =>
  notification("item/agentMessage/delta", { itemId, delta });

async function expectTurnInterrupted(
  harness: ReturnType<typeof createStartedThreadHarness>,
): Promise<void> {
  await vi.waitFor(
    () =>
      expect(harness.request).toHaveBeenCalledWith(
        "turn/interrupt",
        { threadId: "thread-1", turnId: "turn-1" },
        { timeoutMs: 5_000, signal: expect.any(AbortSignal) },
      ),
    { interval: 1 },
  );
}

function makeMediaProjectionGate() {
  const gate = createDeferred<void>();
  const started = createDeferred<void>();
  vi.spyOn(mediaStore, "saveMediaBuffer").mockImplementation(async () => {
    started.resolve();
    await gate.promise;
    throw new Error("expected projection gate");
  });
  return { projectionStarted: started.promise, releaseProjection: gate.resolve };
}

const reasoningDelta = () =>
  notification("item/reasoning/textDelta", { itemId: "reasoning-1", delta: "thinking" });

async function runNotificationScenario(
  notifications: CodexServerNotification[],
  termination: "timeout" | "client-close",
) {
  const timed = termination === "timeout";
  if (timed) {
    vi.useFakeTimers();
  }
  const harness = createStartedThreadHarness();
  const run = runCodexAppServerAttempt(makeTestParams(timed ? { timeoutMs: 60_000 } : {}));
  await run.waitForTurnAccepted();
  for (const event of notifications) {
    await harness.notify(event);
  }
  if (timed) {
    await vi.advanceTimersByTimeAsync(60_000);
  } else {
    harness.close();
  }
  return await run;
}

it.each(["asynchronous assistant output", "tool events buffered during turn start"])(
  "waits for exact native completion after %s",
  async (scenario) => {
    vi.useFakeTimers();
    const buffered = scenario === "tool events buffered during turn start";
    const started = createDeferred<void>();
    const harness = createStartedThreadHarness(async (method) => {
      if (buffered && method === "turn/start") {
        await harness.notify(commandNotification("cmd-1", "git status -sb", false));
        await harness.notify(commandNotification("cmd-1", "git status -sb"));
        started.resolve();
      }
    });
    // Codex owns liveness for this quiet wait only through core's tool-authority boundary.
    const { run, settled } = startAttempt(
      makeTestParams({
        timeoutMs: buffered ? 60 * 60_000 : MAX_TIMER_TIMEOUT_MS,
      }),
    );
    if (buffered) {
      await Promise.race([run, started.promise]);
      expect(harness.request).toHaveBeenCalledWith(
        "turn/start",
        expect.anything(),
        expect.anything(),
      );
    } else {
      await run.waitForTurnAccepted();
      await harness.notify(
        itemNotification("item/completed", {
          id: "async-1",
          type: "agentMessage",
          phase: "final_answer",
          delivery: "async",
          text: "Child update.",
        }),
      );
    }
    await vi.advanceTimersByTimeAsync((buffered ? 11 : 31) * 60_000);
    expect(settled).not.toHaveBeenCalled();
    expect(harness.requests.some(({ method }) => method === "turn/interrupt")).toBe(false);
    await harness.notify(turnCompleted({ id: "turn-1", status: "completed" }));
    expectSuccessfulAttempt(await run);
  },
);

it("does not let progress extend the elapsed execution budget", async () => {
  vi.useFakeTimers();
  const harness = createStartedThreadHarness();
  const params = makeTestParams({ timeoutMs: 60_000 });
  const onAttemptTimeout = vi.fn();
  params.onAttemptTimeout = onAttemptTimeout;
  const run = runCodexAppServerAttempt(params);
  await run.waitForTurnAccepted();
  for (let index = 0; index < 5; index += 1) {
    await vi.advanceTimersByTimeAsync(10_000);
    await harness.notify(makeAgentMessageDelta(`progress ${index}`));
    expect(harness.requests.some(({ method }) => method === "turn/interrupt")).toBe(false);
  }
  await vi.advanceTimersByTimeAsync(10_000);
  expectTimedOutAttempt(await run);
  expect(onAttemptTimeout).toHaveBeenCalledOnce();
  await expectTurnInterrupted(harness);
});

it("joins queued image projection when timeout aborts the turn", async () => {
  vi.useFakeTimers();
  const harness = createStartedThreadHarness();
  const projection = createDeferred<void>();
  const mediaPath = path.join(tempDir, "queued-image.png");
  const saveMedia = vi.spyOn(mediaStore, "saveMediaBuffer").mockImplementation(async () => {
    await projection.promise;
    return { id: "queued-image", path: mediaPath, size: 1, contentType: "image/png" };
  });
  const { run, settled } = startAttempt(makeTestParams({ timeoutMs: 60_000 }));
  try {
    await harness.waitForMethod("turn/start");
    void harness.notify(
      rawItemCompleted({
        id: "queued-image",
        type: "image_generation_call",
        status: "generating",
        result: tinyPngBase64,
      }),
    );
    await vi.waitFor(() => expect(saveMedia).toHaveBeenCalledOnce(), fastWait);
    await vi.advanceTimersByTimeAsync(60_000);
    await harness.waitForMethod("thread/backgroundTerminals/list");
    expect(settled).not.toHaveBeenCalled();
    expect(harness.requests.some(({ method }) => method === "thread/unsubscribe")).toBe(false);

    // Confirmed stop enters the drain grace; unsubscribe follows that drain.
    projection.resolve();
    vi.useRealTimers();
    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce(), fastWait);
    const result = await run;
    expect(readAttemptTerminal(result).timedOut).toBe(true);
    expect(result.toolMediaUrls).toEqual([mediaPath]);
  } finally {
    projection.resolve();
    vi.useRealTimers();
  }
});

it("retains assistant text and usage without upgrading execution timeout to success", async () => {
  const usage = { totalTokens: 12, inputTokens: 5, cachedInputTokens: 2, outputTokens: 7 };
  const result = await runNotificationScenario(
    [
      commandNotification("cmd-1", "touch done.txt"),
      completedAssistant("msg-1", "Finished."),
      notification("thread/tokenUsage/updated", { tokenUsage: { last: usage } }),
      notification("rawResponse/completed", {
        responseId: "response-1",
        usage: { ...usage, reasoningOutputTokens: 0 },
      }),
    ],
    "timeout",
  );

  expect(projectAttemptResult(result)).toMatchObject({
    aborted: true,
    timedOut: true,
    promptError: "codex app-server execution budget timed out",
    assistantTexts: ["Finished."],
  });
  expect(result.itemLifecycle.completedCount).toBe(2);
  expect(result.attemptUsage).toMatchObject({ input: 3, output: 7, cacheRead: 2, total: 12 });
  expect(result.attemptUsage?.contextUsage).toEqual({ state: "unavailable" });
  expect(result.codexAppServerFailure).toBeUndefined();
  expect(result.promptTimeoutOutcome).toMatchObject({ replayInvalid: true });
});

it("aborts a hung elicitation at the elapsed execution deadline", async () => {
  vi.useFakeTimers();
  const harness = createStartedThreadHarness();
  let requestAborted = false;
  vi.spyOn(elicitationBridge, "routeCodexAppServerElicitationRequest").mockImplementation(
    async ({ signal }) =>
      await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            requestAborted = true;
            reject(new Error("elicitation aborted"));
          },
          { once: true },
        );
      }),
  );
  const params = makeTestParams({ timeoutMs: 60_000 });
  const onRunProgress = vi.fn();
  params.onRunProgress = onRunProgress;

  const run = runCodexAppServerAttempt(params);
  await harness.waitForMethod("turn/start");

  const response = harness.handleServerRequest({
    id: "request-hung-elicitation",
    method: "mcpServer/elicitation/request",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      mode: "form",
      message: "Approve?",
      requestedSchema: { type: "object", properties: {} },
      serverName: "server-1",
      _meta: null,
    },
  });
  await vi.waitFor(
    () =>
      expect(onRunProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "request:mcpServer/elicitation/request:start",
        }),
      ),
    fastWait,
  );

  const responseRejected = expect(response).rejects.toThrow("elicitation aborted");
  await vi.advanceTimersByTimeAsync(60_000);
  const result = await run;
  await responseRejected;
  expectTimedOutAttempt(result);
  expect(requestAborted).toBe(true);
});

it("bounds pre-bind terminal projection after client closure at the settlement deadline", async () => {
  const projection = createDeferred<void>();
  const projectionStarted = createDeferred<void>();
  const onReasoningStream = vi.fn(() => {
    projectionStarted.resolve();
    return projection.promise;
  });
  const controller = new AbortController();
  const harness = createStartedThreadHarness(async (method) => {
    if (method === "turn/start") {
      vi.useFakeTimers();
      await harness.notify(reasoningDelta());
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      return turnStartResult("turn-1", "inProgress");
    }
    return undefined;
  });
  const params = makeTestParams({
    timeoutMs: 60 * 60_000,
    abortSignal: controller.signal,
    onReasoningStream,
  });
  const { run, settled } = startAttempt(params);
  try {
    await awaitGateBeforeSettlement(
      projectionStarted.promise,
      run,
      "Codex attempt ended before reasoning projection",
    );
    expect(onReasoningStream).toHaveBeenCalledOnce();
    harness.close();
    await vi.advanceTimersByTimeAsync(TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(TURN_FINALIZE_DRAIN_ABORT_GRACE_MS + 1);
    vi.useRealTimers();
    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce(), fastWait);
    // A closed transport cannot confirm background-terminal cleanup. That
    // explicit failure must escape even while projection remains blocked.
    await expect(run).rejects.toThrow("Codex cancellation could not confirm the turn stopped");
    expect(resolveActiveEmbeddedRunSessionId(params.sessionKey!)).toBeUndefined();
  } finally {
    projection.resolve();
    vi.useRealTimers();
    controller.abort("test cleanup");
    await run.catch(() => {});
  }
});

it("lets queued terminal projection finish within its settlement window", async () => {
  vi.useFakeTimers();
  const harness = createStartedThreadHarness();
  const projection = createDeferred<void>();
  const onReasoningStream = vi.fn(() => projection.promise);
  const params = makeTestParams({ timeoutMs: 60_000, onReasoningStream });
  const { run, settled } = startAttempt(params);
  try {
    // The controller reports the session active from admission; native events need the turn.
    await run.waitForTurnAccepted();
    const blockedProjection = harness.notify(reasoningDelta());
    await vi.waitFor(() => expect(onReasoningStream).toHaveBeenCalledOnce(), fastWait);
    const queuedTerminal = harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    // Native receipt ends execution, while the local two-minute settlement still owns this tail.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).not.toHaveBeenCalled();
    expect(harness.requests.some(({ method }) => method === "turn/interrupt")).toBe(false);
    projection.resolve();
    await Promise.all([blockedProjection, queuedTerminal]);
    expectSuccessfulAttempt(await run);
  } finally {
    projection.resolve();
  }
});

it("bounds blocked terminal delivery from receipt even when a queued hook completes later", async () => {
  const harness = createStartedThreadHarness();
  harness.client.close = () => harness.close();
  const abortController = new AbortController();
  const projection = createDeferred<void>();
  const blockedReply = createDeferred<void>();
  const onReasoningStream = vi.fn(() => projection.promise);
  const onPartialReply = vi.fn(() => blockedReply.promise);
  const params = makeTestParams({
    timeoutMs: 60 * 60_000,
    abortSignal: abortController.signal,
    onReasoningStream,
    onPartialReply,
  });
  const { run, settled } = startAttempt(params);
  try {
    await harness.waitForMethod("turn/start");
    await harness.notify(
      itemNotification("item/started", {
        id: "msg-final-1",
        type: "agentMessage",
        phase: "final_answer",
        text: "",
      }),
    );
    await harness.notify(finalizationHookNotification("hook/started", "running"));
    void harness.notify(reasoningDelta());
    await vi.waitFor(() => expect(onReasoningStream).toHaveBeenCalledOnce(), fastWait);

    vi.useFakeTimers();
    const completedHook = harness.notify(
      finalizationHookNotification("hook/completed", "completed"),
    );
    void harness.notify(makeAgentMessageDelta("Done.", "msg-final-1"));
    // Receipt sees the unsettled hook; its completion is still behind the first projection.
    void harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await vi.advanceTimersByTimeAsync(TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS / 2);
    projection.resolve();
    await vi.waitFor(() => expect(onPartialReply).toHaveBeenCalledOnce(), fastWait);
    await completedHook;
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS / 2);
    await vi.advanceTimersByTimeAsync(TURN_FINALIZE_DRAIN_ABORT_GRACE_MS + 1);
    vi.useRealTimers();
    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce(), fastWait);
    const result = await run;
    expect(readAttemptTerminal(result)).toMatchObject({ aborted: true, timedOut: true });
    expect(result.codexAppServerFailure?.kind).toBe("turn_settlement_timeout");
    expect(resolveActiveEmbeddedRunSessionId(params.sessionKey!)).toBeUndefined();
  } finally {
    projection.resolve();
    blockedReply.resolve();
    vi.useRealTimers();
    abortController.abort("test_cleanup");
    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce(), fastWait);
  }
});
it("keeps cancellation aborted while completed-looking output has queued media", async () => {
  const { projectionStarted, releaseProjection } = makeMediaProjectionGate();
  const harness = createStartedThreadHarness();
  const abortController = new AbortController();
  const params = makeTestParams({ abortSignal: abortController.signal, timeoutMs: 60_000 });

  const run = runCodexAppServerAttempt(params);
  await harness.waitForMethod("turn/start");
  await harness.notify(completedAssistant("msg-final-1", "Done."));
  const pendingProjection = harness.notify(
    rawItemCompleted({
      id: "ig_raw_1",
      type: "image_generation_call",
      status: "generating",
      result: tinyPngBase64,
    }),
  );
  await projectionStarted;
  expect(harness.requests).not.toContainEqual(
    expect.objectContaining({ method: "turn/interrupt" }),
  );

  abortController.abort("user_cancelled");
  releaseProjection();
  await pendingProjection;

  await expect(run.then(projectAttemptResult)).resolves.toMatchObject({
    aborted: true,
    timedOut: false,
    promptError: null,
  });
});

it("classifies an upstream hard timeout as timed out lifecycle", async () => {
  const harness = createStartedThreadHarness();
  const abortController = new AbortController();
  const onRunAgentEvent = vi.fn();
  const params = makeTestParams({
    abortSignal: abortController.signal,
    onAgentEvent: onRunAgentEvent,
  });
  const run = runCodexAppServerAttempt(params);

  await run.waitForTurnAccepted();
  const timeoutError = new Error("cron watchdog timeout");
  timeoutError.name = "TimeoutError";
  abortController.abort(timeoutError);
  await harness.notify(turnCompleted({ id: "turn-1", status: "interrupted" }));

  const result = await run;
  expect(readAttemptTerminal(result)).toMatchObject({ aborted: true, promptError: null });
  expect(
    onRunAgentEvent.mock.calls
      .map(([event]) => event)
      .find((event) => event.stream === "lifecycle" && event.data.phase === "end")?.data,
  ).toMatchObject({
    aborted: true,
    status: "timed_out",
    stopReason: "timeout",
    timeoutPhase: "provider",
    providerStarted: true,
  });
});

it("settles a client-close route after the host trajectory capability closes (fixture operator)", async () => {
  const operatorSource = {
    profileId: "staff-fixture",
    scopes: ["operator.write"],
    assertCurrent: () => {},
  };

  const harness = createStartedThreadHarness();
  const params = Object.assign(createTestParams(), {
    trajectoryRecorder: { recordEvent: vi.fn(), flush: vi.fn() },
  });
  const closeHost = await bindProductionHarnessHostCapabilitiesForTest(params, operatorSource);
  const run = runCodexAppServerAttempt(params);

  await run.waitForTurnAccepted();
  closeHost();
  harness.close();

  await expect(run).resolves.toMatchObject({
    codexAppServerFailure: { kind: "client_closed_before_turn_completed" },
  });
});

it("keeps a later partial assistant output as a client-close failure after an earlier completed message", async () => {
  const result = await runNotificationScenario(
    [
      itemNotification("item/completed", {
        type: "agentMessage",
        id: "msg-completed-1",
        text: "Earlier complete reply.",
      }),
      makeAgentMessageDelta("Later partial reply", "msg-partial-2"),
    ],
    "client-close",
  );

  expect(readAttemptTerminal(result).promptError).toBe(
    "codex app-server client closed before turn completed",
  );
  expect(result.assistantTexts).toEqual(["Later partial reply"]);
  expect(result.codexAppServerFailure).toEqual({
    kind: "client_closed_before_turn_completed",
    transport: "stdio",
    threadId: "thread-1",
    turnId: "turn-1",
    replaySafe: false,
    replayBlockedReason: "assistant_output",
  });
});

it("does not treat a user prompt containing the interrupted marker as terminal", async () => {
  const harness = createStartedThreadHarness();
  const markerPrompt = "<turn_aborted>\narbitrary prompt prose\n</turn_aborted>";
  const params = makeTestParams({ prompt: markerPrompt });
  const run = runCodexAppServerAttempt(params);
  let resolved = false;
  void run.then(() => {
    resolved = true;
  });

  await harness.waitForMethod("turn/start");
  await harness.notify(
    rawItemCompleted({
      id: "user-prompt-1",
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: markerPrompt,
        },
      ],
    }),
  );
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  expect(resolved).toBe(false);

  await harness.notify(
    nativeCompleted([{ type: "agentMessage", id: "msg-1", text: "It marks an interrupted turn." }]),
  );

  const result = await run;
  expect(resolved).toBe(true);
  expect(readAttemptTerminal(result)).toMatchObject({ aborted: false, timedOut: false });
  expect(result.assistantTexts).toEqual(["It marks an interrupted turn."]);
});

it("releases completion when a projector callback throws during turn/completed", async () => {
  // Regression for openclaw/openclaw#67996: a throw inside the projector's
  // turn/completed handler must not strand resolveCompletion, otherwise the
  // gateway session lane stays locked and every follow-up message queues
  // behind a run that will never resolve.
  const turnStartRequested = createDeferred<void>();
  let turnStarted = false;
  const { request, notify } = createStartedThreadHarness(async (method) => {
    if (method === "turn/start") {
      turnStarted = true;
      turnStartRequested.resolve();
    }
  });
  const params = createTestParams();
  params.onAgentEvent = () => {
    // Only explode once the turn is live: pre-turn run-lifecycle events
    // would otherwise kill the attempt before the projector path under
    // test (turn/completed handling) ever runs.
    if (!turnStarted) {
      return;
    }
    throw new Error("downstream consumer exploded");
  };
  const run = runCodexAppServerAttempt(params);
  await Promise.race([run, turnStartRequested.promise]);
  expect(request.mock.calls.map(([method]) => method)).toContain("turn/start");
  await notify(nativeCompleted([{ id: "plan-1", type: "plan", text: "step one\nstep two" }]));
  const result = await run;
  expect(readAttemptTerminal(result)).toMatchObject({ aborted: false, timedOut: false });
});
