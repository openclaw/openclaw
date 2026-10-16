import { realpathSync } from "node:fs";
import path from "node:path";
import { streamAnthropic } from "@openclaw/ai/internal/anthropic";
import type { CompactionReplayRejection } from "@openclaw/ai/transports";
import {
  createAssistantMessageEventStream,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { createReplyOperation } from "../../../auto-reply/reply/reply-run-registry.js";
import { testing as replyRecoveryTesting } from "../../../auto-reply/reply/reply-run-registry.test-support.js";
import { CliPluginInvocationResources } from "../../../cli/plugin-invocation-resources.js";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import {
  waitForDiagnosticEventsDrained,
  setDiagnosticsEnabledForProcess,
  resetDiagnosticEventsForTest,
} from "../../../infra/diagnostic-events.js";
import {
  getDiagnosticSessionActivitySnapshot,
  startDiagnosticRunActivityTracking,
  stopDiagnosticRunActivityTracking,
} from "../../../logging/diagnostic-run-activity.js";
import { recoverStuckDiagnosticSession } from "../../../logging/diagnostic-stuck-session-recovery.runtime.js";
import { logSessionStateChange } from "../../../logging/diagnostic.js";
import { resetDiagnosticStateForTest } from "../../../logging/diagnostic.test-support.js";
import { enqueueCommandInLane } from "../../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../../process/command-queue.test-support.js";
import { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../../state/openclaw-agent-db.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import {
  mergeAgentRunAttemptTerminal,
  projectAgentRunAttemptTerminal,
} from "../../agent-run-terminal-outcome.js";
import { withPreparedEmbeddedRunToolAuthority } from "../../harness/tool-authority.runtime.js";
import { createAgentCleanupScope } from "../../run-cleanup-timeout.js";
import type { StreamFn } from "../../runtime/index.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import {
  createAssistant,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { convertToLlm } from "../../sessions/messages.js";
import { resolveEmbeddedSessionLane } from "../lanes.js";
import { clearActiveEmbeddedRun } from "../runs.js";
import { testing as embeddedRecoveryTesting } from "../runs.test-support.js";
import { abortable } from "./abortable.js";
import {
  createEmbeddedAttemptIdleInterruption,
  createEmbeddedAttemptRunAbort,
} from "./attempt-finalize.js";
import {
  cleanupEmbeddedAttemptSessionPhase,
  createEmbeddedAttemptSessionSettleTracker,
} from "./attempt-session-settle.js";
import { checkpoint, createStreamCustodyFixture } from "./attempt-stream-custody.test-support.js";
import { prepareCatalogExecutor } from "./attempt-stream-prepare.test-support.js";
import { createEmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle.js";
import { createEmbeddedRunLaneController } from "./lane-controller.js";
import { EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS } from "./lane-runtime.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import type { EmbeddedAttemptExecutionState } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
registerAgentSessionLoopTestLifecycle();
type ReplayOptions = NonNullable<Parameters<StreamFn>[2]> & {
  onCompactionRejected?: (rejected: CompactionReplayRejection) => void;
};

afterEach(async () => {
  vi.useRealTimers();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
});

const nextTurn = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

function anthropicTurn(inputTokens: number, blocks: Array<Record<string, unknown>> = []) {
  const events = [
    {
      type: "message_start",
      message: { id: `msg_${inputTokens}`, usage: { input_tokens: inputTokens } },
    },
    ...blocks.flatMap((content_block, index) => [
      { type: "content_block_start", index, content_block },
      { type: "content_block_stop", index },
    ]),
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  return new Response(
    events
      .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function observeSettlement<T>(promise: Promise<T>) {
  let settled = false;
  const markSettled = () => {
    settled = true;
  };
  void promise.then(markSettled, markSettled);
  return () => settled;
}

async function expectPending(...promises: Promise<unknown>[]) {
  const settled = promises.map(observeSettlement);
  await nextTurn();
  expect(settled.map((read) => read())).toEqual(promises.map(() => false));
}

function textAssistant(text: string, model = testModel) {
  return createAssistant(model, [{ type: "text", text }]);
}

function completedStream(text: string, terminalEvent = false) {
  const stream = createAssistantMessageEventStream();
  if (terminalEvent) {
    stream.push({ type: "done", reason: "stop", message: textAssistant(text) });
  } else {
    stream.end(textAssistant(text));
  }
  return stream;
}

function rejectingReplay(provider: StreamFn): StreamFn {
  return (model, context, options) => {
    (options as ReplayOptions).onCompactionRejected?.(checkpoint);
    return provider(model, context, options);
  };
}

async function withHeldWriter(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  run: (
    release: () => void,
    pending: Promise<unknown>[],
    close: (iterator: AsyncIterator<AssistantMessageEvent>) => void,
  ) => Promise<void>,
) {
  const held = await fixture.holdWriter();
  const pending: Promise<unknown>[] = [];
  let iterator: AsyncIterator<AssistantMessageEvent> | undefined;
  try {
    await run(held.release, pending, (value) => {
      iterator = value;
    });
  } finally {
    held.release();
    await Promise.allSettled([held.work, ...pending]);
    await iterator?.return?.();
  }
}

function createFixture(
  provider: StreamFn,
  options: Parameters<typeof createStreamCustodyFixture>[2] = {},
) {
  return createStreamCustodyFixture(
    () => realpathSync(tempDirs.make("openclaw-stream-custody-")),
    provider,
    options,
  );
}

describe("installed replay repair ownership", () => {
  it("keeps the newer model request active when an older result finishes late", async () => {
    const firstSource = createAssistantMessageEventStream();
    const secondSource = createAssistantMessageEventStream();
    const provider = vi
      .fn<StreamFn>()
      .mockReturnValueOnce(firstSource)
      .mockReturnValueOnce(secondSource);
    const fixture = await createFixture(provider);
    let first: Awaited<ReturnType<typeof fixture.open>> | undefined;
    let second: Awaited<ReturnType<typeof fixture.open>> | undefined;
    try {
      first = await fixture.open();
      expect(fixture.streamGuards.isModelCallActive()).toBe(true);
      second = await fixture.open();
      expect(fixture.streamGuards.isModelCallActive()).toBe(true);
      expect(fixture.input.setup.emitPrepStageSummary).toHaveBeenCalledExactlyOnceWith(
        "model-dispatch",
      );
      expect(fixture.input.setup.prepStages.snapshot().stages.map(({ name }) => name)).toEqual([
        "model-dispatch",
      ]);
      firstSource.end(textAssistant("Older result"));
      await first.result();
      expect(fixture.streamGuards.isModelCallActive()).toBe(true);
      secondSource.end(textAssistant("Current result"));
      await second.result();
      expect(fixture.streamGuards.isModelCallActive()).toBe(false);
    } finally {
      firstSource.end();
      secondSource.end();
      await Promise.allSettled([first?.result(), second?.result()]);
    }
  });

  it("closes a partial-only thinking stream without waiting for ordinary provider completion", async () => {
    const source = createAssistantMessageEventStream();
    const fixture = await createFixture(
      (model) => {
        source.push({
          type: "start",
          partial: textAssistant("Synthetic partial", model),
        });
        return source;
      },
      { thinkingRecovery: true },
    );
    const work = new AsyncWorkScope();
    const response = await work.run(fixture.open);
    const iterator = work.run(() => response[Symbol.asyncIterator]());
    let returned: Promise<unknown> | undefined;
    let draining: Promise<void> | undefined;
    try {
      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: { type: "start" },
      });
      returned = Promise.resolve(iterator.return?.());
      const closed = observeSettlement(returned);
      await nextTurn();
      expect(closed()).toBe(true);
      expect(fixture.repaired).not.toHaveBeenCalled();
      draining = work.drain();
      // Closing the consumer does not certify that the actual provider pump ended.
      await expectPending(draining);
      source.end(textAssistant("Synthetic completion", fixture.attempt.model));
      await draining;
    } finally {
      source.end(createAssistant(fixture.attempt.model, []));
      await Promise.allSettled([returned, draining]);
      await work.drain();
    }
  });

  it.each([
    { failureMode: "request-rejection", boundary: "return-before-next" },
    { failureMode: "stream-rejection", boundary: "concurrent-results" },
    { failureMode: "promised-stream-rejection", boundary: "event" },
    { failureMode: "checkpoint", boundary: "result" },
    { failureMode: "checkpoint", boundary: "completion" },
    { failureMode: "checkpoint", boundary: "return-before-next" },
  ] as const)(
    "keeps $boundary behind the admitted repair after $failureMode",
    async ({ failureMode, boundary }) => {
      let requests = 0;
      const thinking = failureMode !== "checkpoint";
      const fixture = await createFixture(
        thinking
          ? (model) => {
              if (++requests === 1 && failureMode === "request-rejection") {
                return Promise.reject(new Error("thinking signature invalid"));
              }
              const stream = createAssistantMessageEventStream();
              if (requests === 1) {
                stream.push({
                  type: "error",
                  reason: "error",
                  error: {
                    ...createAssistant(model, [], "error"),
                    errorMessage: "thinking signature invalid",
                  },
                });
              } else {
                stream.push({
                  type: "done",
                  reason: "stop",
                  message: textAssistant("Synthetic recovered response", model),
                });
              }
              return failureMode === "promised-stream-rejection" ? Promise.resolve(stream) : stream;
            }
          : rejectingReplay(() => completedStream("Synthetic response", boundary !== "completion")),
        {
          thinkingRecovery: thinking,
          toolNames: !thinking && boundary === "return-before-next" ? ["read"] : [],
        },
      );
      const replayPresent = thinking ? fixture.thinkingPresent : fixture.checkpointPresent;
      await withHeldWriter(fixture, async (release, pending, close) => {
        const response = await fixture.open();
        const iterator = response[Symbol.asyncIterator]();
        close(iterator);
        if (boundary === "concurrent-results") {
          pending.push(response.result(), response.result());
        } else if (boundary === "result") {
          pending.push(response.result());
        } else if (boundary === "return-before-next") {
          pending.push(Promise.resolve(iterator.return?.()));
        } else {
          pending.push(iterator.next());
        }
        await expectPending(...pending);
        if (thinking) {
          expect(requests).toBe(2);
        } else {
          expect(fixture.previousNotification).toHaveBeenCalledExactlyOnceWith(checkpoint);
        }
        expect(replayPresent()).toBe(true);
        release();
        await Promise.all(pending);
        expect(replayPresent()).toBe(false);
        expect(fixture.repaired).toHaveBeenCalledOnce();
      });
    },
  );

  it("durably strips a rejected Anthropic checkpoint so the next request sends full history", async () => {
    const model: Model<"anthropic-messages"> = {
      ...testModel,
      api: "anthropic-messages",
      provider: "anthropic",
      id: "claude-sonnet-4-6",
      baseUrl: "https://api.anthropic.com",
    };
    const requests: Array<{ messages: unknown }> = [];
    const responses: Array<() => Response> = [
      () =>
        anthropicTurn(50_001, [
          { type: "compaction", content: checkpoint.data },
          { type: "text", text: "Done." },
        ]),
      () => {
        throw Object.assign(new Error("context_management compaction block is invalid"), {
          status: 400,
        });
      },
      () => anthropicTurn(1),
    ];
    const client = {
      messages: {
        create: (params: { messages: unknown }) => {
          requests.push(params);
          const respond = responses[requests.length - 1];
          return { asResponse: async () => respond!() };
        },
      },
    };
    // The real provider request owner builds replay, classifies the rejection, and notifies.
    const provider: StreamFn = (streamModel, context, options) =>
      streamAnthropic(streamModel as Model<"anthropic-messages">, context, {
        ...options,
        apiKey: "sk-ant-api-synthetic",
        anthropicServerCompaction: true,
        sessionId: "stream-custody",
        client: client as never,
      });
    const owner = await Promise.resolve(
      provider(model, { messages: [{ role: "user", content: "Synthetic history", timestamp: 1 }] }),
    ).then((stream) => stream.result());
    expect(owner.providerReplay).toMatchObject({ type: "anthropic-compaction" });
    const fixture = await createFixture(provider, { anthropicCompaction: { model, owner } });

    const rejected = await (await fixture.open()).result();

    expect(rejected.stopReason).toBe("error");
    expect(JSON.stringify(requests[1]?.messages)).toContain('"type":"compaction"');
    expect(fixture.checkpointPresent()).toBe(false);
    expect(fixture.repaired).toHaveBeenCalledOnce();
    await Promise.resolve(
      provider(model, { messages: convertToLlm(fixture.manager.buildSessionContext().messages) }),
    ).then((stream) => stream.result());
    expect(JSON.stringify(requests[2]?.messages)).not.toContain('"type":"compaction"');
    expect(JSON.stringify(requests[2]?.messages)).toContain("Synthetic history");
  });

  it("retains rejected stream setup until its notified repair settles", async () => {
    const setupError = new Error("Synthetic provider setup failed");
    const fixture = await createFixture(rejectingReplay(() => Promise.reject(setupError)));
    await withHeldWriter(fixture, async (release, tracked) => {
      const pending = Promise.resolve(fixture.open());
      tracked.push(pending);
      await expectPending(pending);
      release();
      await expect(pending).rejects.toBe(setupError);
      expect(fixture.checkpointPresent()).toBe(false);
    });
  });

  it("owns late stream creation after caller cancellation without publishing a repair", async () => {
    const source = createDeferred<AssistantMessageEventStream>();
    const fixture = await createFixture(rejectingReplay(() => source.promise));
    // The tested scope must not own the blocker or raw provider promise itself.
    const held = await fixture.holdWriter();
    const work = new AsyncWorkScope();
    const pending = Promise.resolve(work.run(fixture.open));
    const reason = new Error("Synthetic cancellation during stream creation");
    let draining: Promise<void> | undefined;
    try {
      fixture.controller.abort(reason);
      await expect(pending).rejects.toMatchObject({ name: "AbortError", cause: reason });
      draining = work.drain();
      await expectPending(draining);
      source.resolve(completedStream("Late response"));
      await expectPending(draining);
      held.release();
      await draining;
      expect(fixture.checkpointPresent()).toBe(true);
      expect(fixture.repaired).not.toHaveBeenCalled();
    } finally {
      held.release();
      source.resolve(completedStream(""));
      await Promise.allSettled([pending, held.work, draining]);
      await work.drain();
    }
  });

  it.each([false, true])(
    "owns cancelled next and one return through late settlement (return rejects=%s)",
    async (rejectReturn) => {
      const entered = createDeferred();
      const sourceNext = createDeferred<IteratorResult<AssistantMessageEvent>>();
      const sourceReturn = createDeferred<IteratorResult<AssistantMessageEvent>>();
      const returnSource = vi.fn(() => sourceReturn.promise);
      const fixture = await createFixture(() => ({
        [Symbol.asyncIterator]: () => ({
          next: () => {
            entered.resolve();
            return sourceNext.promise;
          },
          return: returnSource,
        }),
        result: async () => textAssistant("Late response"),
      }));
      const work = new AsyncWorkScope();
      const cleanup = createAgentCleanupScope();
      const response = await work.run(fixture.open);
      const iterator = work.run(() => response[Symbol.asyncIterator]());
      const pending = cleanup.run(() => iterator.next());
      const reason = new Error("Synthetic iterator cancellation");
      const returnFailure = new Error("Synthetic iterator return failure");
      let draining: Promise<void> | undefined;
      let returned: Promise<unknown> | undefined;
      try {
        await entered.promise;
        fixture.controller.abort(reason);
        await expect(pending).rejects.toMatchObject({ name: "AbortError", cause: reason });
        returned = Promise.resolve(iterator.return?.());
        void returned.catch(() => {});
        draining = work.drain();
        await expectPending(draining);
        expect(returnSource).toHaveBeenCalledOnce();
        if (rejectReturn) {
          sourceReturn.reject(returnFailure);
        } else {
          sourceReturn.resolve({ done: true, value: undefined });
        }
        await expectPending(draining);
        sourceNext.resolve({ done: true, value: undefined });
        await draining;
        await returned.catch(() => {});
        expect(returnSource).toHaveBeenCalledOnce();
        expect(cleanup.outcome).toBe(rejectReturn ? "uncertain" : "closed");
      } finally {
        sourceNext.resolve({ done: true, value: undefined });
        sourceReturn.resolve({ done: true, value: undefined });
        await Promise.allSettled([pending, returned, draining]);
        await work.drain();
      }
    },
  );

  it("retains the SDK prompt's parent runtime after the transcript teardown budget expires", async () => {
    const lifecycle = createEmbeddedAttemptTranscriptLifecycle({
      runId: "stream-custody-run",
      sessionId: "stream-custody",
    });
    const writeStarted = createDeferred();
    let prompting = false;
    const provider = vi.fn(() => completedStream("Synthetic response"));
    const fixture = await createFixture(provider, {
      withSessionWriteSettlement: (operation) =>
        lifecycle.withTranscriptWrite(() => {
          if (prompting) {
            writeStarted.resolve();
          }
          return operation();
        }),
    });
    const session = fixture.session;
    if (!session) {
      throw new Error("SDK session was not created");
    }
    const manager = guardSessionManager(fixture.manager, { runId: fixture.attempt.runId });
    const tracker = createEmbeddedAttemptSessionSettleTracker(session);
    const held = await fixture.holdWriter();
    const parent = new CliPluginInvocationResources();
    const releaseRuntime = vi.fn(async () => {});
    parent.adopt({ release: releaseRuntime });
    // Use the actual SDK event writer, abort tracker, and cleanup owner. Only
    // their existing deadlines advance; the test adds no parent work registration.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let prompt: Promise<void> | undefined;
    let abort: Promise<void> | undefined;
    let release: Promise<void> | undefined;
    const logical = parent.run(async () => {
      prompting = true;
      prompt = tracker.trackPromptSettlePromise(session.prompt("Synthetic queued prompt"));
      void prompt.catch(() => {});
      await writeStarted.promise;
      const reason = new Error("Synthetic cancellation while message persistence is queued");
      fixture.controller.abort(reason);
      abort = tracker.abortActiveSession(reason);
      void abort.catch(() => {});
      await cleanupEmbeddedAttemptSessionPhase({
        attempt: { ...fixture.attempt, abortSignal: fixture.controller.signal },
        session,
        sessionManager: manager,
        transcriptLifecycle: lifecycle,
        trajectoryRecorder: null,
        trajectoryEndRecorded: false,
        buildAbortSettlePromise: tracker.buildAbortSettlePromise,
        state: {
          terminal: { kind: "aborted", source: "external" },
          beforeAgentRunBlockedBy: undefined,
        },
      });
    });
    try {
      const logicalSettled = observeSettlement(logical);
      await writeStarted.promise;
      await nextTurn();
      await vi.advanceTimersByTimeAsync(29_999);
      expect(logicalSettled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      // Abort settlement retains its own unchanged short reporting budget.
      await vi.advanceTimersByTimeAsync(2_000);
      await logical;
      release = parent.release();
      await expectPending(release);
      expect(releaseRuntime).not.toHaveBeenCalled();
      expect(provider).not.toHaveBeenCalled();
      held.release();
      await Promise.allSettled([prompt, abort]);
      await release;
      expect(session.isStreaming).toBe(false);
      expect(releaseRuntime).toHaveBeenCalledOnce();
    } finally {
      held.release();
      await Promise.allSettled([logical, prompt, abort, held.work]);
      await parent.release();
    }
  });

  it("does not classify a completed native producer's queued repair as provider silence", async () => {
    const fixture = await createFixture(
      rejectingReplay(() => completedStream("Native terminal", true)),
    );
    await withHeldWriter(fixture, async (release, tracked, close) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const response = await fixture.open();
      const iterator = response[Symbol.asyncIterator]();
      close(iterator);
      const pending = iterator.next();
      tracked.push(pending);
      const settled = observeSettlement(pending);
      await vi.advanceTimersByTimeAsync(120_001);
      expect(settled()).toBe(false);
      release();
      await expect(pending).resolves.toMatchObject({ done: false, value: { type: "done" } });
    });
  });
});

it.each(["caller cancellation", "reclamation"] as const)(
  "retains watchdog recovery custody until %s",
  async (ending) => {
    // Fake scheduling controls only existing timers. setSystemTime advances the
    // evidence clock without firing the provider's own idle callback first.
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    setDiagnosticsEnabledForProcess(true);
    startDiagnosticRunActivityTracking();
    const enteredProvider = createDeferred();
    const providerAborted = createDeferred();
    const releaseProvider = createDeferred();
    const releaseParent = createDeferred();
    let releaseRawProvider: (() => void) | undefined;
    let idleInterrupt: ((error: Error) => boolean) | undefined;
    const provider: StreamFn = (model, _context, options) => {
      const source = createAssistantMessageEventStream();
      source.push({ type: "start", partial: createAssistant(model, []) });
      releaseRawProvider = () => {
        const interrupted = createAssistant(model, [], "aborted");
        source.push({ type: "error", reason: "aborted", error: interrupted });
        source.end();
      };
      const onAbort = () => {
        providerAborted.resolve();
        // A cancelled provider may still own its pump. Its actual promise/stream
        // settlement is controlled here; no owner/phase/terminal fact is injected.
        void releaseProvider.promise.then(() => {
          options?.signal?.removeEventListener("abort", onAbort);
          releaseRawProvider?.();
        });
      };
      options?.signal?.addEventListener("abort", onAbort, { once: true });
      if (options?.signal?.aborted) {
        onAbort();
      }
      enteredProvider.resolve();
      return source;
    };
    const fixture = await createFixture(provider, {
      withSessionWriteSettlement: async (operation) => operation(),
      onIdleTimeout: (error) => idleInterrupt?.(error),
    });
    const session = fixture.session;
    if (!session) {
      throw new Error("real AgentSession was not constructed");
    }
    const { attempt, manager, controller, streamGuards, diagnosticOwner } = fixture;
    const operation = createReplyOperation({
      sessionKey: attempt.sessionKey!,
      sessionId: attempt.sessionId,
      resetTriggered: false,
    });
    operation.setPhase("running");
    const admission = prepareSystemAgentRunAdmission({}, attempt.runId, "main", "watchdog-custody");
    let active: Promise<void> | undefined;
    let queued: Promise<void> | undefined;
    let recovery: ReturnType<typeof recoverStuckDiagnosticSession> | undefined;
    let repeatedRecovery: ReturnType<typeof recoverStuckDiagnosticSession> | undefined;
    let prompt: Promise<void> | undefined;
    let promptSettled = () => false;
    let prepared: ReturnType<typeof prepareCatalogExecutor> | undefined;
    const tracker = createEmbeddedAttemptSessionSettleTracker(session);
    const state: Pick<EmbeddedAttemptExecutionState, "terminal"> = { terminal: { kind: "ok" } };
    const laneName = resolveEmbeddedSessionLane(attempt.sessionKey!);
    let generation = getAgentEventLifecycleGeneration();
    const workspaceDir = path.dirname(manager.getSessionTarget()!.storePath!);
    const execution = {
      ...attempt,
      workspaceDir,
      sessionFile: path.join(workspaceDir, `${attempt.sessionId}.jsonl`),
      prompt: "Wait for the model",
      timeoutMs: 3_600_000,
      abortSignal: operation.abortSignal,
      replyOperation: operation,
      agentId: "main",
    };
    let params: RunEmbeddedAgentParams & { sessionFile: string } = {
      ...execution,
      model: attempt.modelId,
    };
    const lane = createEmbeddedRunLaneController({
      getLifecycleGeneration: () => generation,
      getParams: () => params,
      globalLane: "test:watchdog-custody-global",
      sessionLane: laneName,
      initialQueuedLifecycleGeneration: generation,
      setLifecycleGeneration: (value) => {
        generation = value;
      },
      setParams: (value) => {
        params = value;
      },
    });
    const requestRecovery = () => {
      const pending = recoverStuckDiagnosticSession({
        sessionId: attempt.sessionId,
        sessionKey: attempt.sessionKey,
        ageMs: 5 * 60_000 + 1,
        queueDepth: 1,
        allowActiveAbort: true,
      });
      void pending.catch(() => {});
      return pending;
    };
    const clearRun = () => {
      prepared?.subscription.unsubscribe();
      if (prepared) {
        clearActiveEmbeddedRun(attempt.sessionId, prepared.queueHandle, attempt.sessionKey);
      }
    };
    try {
      const admittedRunContext = await admission.admit("embedded", "watchdog-custody");
      await withPreparedEmbeddedRunToolAuthority(
        { admittedRunContext, replyOperation: operation },
        execution,
        undefined,
        async (ownedAttempt) => {
          const controls = lane.createAttemptControls({ admittedRunContext });
          const nativeAbort = createEmbeddedAttemptRunAbort({
            abortActiveSession: tracker.abortActiveSession,
            activeSession: session,
            attempt: { ...attempt, onAttemptTimeout: controls.onAttemptTimeout },
            getQueueHandle: () => prepared?.queueHandle,
            isProbeSession: false,
            log: { warn: () => {} },
            runAbortController: controller,
            state,
          });
          idleInterrupt = createEmbeddedAttemptIdleInterruption({
            runAbortController: controller,
            activeSession: session,
            state,
            abortRun: nativeAbort,
          });
          prepared = prepareCatalogExecutor({
            activeSession: session,
            sessionManager: manager,
            diagnosticOwner,
            attempt: {
              ...ownedAttempt,
              abortSignal: controls.abortSignal,
              replyOperation: operation,
              onAttemptAbort: controls.onAttemptAbort,
            },
            sessionKey: attempt.sessionKey,
            replyOperation: operation,
            streamReplies: false,
            runAbortController: controller,
            abortRun: nativeAbort,
            recoverStalledModelCall: () =>
              streamGuards.isModelCallActive() &&
              idleInterrupt?.(
                new Error("LLM idle timeout (diagnostic stuck recovery): no response from model"),
              ) === true,
            markExternalAbort: () => {
              state.terminal = mergeAgentRunAttemptTerminal(state.terminal, {
                kind: "aborted",
                source: "external",
              });
            },
            getRunState: () => ({
              ...projectAgentRunAttemptTerminal(state.terminal),
              yieldDetected: false,
            }),
          });
          active = lane.enqueueSession(async () => {
            try {
              prompt = tracker.trackPromptSettlePromise(session.prompt(execution.prompt));
              promptSettled = observeSettlement(prompt);
              void prompt.catch(() => {});
              await abortable(controller.signal, prompt).catch(() => {});
              await tracker.buildAbortSettlePromise();
              await releaseParent.promise;
            } finally {
              controls.close();
              operation.complete();
            }
          });
          void active.catch(() => {});
          const activeSettled = observeSettlement(active);
          await enteredProvider.promise;
          await waitForDiagnosticEventsDrained();
          // Qualification comes from the production stream diagnostic wrapper.
          expect(getDiagnosticSessionActivitySnapshot(attempt)).toMatchObject({
            activeWorkKind: "model_call",
          });
          const queuedStarted = vi.fn(async () => {});
          queued = enqueueCommandInLane(laneName, queuedStarted);
          vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
          logSessionStateChange({
            sessionId: attempt.sessionId,
            sessionKey: attempt.sessionKey,
            state: "processing",
          });
          recovery = requestRecovery();
          await Promise.race([
            providerAborted.promise,
            recovery.then((outcome) => {
              throw new Error(
                `Watchdog did not interrupt the provider: ${JSON.stringify(outcome)}`,
              );
            }),
          ]);
          await nextTurn();
          const expectCustody = () =>
            expect
              .soft([
                operation.result,
                operation.abortSignal.aborted,
                lane.abortSignal.aborted,
                controls.isCurrent(),
              ])
              .toEqual([null, false, false, true]);
          expectCustody();
          expect(activeSettled()).toBe(false);
          expect(queuedStarted).not.toHaveBeenCalled();
          vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
          repeatedRecovery = requestRecovery();
          await nextTurn();
          expectCustody();
          expect(queuedStarted).not.toHaveBeenCalled();
          if (ending === "caller cancellation") {
            expect(operation.abortByUser()).toBe(true);
            expect(prepared.queueHandle.recoverStalledModelCall?.()).toBe(false);
            expect(operation.abortSignal.aborted).toBe(true);
            expect(lane.abortSignal.aborted).toBe(true);
          }
          if (ending === "reclamation") {
            await vi.advanceTimersByTimeAsync(EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS - 1);
            expect(lane.abortSignal.aborted).toBe(false);
            expect(queuedStarted).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            await expect(active).rejects.toMatchObject({ name: "CommandLaneTaskTimeoutError" });
            await queued;
            expect(queuedStarted).toHaveBeenCalledOnce();
            expect(lane.abortSignal.aborted).toBe(true);
            expect(controls.isCurrent()).toBe(false);
            expect(prepared.queueHandle.recoverStalledModelCall?.()).toBe(false);
            // Releasing queue capacity does not certify physical producer settlement.
            expect(promptSettled()).toBe(false);
            expect(operation.result).toBeNull();
          }
          releaseProvider.resolve();
          releaseRawProvider?.();
          await Promise.allSettled([prompt, tracker.buildAbortSettlePromise()]);
          releaseParent.resolve();
          await active.catch(() => {});
          await recovery;
          await repeatedRecovery;
          await queued;
          clearRun();
          expect(prepared.queueHandle.recoverStalledModelCall?.()).toBe(false);
        },
      );
    } finally {
      releaseProvider.resolve();
      releaseRawProvider?.();
      releaseParent.resolve();
      await Promise.allSettled([active, prompt, recovery, repeatedRecovery, queued]);
      clearRun();
      operation.complete();
      admission.close();
      stopDiagnosticRunActivityTracking();
      setDiagnosticsEnabledForProcess(false);
      vi.useRealTimers();
      embeddedRecoveryTesting.resetActiveEmbeddedRuns();
      replyRecoveryTesting.resetReplyRunRegistry();
      resetCommandQueueStateForTest();
      resetDiagnosticStateForTest();
      resetDiagnosticEventsForTest();
    }
  },
);
