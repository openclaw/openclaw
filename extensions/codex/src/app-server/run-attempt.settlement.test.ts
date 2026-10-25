// Native terminal settlement bounds projection and checkpoint work without harming sibling runs.
import path from "node:path";
import { resolveActiveEmbeddedRunSessionId } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { onInternalSessionTranscriptUpdate } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import {
  readSessionTranscriptEvents,
  withSessionTranscriptWriteLock,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import {
  TURN_FINALIZE_DRAIN_ABORT_GRACE_MS,
  TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS,
} from "./attempt-timeouts.js";
import { isCodexAppServerLiveThreadClaimed } from "./client-runtime.js";
import { CodexAppServerClient } from "./client.js";
import { CodexAppServerEventProjector } from "./event-projector.js";
import { isJsonObject } from "./protocol.js";
import { itemNotification, turnCompleted } from "./protocol.test-helpers.js";
import {
  createNativeRunParams,
  createStartedThreadHarness,
  createTestParams,
  fastWait,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
} from "./run-attempt-test-harness.js";
import * as sharedClient from "./shared-client.js";
import { resetSharedCodexAppServerClientForTests } from "./shared-client.test-support.js";
import {
  attachSqliteSessionTarget,
  readTranscriptMessagesByIdentity,
} from "./sqlite-session.test-helpers.js";
import { createInferenceReadyClientHarness, waitForHarnessRequest } from "./test-support.js";
import { codexTranscriptMirrorRuntime } from "./transcript-mirror.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

setupRunAttemptTestHooks();

async function attachTranscript(
  params: ReturnType<typeof createTestParams>,
  name: string,
  sessionId = `session-${name}`,
) {
  await attachSqliteSessionTarget(params, path.join(tempDir, `${name}.sqlite`), sessionId);
  const target = params.sessionTarget;
  if (!target?.sessionId || !target.sessionKey) {
    throw new Error("SQLite transcript target was not attached");
  }
  return { ...target, sessionId: target.sessionId, sessionKey: target.sessionKey };
}

function completedTurn(text: string, threadId = "thread-1", id = "turn-1", itemId = "answer") {
  return {
    method: "turn/completed",
    params: {
      threadId,
      turn: {
        id,
        status: "completed",
        items: [{ id: itemId, type: "agentMessage", text }],
      },
    },
  };
}

function expectSettled(
  result: Awaited<ReturnType<typeof runCodexAppServerAttempt>>,
  text: string,
  aborted = false,
) {
  expect(readAttemptTerminal(result)).toMatchObject({
    aborted,
    timedOut: false,
    promptError: null,
  });
  expect(result.codexAppServerFailure).toBeUndefined();
  expect(result.promptTimeoutOutcome).toBeUndefined();
  expect(result.assistantTexts).toEqual([text]);
}

describe("Codex app-server terminal settlement", () => {
  beforeEach(() => {
    resetSharedCodexAppServerClientForTests();
  });

  afterEach(() => {
    resetSharedCodexAppServerClientForTests();
  });

  it("recovers one durable unknown result for an active native command at settlement expiry", async () => {
    const params = createTestParams();
    await attachTranscript(params, "recovered-native-result");
    const promptPersisted = createDeferred<void>();
    params.onUserMessagePersisted = () => promptPersisted.resolve();
    params.timeoutMs = 60 * 60_000;
    const projectionEntered = createDeferred<void>();
    const releaseProjection = createDeferred<void>();
    const harness = createStartedThreadHarness(async (method) => {
      if (method !== "thread/backgroundTerminals/list") {
        return undefined;
      }
      const notificationSpy = vi
        .spyOn(CodexAppServerEventProjector.prototype, "handleNotification")
        .mockImplementationOnce(async function (this: CodexAppServerEventProjector, notification) {
          notificationSpy.mockRestore();
          projectionEntered.resolve();
          await releaseProjection.promise;
          return await this.handleNotification(notification);
        });
      void harness.notify(
        itemNotification("item/completed", {
          id: "blocked-projection",
          type: "webSearch",
          query: "synthetic settlement blocker",
          action: { type: "search", query: "synthetic settlement blocker" },
          results: null,
        }),
      );
      await projectionEntered.promise;
      return {
        data: [{ itemId: "active-command", processId: "process-1" }],
        nextCursor: null,
      };
    });
    vi.useFakeTimers();
    const run = runCodexAppServerAttempt(params);
    try {
      await harness.waitForMethod("turn/start");
      await promptPersisted.promise;
      await harness.notify(
        itemNotification("item/started", {
          id: "active-command",
          type: "commandExecution",
          command: "synthetic-background-command",
          cwd: params.workspaceDir,
          commandActions: [],
          processId: "process-1",
          source: "agent",
          status: "inProgress",
        }),
      );
      const receivedAt = Date.now();
      void harness.notify(completedTurn("Command is still running."));
      await projectionEntered.promise;
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(
        receivedAt + TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS - Date.now(),
      );

      const result = await run;
      expect(result.terminal).toMatchObject({
        kind: "ok",
        settlementWarning: { timeoutMs: TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS },
      });
      const durableResults = (await readTranscriptMessagesByIdentity(params)).filter(
        (message) => message.role === "toolResult" && message.toolCallId === "active-command",
      );
      expect(durableResults).toEqual([
        expect.objectContaining({
          isError: false,
          details: { processId: "process-1", status: "running" },
          __openclaw: expect.objectContaining({
            toolOutput: expect.objectContaining({ outcome: "unknown" }),
          }),
        }),
      ]);
    } finally {
      releaseProjection.resolve();
      vi.useRealTimers();
      await Promise.allSettled([run]);
    }
  });

  it("checkpoints one failed native result when settlement throws before normal close", async () => {
    const params = createTestParams();
    await attachTranscript(params, "exceptional-native-result");
    const failure = new Error("injected settlement inventory failure");
    vi.spyOn(
      CodexAppServerEventProjector.prototype,
      "getPendingNativeCommands",
    ).mockImplementationOnce(() => {
      throw failure;
    });
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.notify(
      itemNotification("item/started", {
        id: "failed-command",
        type: "commandExecution",
        command: "synthetic-failed-command",
        cwd: params.workspaceDir,
        commandActions: [],
        processId: "process-2",
        source: "agent",
        status: "inProgress",
      }),
    );
    await harness.notify(completedTurn("Settlement failed."));

    await expect(run).rejects.toThrow(failure);
    const durableResults = (await readTranscriptMessagesByIdentity(params)).filter(
      (message) => message.role === "toolResult" && message.toolCallId === "failed-command",
    );
    expect(durableResults).toEqual([
      expect.objectContaining({
        isError: true,
        details: { reason: "missing_tool_result" },
      }),
    ]);
  });

  it.each([MAX_TIMER_TIMEOUT_MS])(
    "settles a native receipt while prompt persistence is blocked with execution budget %i",
    async (timeoutMs) => {
      const params = createTestParams();
      const transcriptTarget = await attachTranscript(params, "held-prompt");
      const held = createDeferred<void>();
      const writerAcquired = createDeferred<void>();
      let writer: Promise<void> | undefined;
      const harness = createStartedThreadHarness(async (method) => {
        if (method === "turn/start") {
          writer = withSessionTranscriptWriteLock(transcriptTarget, async () => {
            writerAcquired.resolve();
            await held.promise;
          });
          await writerAcquired.promise;
        }
        return undefined;
      });
      const onAttemptTimeout = vi.fn();
      const onAttemptDeadlineChanged = vi.fn();
      const turnAccepted = createDeferred<void>();
      params.timeoutMs = timeoutMs;
      params.onAttemptTimeout = onAttemptTimeout;
      params.onAttemptDeadlineChanged = onAttemptDeadlineChanged;
      params.onExecutionPhase = ({ phase }) => {
        if (phase === "turn_accepted") {
          turnAccepted.resolve();
        }
      };
      vi.useFakeTimers();
      const run = runCodexAppServerAttempt(params);
      const settled = vi.fn();
      void run.then(settled, settled);
      try {
        await Promise.race([
          turnAccepted.promise,
          run.then(() => {
            throw new Error("Codex attempt ended before turn acceptance");
          }),
        ]);
        expect(resolveActiveEmbeddedRunSessionId(params.sessionKey!)).toBe(params.sessionId);
        const receivedAtMs = Date.now();
        void harness.notify(
          turnCompleted({
            id: "turn-1",
            status: "completed",
            items: [
              {
                id: "answer",
                type: "agentMessage",
                phase: "final_answer",
                text: "Completed answer.",
              },
            ],
          }),
        );
        await vi.advanceTimersByTimeAsync(60_000);
        expect(onAttemptDeadlineChanged).toHaveBeenLastCalledWith({
          kind: "bounded",
          deadlineAtMs: receivedAtMs + TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS,
        });
        expect(settled).not.toHaveBeenCalled();
        expect(onAttemptTimeout).not.toHaveBeenCalled();
        // Storage released after the deadline simulation must keep its native coordinator timers.
        vi.useRealTimers();
        held.resolve();
        await writer;
        const result = await run;
        expect(result.terminal).toEqual({ kind: "ok" });
        expect(result.assistantTexts).toEqual(["Completed answer."]);
        expect(onAttemptTimeout).not.toHaveBeenCalled();
        expect(harness.requests.some(({ method }) => method === "turn/interrupt")).toBe(false);
      } finally {
        held.resolve();
        vi.useRealTimers();
        await writer;
        await run;
      }
    },
  );

  it("releases a warm claim after degraded settlement without retiring a shared sibling client", async () => {
    const retired = vi.spyOn(sharedClient, "retireSharedCodexAppServerClientIfCurrent");
    const physical = createInferenceReadyClientHarness();
    const startClient = vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(physical.client);
    const projection = createDeferred<void>();
    const finalMirrorRelease = createDeferred<void>();
    const finalMirrorStarted = createDeferred<void>();
    let pendingFinalMirror: Promise<unknown> | undefined;
    const onReasoningStream = vi.fn(() => projection.promise);
    const onAttemptTimeout = vi.fn();
    const createSharedRunParams = (suffix: string) => ({
      ...createNativeRunParams(
        path.join(tempDir, `${suffix}.jsonl`),
        path.join(tempDir, "settlement-workspace"),
        `agent:main:${suffix}`,
      ),
      sessionId: `session-${suffix}`,
      sessionKey: `agent:main:${suffix}`,
      runId: `run-${suffix}`,
      provider: "openai",
      disableTools: false,
      timeoutMs: MAX_TIMER_TIMEOUT_MS,
    });
    const firstParams = {
      ...createSharedRunParams("settlement"),
      onReasoningStream,
      onAttemptTimeout,
    };
    const siblingParams = createSharedRunParams("sibling");
    const firstSettled = vi.fn();
    const warmupRun = runCodexAppServerAttempt(createSharedRunParams("settlement"));
    let firstRun: ReturnType<typeof runCodexAppServerAttempt> | undefined;
    let siblingRun: ReturnType<typeof runCodexAppServerAttempt> | undefined;
    const wireRequests = () =>
      physical.writes.map(
        (write) =>
          JSON.parse(write) as {
            method?: string;
            params?: { threadId?: string };
          },
      );
    const answer = async (method: string, result: unknown, since = 0) => {
      const request = await waitForHarnessRequest(physical, method, since);
      physical.send({ id: request.id, result });
    };
    try {
      await answer("initialize", {
        userAgent: `openclaw/${CODEX_APP_SERVER_VERSION} (macOS; test)`,
      });
      await answer("configRequirements/read", { requirements: null });
      await answer("thread/start", threadStartResult("thread-settlement"));
      await answer("turn/start", turnStartResult("turn-warmup"));
      physical.send({
        method: "turn/completed",
        params: {
          threadId: "thread-settlement",
          turn: { id: "turn-warmup", status: "completed", items: [] },
        },
      });
      await warmupRun;
      // Exact-claim cleanup is a warm-thread contract; a fresh auto-subscription
      // has no branded handle and must retain its separate guarded cleanup path.
      const firstStart = physical.writes.length;
      firstRun = runCodexAppServerAttempt(firstParams);
      void firstRun.then(firstSettled, firstSettled);
      await answer("configRequirements/read", { requirements: null }, firstStart);
      await answer("turn/start", turnStartResult("turn-settlement"), firstStart);
      expect(isCodexAppServerLiveThreadClaimed(physical.client, "thread-settlement")).toBe(true);

      const siblingStart = physical.writes.length;
      siblingRun = runCodexAppServerAttempt(siblingParams);
      await answer("configRequirements/read", { requirements: null }, siblingStart);
      await answer("thread/start", threadStartResult("thread-sibling"), siblingStart);
      await answer("turn/start", turnStartResult("turn-sibling"), siblingStart);
      await vi.waitFor(() => {
        expect(resolveActiveEmbeddedRunSessionId(firstParams.sessionKey)).toBe(
          firstParams.sessionId,
        );
        expect(resolveActiveEmbeddedRunSessionId(siblingParams.sessionKey)).toBe(
          siblingParams.sessionId,
        );
      });

      const finalMirror = codexTranscriptMirrorRuntime.mirrorBestEffort;
      vi.spyOn(codexTranscriptMirrorRuntime, "mirrorBestEffort").mockImplementationOnce((input) => {
        finalMirrorStarted.resolve();
        const pending = finalMirrorRelease.promise.then(() => finalMirror(input));
        pendingFinalMirror = pending;
        return pending;
      });
      vi.useFakeTimers();
      const receivedAt = Date.now();
      // Queue both frames before yielding. The second callback starts only after
      // the real router has finished handling the exact terminal notification.
      physical.send(
        completedTurn("Completed work remains visible.", "thread-settlement", "turn-settlement"),
      );
      physical.send({
        method: "item/reasoning/textDelta",
        params: {
          threadId: "thread-settlement",
          turnId: "turn-settlement",
          itemId: "late-reasoning",
          delta: "Queued projection after native completion.",
        },
      });
      await vi.waitFor(() => expect(onReasoningStream).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(
        receivedAt + TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS - Date.now() - 1,
      );
      expect(onAttemptTimeout).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(onAttemptTimeout).not.toHaveBeenCalled();
      await finalMirrorStarted.promise;
      expect(firstSettled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(TURN_FINALIZE_DRAIN_ABORT_GRACE_MS);
      const unsubscribe = await waitForHarnessRequest(physical, "thread/unsubscribe");
      expect(unsubscribe.params).toEqual({ threadId: "thread-settlement" });
      physical.send({ id: unsubscribe.id, result: {} });
      await vi.waitFor(() => expect(firstSettled).toHaveBeenCalledOnce(), fastWait);
      const result = await firstRun;
      expectSettled(result, "Completed work remains visible.");
      expect(readAttemptTerminal(result)).toMatchObject({
        settlementWarning: { pendingStage: "onReasoningStream" },
      });
      expect(
        wireRequests()
          .filter(
            ({ method }) =>
              method === "turn/interrupt" ||
              method === "thread/backgroundTerminals/list" ||
              method === "thread/unsubscribe",
          )
          .map(({ params }) => params?.threadId),
      ).toEqual(["thread-settlement"]);
      expect(retired).not.toHaveBeenCalled();
      expect(physical.stdinDestroyed).toBe(false);
      expect(resolveActiveEmbeddedRunSessionId(firstParams.sessionKey)).toBeUndefined();
      expect(resolveActiveEmbeddedRunSessionId(siblingParams.sessionKey)).toBe(
        siblingParams.sessionId,
      );

      physical.send(
        completedTurn(
          "Sibling stayed healthy.",
          "thread-sibling",
          "turn-sibling",
          "sibling-answer",
        ),
      );
      const siblingResult = await siblingRun;
      expect(readAttemptTerminal(siblingResult)).toMatchObject({
        aborted: false,
        timedOut: false,
        promptError: null,
      });
      expect(siblingResult.assistantTexts).toEqual(["Sibling stayed healthy."]);
      expect(startClient).toHaveBeenCalledOnce();
      expect(physical.stdinDestroyed).toBe(false);
    } finally {
      projection.resolve();
      finalMirrorRelease.resolve();
      await pendingFinalMirror;
      vi.useRealTimers();
      physical.client.close();
      await Promise.allSettled([
        warmupRun,
        ...(firstRun ? [firstRun] : []),
        ...(siblingRun ? [siblingRun] : []),
      ]);
    }
  });

  it.each([
    { boundary: "checkpoint", termination: "timeout", release: "during recovery" },
    { boundary: "final", termination: "timeout", release: "after cutoff" },
    { boundary: "final", termination: "abort", release: "during grace" },
    { boundary: "checkpoint", termination: "abort", release: "during grace" },
    { boundary: "publication", termination: "abort", release: "on publication" },
  ] as const)(
    "settles $termination at $boundary with writer release $release",
    async ({ boundary, termination, release }) => {
      const queuedNetworkResult = boundary === "checkpoint" && termination === "timeout";
      const params = createTestParams();
      const transcriptTarget = await attachTranscript(
        params,
        "settlement-checkpoint",
        "session-checkpoint",
      );
      const checkpoint = createDeferred<void>();
      const checkpointWrites: Promise<unknown>[] = [];
      const holdWriter = async () => {
        const writerAcquired = createDeferred<void>();
        checkpointWrites.push(
          withSessionTranscriptWriteLock(transcriptTarget, async () => {
            writerAcquired.resolve();
            await checkpoint.promise;
          }),
        );
        await writerAcquired.promise;
      };
      // Database worker requests arm 60-second timeouts on the fake clock. A write parked behind
      // the held writer starts after the deadline jump, which would otherwise expire its I/O.
      const deadlineJumped = createDeferred<void>();
      if (termination !== "timeout") {
        deadlineJumped.resolve();
      }
      const mirrorCheckpoint = codexTranscriptMirrorRuntime.mirror;
      const checkpointMirror = vi.spyOn(codexTranscriptMirrorRuntime, "mirror");
      if (boundary === "checkpoint") {
        checkpointMirror.mockImplementationOnce(async (input) => {
          await deadlineJumped.promise;
          return await mirrorCheckpoint(input);
        });
      }
      const finalMirrorStarted = createDeferred<void>();
      if (boundary === "final") {
        const finalMirror = codexTranscriptMirrorRuntime.mirrorBestEffort;
        vi.spyOn(codexTranscriptMirrorRuntime, "mirrorBestEffort").mockImplementationOnce(
          async (input) => {
            await holdWriter();
            finalMirrorStarted.resolve();
            await deadlineJumped.promise;
            const writing = finalMirror(input);
            checkpointWrites.push(writing);
            return await writing;
          },
        );
      }
      const harness = createStartedThreadHarness();
      const onAttemptTimeout = vi.fn();
      const onAgentEvent = vi.fn();
      const abort = new AbortController();
      const successorAbort = new AbortController();
      const publishedTerminal = vi.fn();
      const unsubscribe = onInternalSessionTranscriptUpdate((update) => {
        if (boundary === "publication" && update.runId === params.runId) {
          publishedTerminal(update);
          abort.abort("cancelled after transcript commit");
        }
      });
      params.abortSignal = abort.signal;
      params.onAttemptTimeout = onAttemptTimeout;
      params.onAgentEvent = onAgentEvent;
      // Whole-message preparation must not erase the terminal owner's warning.
      params.prepareAssistantTranscriptMessage = (message) => ({
        ...message,
        __openclaw: undefined,
      });
      params.timeoutMs = 60 * 60_000;
      const promptPersisted = createDeferred<void>();
      params.onUserMessagePersisted = () => promptPersisted.resolve();
      vi.useFakeTimers();
      const settled = vi.fn();
      const run = runCodexAppServerAttempt(params);
      let successor: ReturnType<typeof runCodexAppServerAttempt> | undefined;
      void run.then(settled, settled);
      try {
        await harness.waitForMethod("turn/start");
        if (boundary === "checkpoint") {
          await promptPersisted.promise;
          await holdWriter();
        }
        await harness.notify({
          method: "rawResponse/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            responseId: "response-1",
            usage: {
              totalTokens: 12,
              inputTokens: 5,
              cachedInputTokens: 2,
              outputTokens: 7,
              reasoningOutputTokens: 0,
            },
          },
        });
        const completedCommand = {
          id: "checkpoint-command",
          type: "commandExecution",
          command: "echo saved",
          cwd: params.workspaceDir,
          commandActions: [],
          processId: null,
          source: "agent",
          status: "completed",
          aggregatedOutput: "saved",
          exitCode: 0,
          durationMs: 1,
        };
        if (queuedNetworkResult) {
          void harness.notify(itemNotification("item/completed", completedCommand));
          await vi.waitFor(() => expect(checkpointMirror).toHaveBeenCalledOnce(), fastWait);
          void harness.notify(
            itemNotification("item/completed", {
              id: "queued-search",
              type: "webSearch",
              query: "synthetic network result",
              action: { type: "search", query: "synthetic network result" },
              results: null,
            }),
          );
        }
        const receivedAt = Date.now();
        void harness.notify(
          turnCompleted({
            id: "turn-1",
            status: "completed",
            items: [
              ...(queuedNetworkResult ? [] : [completedCommand]),
              {
                id: "checkpoint-answer",
                type: "agentMessage",
                text: "Completed before checkpoint.",
              },
            ],
          }),
        );
        await vi.waitFor(() => expect(checkpointMirror).toHaveBeenCalledOnce(), fastWait);
        if (boundary === "final") {
          await finalMirrorStarted.promise;
        }
        if (termination === "timeout") {
          await vi.advanceTimersByTimeAsync(
            receivedAt + TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS - Date.now(),
          );
          expect(onAttemptTimeout).not.toHaveBeenCalled();
          deadlineJumped.resolve();
        } else if (boundary === "publication") {
          await vi.waitFor(() => expect(publishedTerminal).toHaveBeenCalledOnce(), fastWait);
        } else {
          abort.abort("cancelled");
        }
        if (release === "after cutoff") {
          await vi.advanceTimersByTimeAsync(TURN_FINALIZE_DRAIN_ABORT_GRACE_MS);
        } else if (release === "during recovery") {
          await vi.advanceTimersByTimeAsync(1);
        }
        if (release !== "after cutoff") {
          // The replacement final still queues behind the authoritative writer.
          checkpoint.resolve();
          await Promise.allSettled(checkpointWrites);
        }
        if (release !== "during grace") {
          await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce(), fastWait);
        }
        // Keep the grace clock fixed while accepted transcript work and cleanup settle.
        const result = await run;
        expect(settled).toHaveBeenCalledOnce();
        expectSettled(result, "Completed before checkpoint.", termination === "abort");
        if (termination === "timeout") {
          expect(result.terminal).toMatchObject({
            kind: "ok",
            settlementWarning: {
              pendingStage: boundary === "final" ? "transcript/mirror" : "transcript/checkpoint",
              timeoutMs: TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS,
            },
          });
        }
        expect(onAttemptTimeout).not.toHaveBeenCalled();
        expect(result.lastAssistant?.stopReason).toBe(termination === "abort" ? "aborted" : "stop");
        expect(result.attemptUsage).toMatchObject({ input: 3, output: 7, cacheRead: 2, total: 12 });
        if (termination === "abort") {
          expect(result.attemptUsage?.contextUsage).toEqual({ state: "unavailable" });
        }
        const assistantCommitted =
          (termination === "timeout" && release === "during recovery") ||
          boundary === "publication" ||
          (boundary === "checkpoint" && release === "during grace");
        expect(
          onAgentEvent.mock.calls.filter(
            ([event]) =>
              event.stream === "lifecycle" &&
              (event.data.phase === "end" || event.data.phase === "error"),
          ),
        ).toHaveLength(1);
        expect(resolveActiveEmbeddedRunSessionId(transcriptTarget.sessionKey)).toBeUndefined();
        checkpoint.resolve();
        await Promise.allSettled(checkpointWrites);
        const events = await readSessionTranscriptEvents(transcriptTarget);
        const assistantRows = events.filter(
          (event) =>
            isJsonObject(event) &&
            isJsonObject(event.message) &&
            event.message.role === "assistant" &&
            isJsonObject(event.message["__openclaw"]) &&
            event.message["__openclaw"].mirrorIdentity === "turn-1:assistant",
        );
        if (assistantCommitted) {
          expect(assistantRows).toEqual([
            expect.objectContaining({
              id: result.contextEngineTerminalAnchor?.entryId,
              message: expect.objectContaining({
                stopReason:
                  termination === "timeout" || boundary === "publication" ? "stop" : "aborted",
                idempotencyKey: result.assistantTranscriptIdempotencyKey,
              }),
            }),
          ]);
          if (termination === "timeout") {
            expect(assistantRows[0]).toHaveProperty(
              "message.__openclaw.settlementWarning.timeoutMs",
              TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS,
            );
            if (queuedNetworkResult) {
              expect(assistantRows[0]).toHaveProperty("message.__openclaw.turnTainted", true);
            }
          }
          if (boundary === "publication") {
            expect(publishedTerminal).toHaveBeenCalledExactlyOnceWith(
              expect.objectContaining({ messageId: result.contextEngineTerminalAnchor?.entryId }),
            );
          }
        } else {
          expect(assistantRows).toEqual([]);
        }
        if (assistantCommitted) {
          expect(result.assistantTranscriptOwned).toBe(true);
          expect(result.assistantTranscriptIdempotencyKey).toEqual(expect.any(String));
          expect(result.contextEngineTerminalAnchor).toMatchObject({
            idempotencyKey: result.assistantTranscriptIdempotencyKey,
          });
        } else {
          expect(result.assistantTranscriptOwned).not.toBe(true);
          expect(result.assistantTranscriptIdempotencyKey).toBeUndefined();
          expect(result.contextEngineTerminalAnchor).toBeUndefined();
        }
        if (boundary === "final" && release === "after cutoff") {
          const terminalAssistant = onAgentEvent.mock.calls
            .map(([event]) => event)
            .findLast((event) => event.stream === "assistant");
          expect(terminalAssistant?.data).toEqual({
            text: "Completed before checkpoint.",
            itemId: "codex-app-server:thread-1:turn-1:assistant",
            replace: true,
            replaceable: true,
          });
          // Successor I/O and relay retirement must outlive the completed deadline simulation.
          vi.useRealTimers();
          let nextThreadId = "thread-1";
          const nextHarness = createStartedThreadHarness(
            async (method) => {
              if (method === "thread/start" || method === "thread/resume") {
                // A rotated native thread cannot reuse its persisted predecessor's ID.
                nextThreadId = method === "thread/start" ? "thread-next" : "thread-1";
                return threadStartResult(nextThreadId);
              }
              return method === "turn/start" ? turnStartResult("turn-next") : undefined;
            },
            { persistedThreads: ["thread-1"] },
          );
          successor = runCodexAppServerAttempt({
            ...params,
            runId: "run-next",
            abortSignal: successorAbort.signal,
          });
          await successor.waitForTurnAccepted();
          await nextHarness.notify({
            method: "turn/completed",
            params: {
              threadId: nextThreadId,
              turn: {
                id: "turn-next",
                status: "completed",
                items: [{ id: "next-answer", type: "agentMessage", text: "Next turn saved." }],
              },
            },
          });
          const next = await successor;
          expect(readAttemptTerminal(next)).toMatchObject({ aborted: false, timedOut: false });
          expect(next.assistantTranscriptOwned).toBe(true);
          const history = JSON.stringify(await readSessionTranscriptEvents(transcriptTarget));
          expect(history).toContain("Next turn saved.");
          expect(history).not.toContain("Completed before checkpoint.");
        }
      } finally {
        unsubscribe();
        deadlineJumped.resolve();
        checkpoint.resolve();
        abort.abort("test cleanup");
        successorAbort.abort("test cleanup");
        vi.useRealTimers();
        await Promise.allSettled([run, ...checkpointWrites, ...(successor ? [successor] : [])]);
      }
    },
  );
});
