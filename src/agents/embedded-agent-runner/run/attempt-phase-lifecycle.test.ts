import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendTranscriptMessage,
  readActiveTranscriptEntryAnchor,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { runOpenClawAgentWorkerWrite } from "../../../state/openclaw-agent-write-admission.js";
import { useSessionStoreTempDirs } from "../../../test-utils/session-state-cleanup.js";
import { FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE } from "../../bootstrap-files.js";
import { awaitAgentHarnessAgentEndHook } from "../../harness/lifecycle-hook-helpers.js";
import { installSessionToolResultGuard } from "../../session-tool-result-guard.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { createToolResultPromptProjectionState } from "../session-prompt-state.js";
import { createAttemptNestedToolActivityState } from "./attempt-nested-tool-activity.js";
import { createEmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle.js";
import type { EmbeddedAttemptExecutionState } from "./types.js";

const hoisted = vi.hoisted(() => ({
  runAgentEndSideEffects: vi.fn(),
  shouldWaitForCompletionRequiredAsyncTasks: vi.fn((): boolean => false),
  waitForCompletionRequiredAsyncTasks: vi.fn(),
}));

// mock-isolation: Keep skill scheduling and plugin hooks outside phase-ordering tests.
vi.mock("../../harness/agent-end-side-effects.js", () => ({
  runAgentEndSideEffectsAsync: hoisted.runAgentEndSideEffects,
}));
vi.mock("./attempt-async-tasks.js", () => ({
  shouldWaitForCompletionRequiredAsyncTasks: hoisted.shouldWaitForCompletionRequiredAsyncTasks,
  waitForCompletionRequiredAsyncTasks: hoisted.waitForCompletionRequiredAsyncTasks,
}));

import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import { completeEmbeddedAttemptAfterTurn } from "./attempt-finalize.js";
import { settleEmbeddedAttemptStream } from "./attempt-stream-settle.js";

const tempDirs = useSessionStoreTempDirs(afterAll, "openclaw-attempt-terminal-anchor-");
const bootstrapCompletedEntry = expect.objectContaining({
  type: "custom",
  customType: FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE,
});

async function seedSession(
  sessionId: string,
  sessionKey = `agent:main:${sessionId}`,
  file = "sessions.json",
) {
  const dir = tempDirs.make();
  const target = { agentId: "main", sessionId, sessionKey, storePath: path.join(dir, file) };
  await upsertSessionEntryCore(target, { sessionId, updatedAt: 1 });
  return { dir, target };
}

function streamInput(messages: unknown[] = [], currentAttemptAssistant?: unknown) {
  const runAbortDeadlineAtMs = Date.now() + 60_000;
  const sessionManager = Object.assign(SessionManager.inMemory(), {
    appendCustomEntryAsync: vi.fn(async () => undefined),
    buildSessionContext: () => ({ messages }),
    getEntries: () => [],
    removeTrailingEntriesAsync: vi.fn(async () => 0),
  });
  const input: Parameters<typeof settleEmbeddedAttemptStream>[0] = {
    attempt: {
      runId: "run-1",
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      sessionFile: "/tmp/session.jsonl",
      provider: "test",
      modelId: "model",
      model: { api: "openai-responses" },
    } as never,
    activeSession: {
      agent: { state: { messages } },
      isCompacting: false,
      isStreaming: false,
      messages,
      sessionId: "session-1",
    } as never,
    sessionManager: sessionManager as never,
    toolResultPromptProjectionState: createToolResultPromptProjectionState(),
    withOwnedTranscriptWrite: async (operation) => await operation(),
    subscription: {
      toolMetas: [],
      waitForCompactionRetry: async () => {},
      isCompactionInFlight: () => false,
      getCompactionCount: () => 0,
      getCurrentAttemptAssistant: () => structuredClone(currentAttemptAssistant),
      getUsageTotals: () => undefined,
      getLastAssistantUsage: () => undefined,
    } as never,
    state: { promptError: null, promptErrorSource: null, yieldAborted: false },
    readLifecycleState: () => ({
      aborted: false,
      timedOut: false,
      timedOutDuringCompaction: false,
    }),
    markTimedOutDuringCompaction: () => {},
    getRunAbortDeadlineAtMs: () => runAbortDeadlineAtMs,
    runAbortSignal: new AbortController().signal,
    isProbeSession: true,
    abortable: async (promise) => await promise,
    prePromptMessageCount: 0,
    nestedToolActivityState: createAttemptNestedToolActivityState(),
    cache: { retention: undefined },
    shouldFlushForContextEngine: false,
  };
  return { input, sessionManager };
}

function prepared(
  sessionManager: SessionManager,
  record = true,
  tools: { name: string }[] = [],
  hookRunner: Pick<
    NonNullable<Parameters<typeof awaitAgentHarnessAgentEndHook>[0]["hookRunner"]>,
    "hasHooks" | "runAgentEnd"
  > | null = null,
) {
  return {
    bootstrap: { shouldRecordCompletedBootstrapTurn: record },
    bundleTools: { uncompactedEffectiveTools: tools },
    toolBase: { nestedToolActivityState: createAttemptNestedToolActivityState() },
    sessionRuntime: {
      sessionManager,
      agentSession: { hookRunner },
      state: { prePromptMessageCount: 0 },
      contextGuards: { getAfterTurnCheckpoint: () => null },
    },
  };
}

function settled(
  sessionIdUsed: string,
  overrides: Partial<Parameters<typeof completeEmbeddedAttemptAfterTurn>[1]> = {},
) {
  return {
    promptError: null,
    sessionIdUsed,
    messagesSnapshot: [],
    compactionOccurredThisAttempt: false,
    ...overrides,
  };
}

function prompt(transcriptLeafId: string | null = null) {
  return {
    yieldAborted: false,
    transcriptLeafId,
    promptStartedAt: Date.now(),
  };
}

function finalizationInput(preparedState: ReturnType<typeof prepared>) {
  return {
    agentDir: "/tmp/agent",
    resolveActiveContextEnginePluginId: () => undefined,
    setup: { effectiveWorkspace: "/tmp/workspace", sessionAgentId: "main" },
    sessionLock: {
      withOwnedTranscriptWrite: async <T>(operation: () => T | Promise<T>) => await operation(),
    },
    state: { terminal: { kind: "ok" } },
    prepared: preparedState,
    diagnostics: {
      diagnosticTrace: {
        traceId: "11111111111111111111111111111111",
        spanId: "2222222222222222",
      },
    },
  };
}

describe("embedded attempt phase lifecycle state", () => {
  beforeEach(() => {
    hoisted.runAgentEndSideEffects.mockReset();
    hoisted.shouldWaitForCompletionRequiredAsyncTasks.mockReset().mockReturnValue(false);
    hoisted.waitForCompletionRequiredAsyncTasks.mockReset();
  });

  it("re-reads compaction timeout state after the retry wait", async () => {
    let timedOut = false;
    let timedOutDuringCompaction = false;
    const { input, sessionManager } = streamInput();
    delete input.attempt.sessionKey;
    input.subscription.waitForCompactionRetry = async () => {
      timedOut = true;
      timedOutDuringCompaction = true;
    };
    input.readLifecycleState = () => ({ aborted: timedOut, timedOut, timedOutDuringCompaction });
    input.markTimedOutDuringCompaction = () => {
      timedOutDuringCompaction = true;
    };
    const result = await settleEmbeddedAttemptStream(input);

    expect(result.timedOutDuringCompaction).toBe(true);
    expect(sessionManager.removeTrailingEntriesAsync).toHaveBeenCalledOnce();
  });

  it("settles a user-aborted run whose async-task wait throws AbortError", async () => {
    const abortError = Object.assign(new Error("This operation was aborted"), {
      name: "AbortError",
    });
    hoisted.shouldWaitForCompletionRequiredAsyncTasks.mockReturnValue(true);
    hoisted.waitForCompletionRequiredAsyncTasks.mockRejectedValueOnce(abortError);
    const { input } = streamInput();
    input.subscription.toolMetas = [{ toolName: "exec", asyncStarted: true }];
    input.readLifecycleState = () => ({
      aborted: true,
      timedOut: false,
      timedOutDuringCompaction: false,
    });
    input.runAbortSignal = AbortSignal.abort();
    const result = await settleEmbeddedAttemptStream(input);

    // The aborted run settles instead of unwinding the lane task, and its
    // unfinished async tasks are not reclassified as a timeout failure.
    expect(result.promptError).toBeNull();
    expect(hoisted.waitForCompletionRequiredAsyncTasks).toHaveBeenCalledOnce();
  });

  it("keeps projected nested tool evidence from owning the model terminal (#118274)", async () => {
    const modelAssistant = {
      role: "assistant",
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "outer-exec", name: "exec", arguments: {} }],
    };
    const messages = [
      { role: "user", content: "Read a missing file." },
      modelAssistant,
      makeTextToolResult("outer-exec", "exec", "ENOENT", true, 0),
    ];
    const { input } = streamInput(messages, modelAssistant);
    input.attempt.provider = "mock-openai";
    input.attempt.modelId = "gpt-5.6-luna";
    input.prePromptMessageCount = 1;
    input.subscription.toolMetas = [
      { toolName: "read", isError: true },
      { toolName: "exec", isError: true },
    ];
    const result = await settleEmbeddedAttemptStream(input);

    expect(result.lastAssistant).toBe(modelAssistant);
    expect(result.currentAttemptAssistant).toBe(modelAssistant);
    expect(result.currentAttemptCompletedAssistant).toEqual(modelAssistant);
    expect(result.successfulNestedToolNames).toEqual([]);
    expect(result.messagesSnapshot).toEqual(messages);
  });

  it.each(["complete", "missing admission", "missing terminal"] as const)(
    "handles %s candidate anchors without skipping later lifecycle work",
    async (boundary) => {
      const { dir, target } = await seedSession("session-1", "agent:main:main");
      const userMessage = { role: "user" as const, content: "hello", timestamp: 1 };
      const persistedUser = await appendTranscriptMessage(target, {
        cwd: dir,
        eventId: "user-1",
        message: userMessage,
        now: 1,
      });
      if (!persistedUser?.anchor) {
        throw new Error("expected persisted user anchor");
      }
      const recorder = createUserTurnTranscriptRecorder({
        message: userMessage,
        target: async () => undefined,
      });
      if (boundary !== "missing admission") {
        recorder.markRuntimePersisted(userMessage, persistedUser.anchor);
      }
      const sessionManager =
        boundary === "missing terminal"
          ? SessionManager.inMemory(dir)
          : SessionManager.open(target, dir);
      const terminalEntryId = sessionManager.appendMessage(
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "done" }],
          timestamp: 2,
        }),
      );
      const expectedTerminalAnchor = readActiveTranscriptEntryAnchor({
        ...persistedUser.anchor,
        entryId: terminalEntryId,
      });
      if (boundary === "complete" && !expectedTerminalAnchor) {
        throw new Error("expected persisted terminal anchor");
      }
      const afterTurn = vi.fn(async () => {});
      const maintain = vi.fn(async () => ({
        changed: false,
        bytesFreed: 0,
        rewrittenEntries: 0,
      }));
      const onContextEngineTurnCandidate = vi.fn();
      const config = {};
      await completeEmbeddedAttemptAfterTurn(
        {
          ...finalizationInput(prepared(sessionManager)),
          attempt: {
            runId: "run-1",
            sessionId: target.sessionId,
            sessionKey: target.sessionKey,
            sessionTarget: target,
            sessionFile: target.sessionKey,
            provider: "test",
            modelId: "model",
            model: { api: "openai-responses", contextWindow: 120_000 },
            modelContextWindow: 200_000,
            contextTokenBudget: 180_000,
            workspaceDir: dir,
            cwd: dir,
            authProfileId: "profile-1",
            config,
            userTurnTranscriptRecorder: recorder,
            onContextEngineTurnCandidate,
          } as never,
          activeContextEngine: {
            info: { id: "test", name: "Test" },
            assemble: vi.fn(),
            compact: vi.fn(),
            ingest: vi.fn(),
            afterTurn,
            maintain,
          } as never,
          resolveActiveContextEnginePluginId: () => "test",
        } as never,
        settled(target.sessionId, {
          messagesSnapshot: [{ role: "assistant", content: "done" }] as never,
        }) as never,
        prompt(),
      );

      if (boundary === "complete") {
        expect(onContextEngineTurnCandidate).toHaveBeenCalledWith(
          expect.objectContaining({
            boundary: {
              admission: recorder.getAdmissionReceipt(),
              terminal: expectedTerminalAnchor,
            },
            runtimeContext: {
              provider: "test",
              modelId: "model",
              modelContextWindow: 200_000,
              tokenBudget: 180_000,
            },
          }),
        );
      } else {
        expect(onContextEngineTurnCandidate).not.toHaveBeenCalled();
      }
      expect(sessionManager.getEntries()).toContainEqual(bootstrapCompletedEntry);
      expect(hoisted.runAgentEndSideEffects).toHaveBeenCalledOnce();
      const context = hoisted.runAgentEndSideEffects.mock.calls[0]?.[0].ctx;
      expect(context).toMatchObject({
        runId: "run-1",
        agentId: "main",
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        modelProviderId: "test",
        modelId: "model",
        modelContextWindowTokens: 180_000,
        authProfileId: "profile-1",
        skillWorkshopAvailable: false,
        compacted: false,
        trace: {
          traceId: "11111111111111111111111111111111",
          spanId: "2222222222222222",
        },
        foregroundPromptContext: {
          agentId: "main",
          agentDir: "/tmp/agent",
          workspaceDir: dir,
          cwd: dir,
          sandboxSessionKey: target.sessionKey,
          sandboxAgentId: "main",
        },
      });
      expect(context?.config).toBe(config);
      expect(hoisted.runAgentEndSideEffects.mock.calls[0]?.[0].skillExperienceReviewSource).toEqual(
        sessionManager.getSessionTarget()
          ? { ...sessionManager.getSessionTarget(), entryId: terminalEntryId }
          : undefined,
      );
      expect([afterTurn.mock.calls, maintain.mock.calls]).toEqual([[], []]);
    },
  );

  it.each([
    ["stacked markers", true],
    ["custom leaf", false],
    ["marker after custom leaf", false],
    ["parentless marker", false],
    ["missing parent", false],
    ["no leaf", false],
    ["real manager marker", true],
  ] as const)("records terminal candidates with %s", async (scenario, allowed) => {
    const { dir, target } = await seedSession("candidate-tail");
    const userMessage = { role: "user" as const, content: "hello", timestamp: 1 };
    const persisted = await appendTranscriptMessage(target, {
      cwd: dir,
      eventId: "user-1",
      message: userMessage,
      now: 1,
    });
    if (!persisted?.anchor) {
      throw new Error("expected persisted admission");
    }
    const recorder = createUserTurnTranscriptRecorder({
      message: userMessage,
      target: async () => undefined,
    });
    recorder.markRuntimePersisted(userMessage, persisted.anchor);
    const sessionManager = SessionManager.open(target, dir);
    const terminalId = await sessionManager.appendMessageAsync(
      makeAgentAssistantMessage({ content: [{ type: "text", text: "done" }], timestamp: 2 }),
    );
    if (!terminalId) {
      throw new Error("expected persisted terminal id");
    }
    const base = sessionManager.getEntry(terminalId);
    const terminal = readActiveTranscriptEntryAnchor({ ...persisted.anchor, entryId: terminalId });
    if (!base || !terminal) {
      throw new Error("expected persisted terminal");
    }
    type Entry = NonNullable<ReturnType<SessionManager["getEntry"]>>;
    const marker = {
      id: "marker-1",
      parentId: base.id,
      type: "custom" as const,
      timestamp: new Date(2).toISOString(),
      customType: "openclaw.cache-ttl",
    };
    const snapshot = {
      ...marker,
      id: "snapshot-1",
      parentId: marker.id,
      customType: "projection-snapshot",
    };
    const secondMarker = { ...marker, id: "marker-2", parentId: marker.id };
    const trailing = { ...marker, id: "trailing", parentId: snapshot.id };
    const tails = new Map<string, { entries: Entry[]; leafId: string | null }>([
      ["stacked markers", { entries: [base, marker, secondMarker], leafId: secondMarker.id }],
      ["custom leaf", { entries: [base, marker, snapshot], leafId: snapshot.id }],
      [
        "marker after custom leaf",
        { entries: [base, marker, snapshot, trailing], leafId: trailing.id },
      ],
      ["parentless marker", { entries: [{ ...marker, parentId: null }], leafId: marker.id }],
      ["missing parent", { entries: [marker], leafId: marker.id }],
      ["no leaf", { entries: [], leafId: null }],
    ]);
    const tail = tails.get(scenario);
    const reads: { mockRestore(): void }[] = [];
    if (tail) {
      const entries = new Map(tail.entries.map((entry) => [entry.id, entry]));
      reads.push(vi.spyOn(sessionManager, "getLeafId").mockReturnValue(tail.leafId));
      reads.push(vi.spyOn(sessionManager, "getEntry").mockImplementation((id) => entries.get(id)));
    } else {
      await sessionManager.appendCustomEntryAsync("openclaw.cache-ttl", {});
    }
    const onContextEngineTurnCandidate = vi.fn();
    try {
      await completeEmbeddedAttemptAfterTurn(
        {
          ...finalizationInput(prepared(sessionManager, false)),
          attempt: {
            runId: "candidate-tail",
            sessionId: target.sessionId,
            sessionKey: target.sessionKey,
            sessionTarget: target,
            sessionFile: target.sessionKey,
            provider: "test",
            modelId: "model",
            contextTokenBudget: 180_000,
            userTurnTranscriptRecorder: recorder,
            onContextEngineTurnCandidate,
          },
          activeContextEngine: { info: { id: "test", name: "Test" } },
        } as never,
        settled(target.sessionId) as never,
        prompt(),
      );
      if (allowed) {
        expect(onContextEngineTurnCandidate).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            boundary: { admission: recorder.getAdmissionReceipt(), terminal },
          }),
        );
      } else {
        expect(onContextEngineTurnCandidate).not.toHaveBeenCalled();
      }
      expect(hoisted.runAgentEndSideEffects).toHaveBeenCalledOnce();
    } finally {
      for (const read of reads) {
        read.mockRestore();
      }
    }
  });

  it("preserves cron job identity in agent_end after failure", async () => {
    const promptError = new Error("provider failed");
    const runAgentEnd = vi.fn<
      NonNullable<Parameters<typeof awaitAgentHarnessAgentEndHook>[0]["hookRunner"]>["runAgentEnd"]
    >(async () => {});
    hoisted.runAgentEndSideEffects.mockImplementation(awaitAgentHarnessAgentEndHook);
    for (const jobId of [undefined, "job-1"]) {
      const sessionKey = jobId ? "agent:main:cron:job-1:run:run-1" : "agent:main:main";
      runAgentEnd.mockClear();
      hoisted.runAgentEndSideEffects.mockClear();
      await completeEmbeddedAttemptAfterTurn(
        {
          ...finalizationInput(
            prepared(SessionManager.inMemory(), false, [{ name: "skill_workshop" }], {
              hasHooks: () => true,
              runAgentEnd,
            }),
          ),
          attempt: {
            runId: "run-1",
            sessionId: "session-1",
            sessionKey,
            jobId,
            trigger: jobId ? "cron" : "user",
            contextTokenBudget: 180_000,
            sessionFile: "/tmp/session.jsonl",
          } as never,
        } as never,
        settled("session-1", { promptError }) as never,
        prompt(),
      );

      expect(hoisted.runAgentEndSideEffects).toHaveBeenCalledTimes(1);
      expect(hoisted.runAgentEndSideEffects.mock.calls[0]?.[0]?.event).toMatchObject({
        success: false,
        error: "provider failed",
      });
      expect(runAgentEnd).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ success: false }),
        expect.objectContaining({ runId: "run-1", sessionId: "session-1", sessionKey }),
        { unrefTimeout: false },
      );
      if (jobId) {
        expect(runAgentEnd).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ jobId }),
          expect.anything(),
        );
      } else {
        expect(runAgentEnd.mock.calls[0]?.[1]).not.toHaveProperty("jobId");
      }
    }
  });

  it.each(["blocked writes", "interrupted tool result"] as const)(
    "selects review evidence after the pre-turn boundary with %s",
    async (tail) => {
      const { dir, target } = await seedSession("review-boundary");
      const sessionManager = SessionManager.open(target, dir);
      let currentTurn = false;
      installSessionToolResultGuard(sessionManager, {
        runId: "reused-run-id",
        beforeMessageWriteHook: ({ message }) =>
          currentTurn &&
          (tail === "blocked writes" ||
            (message.role === "assistant" && message.stopReason !== "toolUse"))
            ? { block: true }
            : undefined,
      });
      sessionManager.appendMessage(
        makeAgentAssistantMessage({ content: [{ type: "text", text: "Previous turn." }] }),
      );
      const transcriptLeafId = sessionManager.appendCustomEntry("previous-turn-finished");
      currentTurn = true;
      sessionManager.appendMessage({ role: "user", content: "Current task.", timestamp: 2 });
      sessionManager.appendMessage(
        makeAgentAssistantMessage({
          content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
          stopReason: "toolUse",
        }),
      );
      const toolResultEntryId = sessionManager.appendMessage(
        makeTextToolResult("call-1", "read", "Current verified result.", false, 3),
      );
      sessionManager.appendMessage(
        makeAgentAssistantMessage({ content: [{ type: "text", text: "Suppressed terminal." }] }),
      );

      await completeEmbeddedAttemptAfterTurn(
        {
          ...finalizationInput(prepared(sessionManager, true, [{ name: "skill_workshop" }])),
          attempt: {
            runId: "reused-run-id",
            sessionId: target.sessionId,
            contextTokenBudget: 180_000,
          } as never,
          agentDir: dir,
          setup: { effectiveWorkspace: dir, sessionAgentId: "main" },
          state: {
            terminal:
              tail === "interrupted tool result"
                ? { kind: "aborted", source: "external" }
                : { kind: "ok" },
          },
        } as never,
        settled(target.sessionId) as never,
        prompt(transcriptLeafId),
      );

      expect(hoisted.runAgentEndSideEffects).toHaveBeenCalledOnce();
      expect(hoisted.runAgentEndSideEffects.mock.calls[0]?.[0].skillExperienceReviewSource).toEqual(
        tail === "interrupted tool result"
          ? { ...sessionManager.getSessionTarget(), entryId: toolResultEntryId }
          : undefined,
      );
    },
  );

  it.each([
    "already aborted",
    "completion not requested",
    "prompt error",
    "provider error",
    "provider error without completed assistant",
    "eligible completion",
    "abort while queued",
  ] as const)("settles %s behind a held agent writer", async (scenario) => {
    const { dir, target } = await seedSession("after-turn", undefined, "openclaw-agent.sqlite");
    const sessionManager = SessionManager.open(target, dir);
    sessionManager.appendMessage({ role: "user", content: "synthetic after-turn", timestamp: 1 });
    const originalEntries = sessionManager.getEntries();
    const executionState: Pick<EmbeddedAttemptExecutionState, "terminal"> = {
      terminal:
        scenario === "already aborted" ? { kind: "aborted", source: "external" } : { kind: "ok" },
    };
    const lifecycle = createEmbeddedAttemptTranscriptLifecycle({
      runId: "after-turn",
      sessionId: target.sessionId,
    });
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const heldWriter = runOpenClawAgentWorkerWrite(
      { agentId: target.agentId, path: target.storePath },
      async () => {
        entered.resolve();
        await release.promise;
      },
    );
    let afterTurn: Promise<void> | undefined;
    let completed = false;
    try {
      await entered.promise;
      afterTurn = completeEmbeddedAttemptAfterTurn(
        {
          ...finalizationInput(prepared(sessionManager, scenario !== "completion not requested")),
          attempt: {
            runId: "after-turn",
            contextTokenBudget: 180_000,
            sessionId: target.sessionId,
            sessionKey: target.sessionKey,
            sessionTarget: target,
            sessionFile: target.sessionKey,
          },
          agentDir: dir,
          setup: { effectiveWorkspace: dir, sessionAgentId: target.agentId },
          sessionLock: {
            withOwnedTranscriptWrite: <T>(operation: () => Promise<T> | T) =>
              lifecycle.withTranscriptWrite(operation),
          },
          state: executionState,
        } as never,
        settled(target.sessionId, {
          promptError: scenario === "prompt error" ? new Error("synthetic prompt error") : null,
          currentAttemptAssistant: makeAgentAssistantMessage({
            content: [],
            stopReason: scenario.startsWith("provider error") ? "error" : "stop",
          }),
          currentAttemptCompletedAssistant:
            scenario === "provider error"
              ? makeAgentAssistantMessage({ content: [], stopReason: "error" })
              : undefined,
        }) as never,
        prompt(),
      ).then(() => {
        completed = true;
      });
      const needsWrite = scenario === "eligible completion" || scenario === "abort while queued";
      // Drain this event-loop turn while the real competing owner remains held.
      await setImmediate();
      expect(completed).toBe(!needsWrite);
      expect(hoisted.runAgentEndSideEffects).toHaveBeenCalledTimes(needsWrite ? 0 : 1);
      expect(SessionManager.open(target, dir).getEntries()).toEqual(originalEntries);
      if (scenario === "abort while queued") {
        executionState.terminal = { kind: "aborted", source: "external" };
      }
      release.resolve();
      await heldWriter;
      await afterTurn;
      const entries = SessionManager.open(target, dir).getEntries();
      if (scenario === "eligible completion") {
        expect(entries).toHaveLength(originalEntries.length + 1);
        expect(entries.at(-1)).toEqual(bootstrapCompletedEntry);
      } else {
        expect(entries).toEqual(originalEntries);
      }
      expect(hoisted.runAgentEndSideEffects).toHaveBeenCalledOnce();
      if (!scenario.startsWith("provider error")) {
        expect(hoisted.runAgentEndSideEffects.mock.calls[0]?.[0].event.success).toBe(
          scenario === "eligible completion" || scenario === "completion not requested",
        );
      }
    } finally {
      release.resolve();
      await Promise.allSettled([heldWriter, afterTurn]);
      await lifecycle.dispose();
    }
  });
});
