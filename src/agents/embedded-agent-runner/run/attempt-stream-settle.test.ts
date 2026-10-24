import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshot } from "../../../config/plugin-auto-enable.test-helpers.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { withPluginRuntimeGenerationScope } from "../../../plugins/runtime/generation-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { createChangeListeners } from "../../../shared/listeners.js";
import { runOpenClawAgentWorkerWrite } from "../../../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  createMediaGenerationOperation,
  findMediaGenerationOperation,
} from "../../media-generation-activity.js";
import { resetGeneratedMediaTaskActivityForTests } from "../../media-generation-activity.test-support.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { SessionManager } from "../../sessions/index.js";
import { serializeCacheTtlToolResultProjections } from "../cache-ttl-checkpoint.js";
import { readLastCacheTtlTimestamp } from "../cache-ttl.js";
import { log } from "../logger.js";
import {
  clearEmbeddedSessionPromptStates,
  createToolResultPromptProjectionState,
  retainEmbeddedSessionPromptState,
  persistToolResultProjections,
} from "../session-prompt-state.js";
import { restoreCacheTtlToolResultProjections } from "../tool-result-truncation.js";
import { RUN_LIVENESS_JOIN_TIMEOUT_MS } from "./abortable.js";
import { createAttemptNestedToolActivityState } from "./attempt-nested-tool-activity.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";
import { settleEmbeddedAttemptStream } from "./attempt-stream-settle.js";
import { prepareEmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle-prepare.js";

type SettleInput = Parameters<typeof settleEmbeddedAttemptStream>[0];

type SettleOverrides = Partial<Omit<SettleInput, "attempt" | "state" | "subscription">> & {
  attempt?: Partial<SettleInput["attempt"]>;
  state?: Partial<SettleInput["state"]>;
  subscription?: Partial<SettleInput["subscription"]>;
};
function createSettleFixture({
  attempt,
  state,
  subscription,
  ...overrides
}: SettleOverrides = {}): SettleInput {
  const sessionId = "sess-settle-1";
  const runAbortDeadlineAtMs = Date.now() + 600_000;
  return {
    attempt: {
      runId: "run-settle-1",
      sessionId,
      sessionKey: "agent:main:test",
      provider: "openai",
      modelId: "gpt-5.6-luna",
      model: { api: "openai-responses" },
      config: {},
      ...attempt,
    },
    activeSession: { sessionId, isCompacting: false, isStreaming: false, messages: [] },
    sessionManager: SessionManager.inMemory(),
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
      ...subscription,
    },
    state: { promptError: null, promptErrorSource: null, yieldAborted: false, ...state },
    readLifecycleState: () => ({
      aborted: overrides.runAbortSignal?.aborted ?? false,
      timedOut: false,
      timedOutDuringCompaction: false,
    }),
    markTimedOutDuringCompaction: vi.fn(),
    getRunAbortDeadlineAtMs: () => runAbortDeadlineAtMs,
    onRunAbortDeadlineChanged: () => () => {},
    runAbortSignal: new AbortController().signal,
    isProbeSession: true,
    abortable: async <T>(promise: Promise<T>) => await promise,
    prePromptMessageCount: 0,
    nestedToolActivityState: createAttemptNestedToolActivityState(),
    cache: { retention: undefined },
    shouldFlushForContextEngine: false,
    ...overrides,
  } as unknown as SettleInput;
}

const cacheTtlConfig = { agents: { defaults: { contextPruning: { mode: "cache-ttl" as const } } } };
function settleWithPlugins(input: SettleInput) {
  const metadataSnapshot = createPluginMetadataSnapshot({
    config: input.attempt.config,
    manifestRegistry: { plugins: [], diagnostics: [] },
  });
  return withPluginRuntimeGenerationScope({ metadataSnapshot }, () =>
    settleEmbeddedAttemptStream(input),
  );
}

describe("settleEmbeddedAttemptStream liveness", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles cancellation with active media metadata", async () => {
    resetGeneratedMediaTaskActivityForTests();
    const sessionKey = "agent:main:cron:settle:run:cancel";
    const task = createMediaGenerationOperation({
      taskId: "stream-cancel",
      runId: "stream-cancel",
      task: "Stream cancellation proof",
      requesterSessionKey: sessionKey,
      taskKind: "image_generation",
      status: "running",
    });
    const controller = new AbortController();
    const input = createSettleFixture({
      runAbortSignal: controller.signal,
      attempt: { sessionKey },
      subscription: {
        toolMetas: [{ toolName: "image_generate", asyncStarted: true, asyncTaskRunId: task.runId }],
      },
    });
    const settlement = settleEmbeddedAttemptStream(input);
    try {
      controller.abort();
      const result = await settlement;
      expect(result).toMatchObject({ promptError: null, sessionIdUsed: "sess-settle-1" });
      expect(findMediaGenerationOperation(task.runId!)).toMatchObject({ status: "running" });
    } finally {
      await Promise.allSettled([settlement]);
      resetGeneratedMediaTaskActivityForTests();
    }
  });

  it("uses the updated media deadline while preserving the settlement margin", async () => {
    vi.useFakeTimers();
    resetGeneratedMediaTaskActivityForTests();
    const sessionKey = "agent:main:cron:settle:run:deadline";
    const task = createMediaGenerationOperation({
      taskId: "stream-deadline",
      runId: "stream-deadline",
      requesterSessionKey: sessionKey,
      taskKind: "image_generation",
      status: "running",
    });
    const deadlineChanges = createChangeListeners();
    let deadlineAtMs = Date.now() + 1_500;
    let settled = false;
    const settlement = settleEmbeddedAttemptStream(
      createSettleFixture({
        attempt: { sessionKey },
        getRunAbortDeadlineAtMs: () => deadlineAtMs,
        onRunAbortDeadlineChanged: deadlineChanges.subscribe,
      }),
    ).then((result) => {
      settled = true;
      return result;
    });
    try {
      await vi.advanceTimersByTimeAsync(250);
      deadlineAtMs = Date.now() + 2_000;
      deadlineChanges.publish();
      await vi.advanceTimersByTimeAsync(1_499);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect((await settlement).promptError).toEqual(
        new Error(`Timed out waiting for async task completion: ${task.runId}`),
      );
      expect(findMediaGenerationOperation(task.taskId)?.status).toBe("running");
    } finally {
      await Promise.allSettled([settlement]);
      resetGeneratedMediaTaskActivityForTests();
    }
  });

  it.each([false, true])("settles block-reply flush (held=%s)", async (held) => {
    vi.useFakeTimers();
    const release = createDeferredCore();
    const flushed = vi.fn(() => (held ? release.promise : Promise.resolve()));
    let settled = false;
    const settle = settleEmbeddedAttemptStream(
      createSettleFixture({ onBlockReplyFlush: flushed }),
    ).then((result) => {
      settled = true;
      return result;
    });
    try {
      if (held) {
        await vi.advanceTimersByTimeAsync(RUN_LIVENESS_JOIN_TIMEOUT_MS - 1);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
      }
      expect((await settle).sessionIdUsed).toBe("sess-settle-1");
      expect(flushed).toHaveBeenCalledWith({ reason: "pre_compaction", attemptAccepted: false });
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
        messageCount: 5,
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

  it.each(["active provider failure", "aborted during admission", "storage failure"] as const)(
    "records prompt errors only while its writer is live: %s",
    async (scenario) => {
      await withOpenClawTestState({ label: "prompt-error-settle" }, async (state) => {
        const target = {
          agentId: "main",
          sessionId: "prompt-error-settle",
          sessionKey: "agent:main:prompt-error-settle",
          storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
        };
        await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
        const sessionManager = await SessionManager.openAsync(target, state.workspaceDir);
        await sessionManager.appendMessageAsync({
          role: "user",
          content: "test prompt",
          timestamp: 1,
        });
        const originalEntries = sessionManager.getEntries();
        const controller = new AbortController();
        const promptError = new Error("synthetic provider failure");
        const assistant = createAssistant(testModel, "partial reply", "error");
        const usage = { input: 100, output: 20 };
        const input = createSettleFixture({
          sessionManager,
          runAbortSignal: controller.signal,
          attempt: {
            ...target,
            sessionTarget: target,
            sessionManager,
            abortSignal: controller.signal,
          },
          state: { promptError, promptErrorSource: "prompt" },
          subscription: { getUsageTotals: () => usage },
        });
        input.activeSession.messages.push(assistant);
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
            ? vi
                .spyOn(sessionManager, "appendCustomEntryAsync")
                .mockRejectedValue(new Error("synthetic storage failure"))
            : undefined;
        const entered = createDeferredCore();
        const release = createDeferredCore();
        let heldWriter: Promise<void> | undefined;
        let settlement: ReturnType<typeof settleEmbeddedAttemptStream> | undefined;
        try {
          if (scenario === "aborted during admission") {
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
          expect([result.promptErrorSource, result.messagesSnapshot, result.attemptUsage]).toEqual([
            "prompt",
            [assistant],
            usage,
          ]);
          expect(result.currentAttemptAssistant).toBe(assistant);
          const entries = (await SessionManager.openAsync(target, state.workspaceDir)).getEntries();
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
    },
  );

  it("persists the active projection after session-state invalidation", async () => {
    const sessionId = "cache-ttl-settle-evicted";
    using initialLease = retainEmbeddedSessionPromptState(sessionId);
    const state = initialLease.state.toolResults;
    const key = "tool:old-read:42";
    state.replacements.set(key, {
      content: [{ type: "text", text: "kept prefix\n...\nkept suffix" }],
      cacheTtl: "soft",
    });
    state.sourceHashByKey.set(key, "original-source-hash");
    state.frozen.add(key);
    const input = createSettleFixture({
      toolResultPromptProjectionState: state,
      attempt: {
        sessionId,
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
        config: cacheTtlConfig,
      },
    });
    input.attempt.model = { ...input.attempt.model, api: "anthropic-messages" };
    try {
      clearEmbeddedSessionPromptStates([sessionId]);
      using replacement = retainEmbeddedSessionPromptState(sessionId);
      expect(replacement.state.toolResults).not.toBe(state);
      await settleWithPlugins(input);

      expect(input.sessionManager.getEntries()).toContainEqual(
        expect.objectContaining({
          type: "custom",
          customType: "openclaw.cache-ttl",
          data: expect.objectContaining({ prunedToolResults: [{ key, mode: "soft" }] }),
        }),
      );
    } finally {
      clearEmbeddedSessionPromptStates([sessionId]);
    }
  });
});

describe("attempt projection persistence through settlement", () => {
  registerAgentSessionLoopTestLifecycle();

  it("keeps one snapshot across unchanged dispatch, TTL settlement, and reopen", async () => {
    await withOpenClawTestState({ label: "projection-settle", applyEnv: false }, async (state) => {
      const scope = {
        agentId: "main",
        sessionId: "projection-settle",
        sessionKey: "agent:main:projection-settle",
        storePath: path.join(state.agentDir(), "sessions.json"),
      };
      const model = { ...testModel, provider: "anthropic", id: "claude-sonnet-4-6" };
      try {
        await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
        let manager = SessionManager.open(scope, state.workspaceDir);
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
        manager.appendMessage(createAssistant(model, "read complete"));
        let previousSnapshot: ReturnType<typeof serializeCacheTtlToolResultProjections> | undefined;
        for (let turn = 0; turn < 3; turn++) {
          using turnLease = retainEmbeddedSessionPromptState(scope.sessionId);
          const projectionState = turnLease.state.toolResults;
          restoreCacheTtlToolResultProjections(projectionState, manager.getBranch());
          if (previousSnapshot) {
            expect(serializeCacheTtlToolResultProjections(projectionState)).toEqual(
              previousSnapshot,
            );
          }
          const { session } = await createTestSession({ sessionManager: manager, model });
          const input = createSettleFixture({
            activeSession: session,
            sessionManager: manager,
            toolResultPromptProjectionState: projectionState,
            attempt: {
              sessionId: scope.sessionId,
              provider: model.provider,
              modelId: model.id,
              config: cacheTtlConfig,
            },
          });
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
            return createAssistantResultStream(createAssistant(model, "done"));
          };
          await submitEmbeddedAttemptPrompt({
            attempt: input.attempt,
            activeSession: session,
            contextTokenBudget: 8_000,
            images: [],
            modelPrompt: "continue",
            onFinalPromptText: () => {},
            persistToolResultProjections: async () => {
              await persistToolResultProjections(projectionState, (customType, data) =>
                manager.appendCustomEntryAsync(customType, data),
              );
            },
            promptActiveSession: (prompt, options) => session.prompt(prompt, options),
            runtimeOnly: false,
            systemPrompt: "test prompt",
            toolResultAggregateMaxChars: 8_000,
            toolResultMaxChars: 4_000,
            toolResultPromptProjectionState: projectionState,
            trajectoryRecorder: null,
            transcriptLeafId: null,
            transcriptPrompt: "continue",
          });
          await settleWithPlugins(input);
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
          manager = SessionManager.open(scope, state.workspaceDir);
        }
      } finally {
        clearEmbeddedSessionPromptStates([scope.sessionId]);
      }
    });
  });
});
