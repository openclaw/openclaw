import { realpathSync } from "node:fs";
import path from "node:path";
import type { OpenAIResponsesCompactionRejection } from "@openclaw/ai/transports";
import {
  createAssistantMessageEventStream,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
} from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { CliPluginInvocationResources } from "../../../cli/plugin-invocation-resources.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../../../config/sessions/session-accessor.sqlite-scope.js";
import { createDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import { createDiagnosticEmbeddedRunOwner } from "../../../logging/diagnostic-run-activity.js";
import { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { runOpenClawAgentWorkerWrite } from "../../../state/openclaw-agent-write-admission.js";
import { createAgentCleanupScope } from "../../run-cleanup-timeout.js";
import type { StreamFn } from "../../runtime/index.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import {
  createAssistant,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { convertToLlm } from "../../sessions/messages.js";
import { SessionManager } from "../../sessions/session-manager.js";
import type { EmbeddedAttemptExecutionPhaseInput } from "./attempt-execution-types.js";
import {
  cleanupEmbeddedAttemptSessionPhase,
  createEmbeddedAttemptSessionSettleTracker,
} from "./attempt-session-settle.js";
import { installEmbeddedAttemptStreamGuards } from "./attempt-stream.js";
import { createEmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
registerAgentSessionLoopTestLifecycle();
const checkpoint: OpenAIResponsesCompactionRejection = {
  data: "synthetic-rejected-checkpoint",
  id: "synthetic-checkpoint",
};
type ReplayOptions = NonNullable<Parameters<StreamFn>[2]> & {
  onCompactionRejected?: (rejected: OpenAIResponsesCompactionRejection) => void;
};

afterEach(() => {
  vi.useRealTimers();
  closeOpenClawAgentDatabasesForTest();
});

const nextTurn = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

function observeSettlement<T>(promise: Promise<T>) {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return () => settled;
}

async function createFixture(
  provider: StreamFn,
  options: {
    withSessionWriteSettlement?: NonNullable<
      Parameters<typeof createTestSession>[0]
    >["withSessionWriteSettlement"];
    toolNames?: string[];
    thinkingRecovery?: boolean;
  } = {},
) {
  const model = options.thinkingRecovery
    ? { ...testModel, api: "anthropic-messages", provider: "anthropic", id: "synthetic-anthropic" }
    : testModel;
  const root = realpathSync(tempDirs.make("openclaw-stream-custody-"));
  const target = {
    agentId: "main",
    sessionId: "stream-custody",
    sessionKey: "agent:main:stream-custody",
    storePath: path.join(root, "agents", "main", "sessions", "sessions.json"),
  };
  await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: Date.now() });
  const manager = SessionManager.open(target, root);
  manager.appendMessage({ role: "user", content: "Synthetic history", timestamp: 1 });
  manager.appendMessage({
    ...createAssistant(model, [
      ...(options.thinkingRecovery
        ? [
            {
              type: "thinking" as const,
              thinking: "Synthetic historical reasoning",
              thinkingSignature: "c3ludGhldGljLXNpZ25hdHVyZQ==",
            },
          ]
        : []),
      { type: "text", text: "Synthetic checkpoint owner" },
    ]),
    ...(!options.thinkingRecovery
      ? {
          providerReplay: {
            v: 1,
            type: "openai-responses-compaction",
            ...checkpoint,
            replayIndex: 0,
            provider: model.provider,
            api: model.api,
            model: model.id,
            baseUrlHash: "synthetic",
          },
        }
      : {}),
  });
  const checkpointPresent = () =>
    manager
      .getBranch()
      .some(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "assistant" &&
          entry.message.providerReplay?.data === checkpoint.data,
      );
  const thinkingPresent = () =>
    manager
      .getBranch()
      .some(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "assistant" &&
          entry.message.content.some((block) => block.type === "thinking"),
      );
  const replayPresent = options.thinkingRecovery ? thinkingPresent : checkpointPresent;
  expect(replayPresent(), "fixture replay must survive durable append").toBe(true);
  const controller = new AbortController();
  const sdkSession = options.withSessionWriteSettlement
    ? (
        await createTestSession({
          sessionManager: manager,
          model,
          withSessionWriteSettlement: options.withSessionWriteSettlement,
        })
      ).session
    : undefined;
  const activeSession = sdkSession ?? {
    agent: { streamFn: provider },
    sessionId: target.sessionId,
    messages: manager.buildSessionContext().messages,
  };
  activeSession.agent.streamFn = provider;
  const repaired = vi.fn();
  const previousNotification = vi.fn();
  // Only preparation facts are supplied here; the installed stream, persistence,
  // cancellation, and work owners remain the production implementations.
  const input = {
    attempt: {
      config: {},
      model,
      modelId: model.id,
      provider: model.provider,
      runId: "stream-custody-run",
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      timeoutMs: 120_000,
    },
    runAbortController: controller,
    prepared: {
      sessionRuntime: {
        agentSession: { activeSession },
        sessionManager: manager,
        contextGuards: { recordCacheTouch: () => {} },
        isOpenAIResponsesApi: !options.thinkingRecovery,
        state: { systemPromptText: "Synthetic system prompt" },
        transcriptPolicy: options.thinkingRecovery ? { preserveSignatures: true } : {},
        transport: { effectiveAgentTransport: "sse" },
      },
      toolCatalog: {
        toolSearchRunPlan: {
          liveAllowedToolNames: new Set(options.toolNames),
          replayAllowedToolNames: new Set(options.toolNames),
        },
      },
    },
    setup: { sessionAgentId: "main" },
    diagnostics: { runTrace: createDiagnosticTraceContext() },
    lifecycle: { readYieldState: () => ({ yieldDetected: false }) },
  } as unknown as EmbeddedAttemptExecutionPhaseInput;
  installEmbeddedAttemptStreamGuards(input, {
    onRejectedProviderReplayRepaired: repaired,
    onIdleTimeout: () => {},
    diagnosticOwner: createDiagnosticEmbeddedRunOwner({
      runId: input.attempt.runId,
      sessionId: target.sessionId,
    }),
  });
  expect(replayPresent(), "fixture preparation must retain replay").toBe(true);
  const streamOptions: ReplayOptions = {
    signal: controller.signal,
    onCompactionRejected: previousNotification,
  };
  return {
    controller,
    manager,
    session: sdkSession,
    attempt: input.attempt,
    repaired,
    previousNotification,
    open: () =>
      activeSession.agent.streamFn(
        model,
        { messages: convertToLlm(activeSession.messages) },
        streamOptions,
      ),
    checkpointPresent,
    thinkingPresent,
    async holdWriter() {
      const entered = createDeferred();
      const release = createDeferred();
      const managerTarget = manager.getSessionTarget();
      if (!managerTarget) {
        throw new Error("Fixture manager lost its durable target");
      }
      expect(
        resolveOpenClawAgentSqlitePath(toDatabaseOptions(resolveSqliteReadScope(target))),
      ).toBe(
        resolveOpenClawAgentSqlitePath(toDatabaseOptions(resolveSqliteReadScope(managerTarget))),
      );
      const work = runOpenClawAgentWorkerWrite(
        toDatabaseOptions(resolveSqliteReadScope(target)),
        async () => {
          entered.resolve();
          await release.promise;
        },
      );
      await entered.promise;
      return { release: release.resolve, work };
    },
  };
}

describe("installed replay repair ownership", () => {
  it("closes a partial-only thinking stream without waiting for ordinary provider completion", async () => {
    const source = createAssistantMessageEventStream();
    const fixture = await createFixture(
      (model) => {
        source.push({
          type: "start",
          partial: createAssistant(model, [{ type: "text", text: "Synthetic partial" }]),
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
      const drained = observeSettlement(draining);
      await nextTurn();
      // Closing the consumer does not certify that the actual provider pump ended.
      expect(drained()).toBe(false);
      source.end(
        createAssistant(fixture.attempt.model, [{ type: "text", text: "Synthetic completion" }]),
      );
      await draining;
    } finally {
      source.end(createAssistant(fixture.attempt.model, []));
      await Promise.allSettled([returned, draining]);
      await work.drain();
    }
  });

  describe.each(["request-rejection", "stream-rejection"] as const)(
    "thinking recovery after %s",
    (failureMode) => {
      it.each(["event", "concurrent-results", "return-before-next"] as const)(
        "keeps %s behind the admitted thinking repair",
        async (boundary) => {
          let requests = 0;
          const fixture = await createFixture(
            (model) => {
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
                  message: createAssistant(model, [
                    { type: "text", text: "Synthetic recovered response" },
                  ]),
                });
              }
              return stream;
            },
            { thinkingRecovery: true },
          );
          const held = await fixture.holdWriter();
          const pending: Promise<unknown>[] = [];
          let iterator: AsyncIterator<AssistantMessageEvent> | undefined;
          try {
            const response = await fixture.open();
            iterator = response[Symbol.asyncIterator]();
            if (boundary === "concurrent-results") {
              pending.push(response.result(), response.result());
            } else {
              pending.push(
                boundary === "event" ? iterator.next() : Promise.resolve(iterator.return?.()),
              );
            }
            const settled = pending.map(observeSettlement);
            await nextTurn();
            expect(requests).toBe(2);
            expect(fixture.thinkingPresent()).toBe(true);
            expect(settled.map((read) => read())).toEqual(pending.map(() => false));
            held.release();
            await Promise.all(pending);
            expect(fixture.thinkingPresent()).toBe(false);
            expect(fixture.repaired).toHaveBeenCalledOnce();
          } finally {
            held.release();
            await Promise.allSettled([held.work, ...pending]);
            await iterator?.return?.();
          }
        },
      );
    },
  );

  it.each([
    { boundary: "event", tools: false },
    { boundary: "result", tools: false },
    { boundary: "completion", tools: false },
    { boundary: "return-before-next", tools: false },
    { boundary: "return-before-next", tools: true },
  ] as const)(
    "keeps $boundary behind the admitted transcript repair (tools=$tools)",
    async ({ boundary, tools }) => {
      const final = createAssistant(testModel, [{ type: "text", text: "Synthetic response" }]);
      const fixture = await createFixture(
        (_model, _context, options) => {
          (options as ReplayOptions).onCompactionRejected?.(checkpoint);
          const stream = createAssistantMessageEventStream();
          if (boundary === "completion") {
            stream.end(final);
          } else {
            stream.push({ type: "done", reason: "stop", message: final });
          }
          return stream;
        },
        { toolNames: tools ? ["read"] : [] },
      );
      const held = await fixture.holdWriter();
      let pending: Promise<unknown> | undefined;
      try {
        const response = await fixture.open();
        const iterator = response[Symbol.asyncIterator]();
        pending =
          boundary === "result"
            ? response.result()
            : boundary === "return-before-next"
              ? Promise.resolve(iterator.return?.())
              : iterator.next();
        const settled = observeSettlement(pending);
        await nextTurn();
        expect(fixture.checkpointPresent()).toBe(true);
        expect(fixture.previousNotification).toHaveBeenCalledExactlyOnceWith(checkpoint);
        expect(settled()).toBe(false);
        held.release();
        await pending;
        expect(fixture.checkpointPresent()).toBe(false);
        expect(fixture.repaired).toHaveBeenCalledOnce();
        await iterator.return?.();
      } finally {
        held.release();
        await Promise.allSettled([held.work, pending]);
      }
    },
  );

  it("retains rejected stream setup until its notified repair settles", async () => {
    const setupError = new Error("Synthetic provider setup failed");
    const fixture = await createFixture((_model, _context, options) => {
      (options as ReplayOptions).onCompactionRejected?.(checkpoint);
      return Promise.reject(setupError);
    });
    const held = await fixture.holdWriter();
    const pending = Promise.resolve(fixture.open());
    const settled = observeSettlement(pending);
    try {
      await nextTurn();
      expect(settled()).toBe(false);
      held.release();
      await expect(pending).rejects.toBe(setupError);
      expect(fixture.checkpointPresent()).toBe(false);
    } finally {
      held.release();
      await Promise.allSettled([held.work, pending]);
    }
  });

  it("owns late stream creation after caller cancellation without publishing a repair", async () => {
    const source = createDeferred<AssistantMessageEventStream>();
    const fixture = await createFixture((_model, _context, options) => {
      (options as ReplayOptions).onCompactionRejected?.(checkpoint);
      return source.promise;
    });
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
      const drained = observeSettlement(draining);
      await nextTurn();
      expect(drained()).toBe(false);
      const late = createAssistantMessageEventStream();
      late.end(createAssistant(testModel, [{ type: "text", text: "Late response" }]));
      source.resolve(late);
      await nextTurn();
      expect(drained()).toBe(false);
      held.release();
      await draining;
      expect(fixture.checkpointPresent()).toBe(true);
      expect(fixture.repaired).not.toHaveBeenCalled();
    } finally {
      held.release();
      const late = createAssistantMessageEventStream();
      late.end(createAssistant(testModel, []));
      source.resolve(late);
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
      const final = createAssistant(testModel, [{ type: "text", text: "Late response" }]);
      const returnSource = vi.fn(() => sourceReturn.promise);
      const fixture = await createFixture(() => ({
        [Symbol.asyncIterator]: () => ({
          next: () => {
            entered.resolve();
            return sourceNext.promise;
          },
          return: returnSource,
        }),
        result: async () => final,
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
        const drained = observeSettlement(draining);
        await nextTurn();
        expect(returnSource).toHaveBeenCalledOnce();
        expect(drained()).toBe(false);
        if (rejectReturn) {
          sourceReturn.reject(returnFailure);
        } else {
          sourceReturn.resolve({ done: true, value: undefined });
        }
        await nextTurn();
        expect(drained()).toBe(false);
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
    const provider = vi.fn(() => {
      const stream = createAssistantMessageEventStream();
      stream.end(createAssistant(testModel, [{ type: "text", text: "Synthetic response" }]));
      return stream;
    });
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
        sessionAgentId: "main",
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
      const released = observeSettlement(release);
      await nextTurn();
      expect(released()).toBe(false);
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
    const final = createAssistant(testModel, [{ type: "text", text: "Native terminal" }]);
    const fixture = await createFixture((_model, _context, options) => {
      (options as ReplayOptions).onCompactionRejected?.(checkpoint);
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message: final });
      return stream;
    });
    const held = await fixture.holdWriter();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let pending: Promise<unknown> | undefined;
    let iterator: AsyncIterator<AssistantMessageEvent> | undefined;
    try {
      const response = await fixture.open();
      iterator = response[Symbol.asyncIterator]();
      pending = iterator.next();
      const settled = observeSettlement(pending);
      await vi.advanceTimersByTimeAsync(120_001);
      expect(settled()).toBe(false);
      held.release();
      await expect(pending).resolves.toMatchObject({ done: false, value: { type: "done" } });
    } finally {
      held.release();
      await Promise.allSettled([held.work, pending]);
      await iterator?.return?.();
    }
  });
});
