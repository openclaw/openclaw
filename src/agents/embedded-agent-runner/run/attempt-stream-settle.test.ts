// Settlement liveness: a wedged block-reply flush must not park the turn.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshot } from "../../../config/plugin-auto-enable.test-helpers.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { emitAgentEvent } from "../../../infra/agent-events.js";
import { withPluginRuntimeGenerationScope } from "../../../plugins/runtime/generation-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { closeOpenClawAgentDatabasesAsync } from "../../../state/openclaw-agent-db.js";
import { runOpenClawAgentWorkerWrite } from "../../../state/openclaw-agent-write-admission.js";
import { closeOpenClawStateDatabaseAsync } from "../../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { prepareTaskRegistryRead } from "../../../tasks/task-registry-read.js";
import { createTaskFixture } from "../../../tasks/task-registry.test-support.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { holdStateDatabaseCoordinator } from "../../../test-utils/state-database-contention.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { SessionManager } from "../../sessions/index.js";
import { readLastCacheTtlTimestamp } from "../cache-ttl.js";
import { log } from "../logger.js";
import {
  clearEmbeddedSessionPromptStates,
  createToolResultPromptProjectionState,
  getEmbeddedSessionPromptState,
  persistToolResultProjections,
  serializeCacheTtlToolResultProjections,
} from "../session-prompt-state.js";
import { restoreCacheTtlToolResultProjections } from "../tool-result-truncation.js";
import { RUN_LIVENESS_JOIN_TIMEOUT_MS } from "./abortable.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";
import { settleEmbeddedAttemptStream } from "./attempt-stream-settle.js";
import { prepareEmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle-prepare.js";

type SettleInput = Parameters<typeof settleEmbeddedAttemptStream>[0];

function createSettleFixture(overrides?: Partial<SettleInput>): SettleInput {
  const sessionManager = SessionManager.inMemory();
  const runAbortDeadlineAtMs = Date.now() + 600_000;
  return {
    attempt: {
      runId: "run-settle-1",
      sessionId: "sess-settle-1",
      sessionKey: "agent:main:test",
      provider: "openai",
      modelId: "gpt-5.6-luna",
      model: { api: "openai-responses" },
      config: {},
      promptCacheKey: undefined,
    },
    activeSession: {
      sessionId: "sess-settle-1",
      isCompacting: false,
      isStreaming: false,
      messages: [],
    },
    sessionManager,
    toolResultPromptProjectionState: createToolResultPromptProjectionState(),
    withOwnedTranscriptWrite: async (operation: () => unknown) => await operation(),
    subscription: {
      toolMetas: [],
      waitForCompactionRetry: async () => {},
      isCompactionInFlight: () => false,
      getCompactionCount: () => 0,
      getCurrentAttemptAssistant: () => undefined,
      getUsageTotals: () => undefined,
      getLastAssistantUsage: () => undefined,
    },
    state: {
      promptError: null,
      promptErrorSource: null,
      yieldAborted: false,
      sessionIdUsed: "sess-settle-1",
    },
    readLifecycleState: () => ({
      aborted: false,
      timedOut: false,
      timedOutDuringCompaction: false,
    }),
    markTimedOutDuringCompaction: vi.fn(),
    getRunAbortDeadlineAtMs: () => runAbortDeadlineAtMs,
    runAbortSignal: new AbortController().signal,
    isProbeSession: true,
    abortable: async <T>(promise: Promise<T>) => await promise,
    prePromptMessageCount: 0,
    nestedToolActivities: [],
    cache: {
      retention: undefined,
    },
    shouldFlushForContextEngine: false,
    ...overrides,
  } as unknown as SettleInput;
}

describe("settleEmbeddedAttemptStream liveness", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    { withMetadata: true, timedOut: false },
    { withMetadata: false, timedOut: false },
    { withMetadata: true, timedOut: true },
  ])(
    "settles cancellation while task persistence is held, metadata=$withMetadata timeout=$timedOut",
    async ({ withMetadata, timedOut }) => {
      await withOpenClawTestState({ layout: "split" }, async (state) => {
        const sessionKey = "agent:main:cron:settle:run:private-cancel";
        const task = createTaskFixture("subagent", {
          runId: "private-stream-cancel",
          task: "Private stream cancellation proof",
          ownerKey: sessionKey,
          requesterSessionKey: sessionKey,
          taskKind: "image_generation",
          childSessionKey: "agent:main:subagent:private-stream-cancel",
          notifyPolicy: "silent",
          deliveryStatus: "not_applicable",
        });
        await prepareTaskRegistryRead();
        const context = captureOpenClawStateWorkerContext();
        expect(context.admission.databasePath.startsWith(state.stateDir)).toBe(true);
        const holder = holdStateDatabaseCoordinator(
          context.admission.databasePath,
          context.coordinatorRuntime,
          300,
        );
        const controller = new AbortController();
        const input = createSettleFixture({
          runAbortSignal: controller.signal,
          readLifecycleState: () => ({
            aborted: controller.signal.aborted,
            timedOut: timedOut && controller.signal.aborted,
            timedOutDuringCompaction: false,
          }),
        });
        input.attempt.sessionKey = sessionKey;
        input.subscription.toolMetas = withMetadata
          ? [{ toolName: "image_generate", asyncStarted: true, asyncTaskRunId: task.runId }]
          : [];
        let settlement: ReturnType<typeof settleEmbeddedAttemptStream> | undefined;
        try {
          await holder.ready;
          emitAgentEvent({
            runId: task.runId!,
            stream: "lifecycle",
            data: { phase: "end", endedAt: task.createdAt + 1 },
          });
          settlement = settleEmbeddedAttemptStream(input);
          await setImmediate();
          controller.abort();
          const result = await settlement;
          expect(result.promptError).toBeNull();
          expect(result.sessionIdUsed).toBe("sess-settle-1");
          expect(
            Atomics.load(holder.released, 0),
            "full cancellation settlement must finish before coordinator release",
          ).toBe(0);
          holder.release();
          const read = await prepareTaskRegistryRead();
          expect(read?.getTaskById(task.taskId)).toMatchObject({ status: "succeeded" });
        } finally {
          holder.release();
          await holder.joined;
          await Promise.allSettled([settlement]);
          await closeOpenClawStateDatabaseAsync();
        }
      });
    },
  );

  it("settles past a held block-reply flush", async () => {
    vi.useFakeTimers();
    // A wedged delivery lane (including the supported blockReplyTimeoutMs: 0
    // path) previously parked settlement until the 48h run budget.
    const release = createDeferredCore();
    const input = createSettleFixture({ onBlockReplyFlush: () => release.promise });

    let settled = false;
    const settle = settleEmbeddedAttemptStream(input).then((result) => {
      settled = true;
      return result;
    });
    try {
      await vi.advanceTimersByTimeAsync(RUN_LIVENESS_JOIN_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await settle;
      expect(result.sessionIdUsed).toBe("sess-settle-1");
    } finally {
      release.resolve();
      await settle;
    }
  });

  it("keeps the last request observation separate from billing totals", async () => {
    const input = createSettleFixture();
    input.subscription.getUsageTotals = () => ({ input: 300, cacheRead: 30_000 });
    input.subscription.getLastAssistantUsage = () => ({ input: 100, cacheRead: 10_000 });
    input.cache = {
      ...input.cache,
      getObservation: () => ({
        requestIndex: 3,
        broke: false,
        input: 100,
        cacheRead: 10_000,
        cacheWrite: 0,
        previousCacheRead: 10_000,
        changes: null,
      }),
    };
    const result = await settleEmbeddedAttemptStream(input);
    expect(result.attemptUsage?.cacheRead).toBe(30_000);
    expect(result.promptCache?.observation).toMatchObject({
      broke: false,
      cacheRead: 10_000,
      previousCacheRead: 10_000,
    });
  });

  it("settles normally when the flush resolves", async () => {
    const flushed = vi.fn(async () => {});
    const input = createSettleFixture({
      onBlockReplyFlush: flushed,
    } as Partial<SettleInput>);
    const result = await settleEmbeddedAttemptStream(input);
    expect(flushed).toHaveBeenCalledWith({ reason: "pre_compaction", attemptAccepted: false });
    expect(result.sessionIdUsed).toBe("sess-settle-1");
  });

  it.each([
    "active provider failure",
    "aborted before settlement",
    "aborted during admission",
    "storage failure",
  ] as const)("records prompt errors only while its writer is live: %s", async (scenario) => {
    await withOpenClawTestState({ label: "prompt-error-settle" }, async (state) => {
      const target = {
        agentId: "main",
        sessionId: "prompt-error-settle",
        sessionKey: "agent:main:prompt-error-settle",
        storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
      };
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      const sessionManager = SessionManager.open(target, state.workspaceDir);
      sessionManager.appendMessage({ role: "user", content: "test prompt", timestamp: 1 });
      const originalEntries = sessionManager.getEntries();
      const controller = new AbortController();
      const promptError = new Error("synthetic provider failure");
      const assistant = createAssistant(
        testModel,
        [{ type: "text", text: "partial reply" }],
        "error",
      );
      const usage = { input: 100, output: 20 };
      const input = createSettleFixture({
        sessionManager,
        runAbortSignal: controller.signal,
        readLifecycleState: () => ({
          aborted: controller.signal.aborted,
          timedOut: false,
          timedOutDuringCompaction: false,
        }),
      });
      input.activeSession.messages.push(assistant);
      input.subscription.getUsageTotals = () => usage;
      input.attempt = {
        ...input.attempt,
        ...target,
        sessionTarget: target,
        sessionManager,
        abortSignal: controller.signal,
      };
      input.state = {
        ...input.state,
        promptError,
        promptErrorSource: "prompt",
        sessionIdUsed: target.sessionId,
      };
      const prepared = await prepareEmbeddedAttemptTranscriptLifecycle({
        attempt: input.attempt,
        externalAbortController: {
          arm: () => {},
          throwIfFiredAfterPrepCleanup: async () => controller.signal.throwIfAborted(),
        },
      });
      input.withOwnedTranscriptWrite = prepared.withOwnedTranscriptWrite;
      const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
      const append =
        scenario === "storage failure"
          ? vi.spyOn(sessionManager, "appendCustomEntry").mockImplementation(() => {
              throw new Error("synthetic storage failure");
            })
          : undefined;
      const entered = createDeferredCore();
      const release = createDeferredCore();
      let heldWriter: Promise<void> | undefined;
      let settlement: ReturnType<typeof settleEmbeddedAttemptStream> | undefined;
      try {
        if (scenario === "aborted before settlement") {
          controller.abort();
        } else if (scenario === "aborted during admission") {
          heldWriter = runOpenClawAgentWorkerWrite(
            { agentId: target.agentId, path: target.storePath },
            async () => {
              entered.resolve();
              await release.promise;
            },
          );
          await entered.promise;
        }
        let settled = false;
        settlement = settleEmbeddedAttemptStream(input).then((result) => {
          settled = true;
          return result;
        });
        if (heldWriter) {
          await setImmediate();
          expect(settled).toBe(false);
          controller.abort(new Error("synthetic cancellation"));
          release.resolve();
          await heldWriter;
        }
        const result = await settlement;
        expect(result.promptError).toBe(promptError);
        expect(result.promptErrorSource).toBe("prompt");
        expect(result.messagesSnapshot).toEqual([assistant]);
        expect(result.currentAttemptAssistant).toBe(assistant);
        expect(result.attemptUsage).toEqual(usage);
        const entries = SessionManager.open(target, state.workspaceDir).getEntries();
        if (scenario === "active provider failure") {
          expect(entries).toHaveLength(originalEntries.length + 1);
          expect(entries.at(-1)).toMatchObject({
            type: "custom",
            customType: "openclaw:prompt-error",
            data: { error: "synthetic provider failure", runId: input.attempt.runId },
          });
        } else {
          expect(entries).toEqual(originalEntries);
        }
        if (scenario === "storage failure") {
          expect(warn).toHaveBeenCalledExactlyOnceWith(
            "failed to persist prompt error entry: Error: synthetic storage failure",
          );
        } else {
          expect(warn).not.toHaveBeenCalled();
        }
      } finally {
        release.resolve();
        await Promise.allSettled([heldWriter, settlement]);
        await prepared.transcriptLifecycle.dispose();
        append?.mockRestore();
        warn.mockRestore();
      }
    });
  });

  it("persists the active projection after session-state eviction", async () => {
    const sessionId = "cache-ttl-settle-evicted";
    const otherSessionIds = Array.from({ length: 65 }, (_, index) => `cache-ttl-other-${index}`);
    const state = getEmbeddedSessionPromptState(sessionId).toolResults;
    const key = "tool:old-read:42";
    state.replacements.set(key, {
      content: [{ type: "text", text: "kept prefix\n...\nkept suffix" }],
      cacheTtl: "soft",
    });
    state.sourceHashByKey.set(key, "original-source-hash");
    state.frozen.add(key);
    const input = {
      ...createSettleFixture(),
      toolResultPromptProjectionState: state,
    };
    input.attempt = {
      ...input.attempt,
      sessionId,
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      model: { ...input.attempt.model, api: "anthropic-messages" },
      config: { agents: { defaults: { contextPruning: { mode: "cache-ttl" } } } },
    };
    try {
      for (const otherSessionId of otherSessionIds) {
        getEmbeddedSessionPromptState(otherSessionId);
      }
      expect(getEmbeddedSessionPromptState(sessionId).toolResults).not.toBe(state);

      // Production supplies this generation before entering the attempt runner.
      const metadataSnapshot = createPluginMetadataSnapshot({
        config: input.attempt.config,
        manifestRegistry: { plugins: [], diagnostics: [] },
      });
      await withPluginRuntimeGenerationScope({ metadataSnapshot }, () =>
        settleEmbeddedAttemptStream(input),
      );

      expect(input.sessionManager.getEntries()).toContainEqual(
        expect.objectContaining({
          type: "custom",
          customType: "openclaw.cache-ttl",
          data: expect.objectContaining({
            prunedToolResults: [{ key, mode: "soft" }],
          }),
        }),
      );
    } finally {
      clearEmbeddedSessionPromptStates([sessionId, ...otherSessionIds]);
    }
  });
});

describe("attempt projection persistence through settlement", () => {
  registerAgentSessionLoopTestLifecycle();

  it("keeps one snapshot across unchanged dispatch, TTL settlement, and reopen", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-projection-settle-"));
    const scope = {
      agentId: "main",
      sessionId: "projection-settle",
      sessionKey: "agent:main:projection-settle",
      storePath: path.join(dir, "sessions.json"),
    };
    const model = { ...testModel, provider: "anthropic", id: "claude-sonnet-4-6" };
    try {
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      let manager = SessionManager.open(scope, dir);
      manager.appendMessage({ role: "user", content: "read file", timestamp: 1 });
      manager.appendMessage(
        createAssistant(
          model,
          [{ type: "toolCall", id: "read-1", name: "read", arguments: {} }],
          "toolUse",
        ),
      );
      const toolResult = {
        role: "toolResult" as const,
        toolCallId: "read-1",
        toolName: "read",
        content: [{ type: "text" as const, text: "x".repeat(6_000) }],
        isError: false,
        timestamp: 2,
      };
      manager.appendMessage(toolResult);
      manager.appendMessage(createAssistant(model, [{ type: "text", text: "read complete" }]));
      let previousSnapshot: ReturnType<typeof serializeCacheTtlToolResultProjections> | undefined;
      for (let turn = 0; turn < 3; turn++) {
        const sessionPromptState = getEmbeddedSessionPromptState(scope.sessionId);
        const projectionState = sessionPromptState.toolResults;
        restoreCacheTtlToolResultProjections(projectionState, manager.getBranch());
        if (previousSnapshot) {
          expect(serializeCacheTtlToolResultProjections(projectionState)).toEqual(previousSnapshot);
        }
        const { session } = await createTestSession({ sessionManager: manager, model });
        const input = createSettleFixture({
          activeSession: session,
          sessionManager: manager,
          toolResultPromptProjectionState: projectionState,
        });
        input.attempt = {
          ...input.attempt,
          sessionId: scope.sessionId,
          provider: model.provider,
          modelId: model.id,
          config: { agents: { defaults: { contextPruning: { mode: "cache-ttl" } } } },
        };
        const markers = () =>
          manager
            .getBranch()
            .filter(
              (entry) => entry.type === "custom" && entry.customType === "openclaw.cache-ttl",
            );
        const snapshotMarkers = () =>
          markers().filter(
            (entry) =>
              entry.type === "custom" && Object.hasOwn(entry.data as object, "frozenToolResults"),
          );
        session.agent.streamFn = () => {
          expect(snapshotMarkers()).toHaveLength(1);
          return createAssistantResultStream(
            createAssistant(model, [{ type: "text", text: "done" }]),
          );
        };
        await submitEmbeddedAttemptPrompt({
          attempt: input.attempt,
          activeSession: session,
          contextTokenBudget: 8_000,
          images: [],
          modelPrompt: "continue",
          onFinalPromptText: () => {},
          onSteeringAcknowledged: () => {},
          persistToolResultProjections: async () => {
            persistToolResultProjections(projectionState, (customType, data) =>
              manager.appendCustomEntry(customType, data),
            );
          },
          promptActiveSession: (prompt, options) => session.prompt(prompt, options),
          runtimeOnly: false,
          sessionPromptState,
          systemPrompt: "test prompt",
          toolResultAggregateMaxChars: 8_000,
          toolResultMaxChars: 4_000,
          toolResultPromptProjectionState: projectionState,
          trajectoryRecorder: null,
          transcriptLeafId: null,
          transcriptPrompt: "continue",
        });
        const metadataSnapshot = createPluginMetadataSnapshot({
          config: input.attempt.config,
          manifestRegistry: { plugins: [], diagnostics: [] },
        });
        await withPluginRuntimeGenerationScope({ metadataSnapshot }, () =>
          settleEmbeddedAttemptStream(input),
        );
        expect(snapshotMarkers()).toHaveLength(1);
        expect(markers()).toHaveLength(turn + 2);
        const touch = markers().at(-1);
        expect(touch?.type === "custom" && touch.data).toEqual({
          timestamp: expect.any(Number),
          provider: model.provider,
          modelId: model.id,
        });
        expect(
          readLastCacheTtlTimestamp(manager, { provider: model.provider, modelId: model.id }),
        ).toBe(touch?.type === "custom" && (touch.data as { timestamp: number }).timestamp);
        expect(manager.getBranch()).toContainEqual(
          expect.objectContaining({ type: "message", message: toolResult }),
        );
        previousSnapshot = serializeCacheTtlToolResultProjections(projectionState);
        expect(previousSnapshot.frozenToolResults[0]?.texts?.[0]?.length).toBeLessThan(6_000);
        session.dispose();
        manager.flushPendingPersistence();
        clearEmbeddedSessionPromptStates([scope.sessionId]);
        manager = SessionManager.open(scope, dir);
      }
    } finally {
      clearEmbeddedSessionPromptStates([scope.sessionId]);
      await closeOpenClawAgentDatabasesAsync(dir);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
