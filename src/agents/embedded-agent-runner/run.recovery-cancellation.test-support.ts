import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { SessionManager } from "../sessions/session-manager.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import {
  makeAttemptResult,
  makeCompactionSuccess,
  makeOverflowError,
} from "./run.overflow-compaction.fixture.js";
import {
  mockedBuildEmbeddedRunPayloads,
  mockedCompactDirect,
  mockedGlobalHookRunner,
  mockedRunEmbeddedAttempt,
  createOverflowRunParams,
  resetSharedRunIntegrationHarnessMocks,
  useOpenAIPlatformAuthFixture,
  type TestRunEmbeddedAgent,
} from "./run.overflow-compaction.harness.js";
import {
  createSharedRunIntegrationSession,
  loadSharedRunIntegrationHarness,
} from "./run.shared-integration-harness.test-support.js";
import type {
  CompactionAccountingFact,
  EmbeddedRunAttemptInternalParams,
} from "./run/internal-params.js";

function timeoutAttempt(sessionIdUsed = "test-session") {
  const assistant = makeAssistantMessageFixture();
  assistant.usage = { ...assistant.usage, input: 180_000, totalTokens: 180_000 };
  return makeAttemptResult({
    sessionIdUsed,
    terminal: { kind: "timeout", phase: "prompt", source: "idle", aborted: true },
    assistantTexts: [],
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
  });
}

function completedAssistant(tokens?: number, withText = false) {
  const assistant = makeAssistantMessageFixture({
    stopReason: "stop",
    errorMessage: undefined,
    ...(withText ? { content: [{ type: "text" as const, text: "Done." }] } : {}),
  });
  if (tokens !== undefined) {
    assistant.usage = { ...assistant.usage, input: tokens, totalTokens: tokens };
  }
  return assistant;
}

type SubscribedHarness = ReturnType<
  typeof import("../embedded-agent-subscribe.e2e-harness.js").createSubscribedSessionHarness
>;
function mockSubscribedAttempt(
  use: (
    attempt: EmbeddedRunAttemptInternalParams,
    harness: SubscribedHarness,
  ) => Promise<ReturnType<typeof makeAttemptResult>>,
  full = true,
  events = false,
) {
  mockedRunEmbeddedAttempt.mockImplementationOnce(async (input) => {
    const attempt = input as EmbeddedRunAttemptInternalParams;
    const { createSubscribedSessionHarness } =
      await import("../embedded-agent-subscribe.e2e-harness.js");
    const harness = createSubscribedSessionHarness({
      runId: attempt.runId,
      onContextAccountingEvent: attempt.onContextAccountingEvent,
      ...(full
        ? {
            agentId: attempt.agentId,
            sessionKey: attempt.sessionKey,
            sessionExtras: { messages: [] },
            compactionCountOwner: attempt.compactionCountOwner,
            ...(events ? { onAgentEvent: attempt.onAgentEvent } : {}),
          }
        : {}),
    });
    try {
      return await use(attempt, harness);
    } finally {
      harness.subscription.unsubscribe();
    }
  });
}

function emitCompaction(
  attempt: EmbeddedRunAttemptInternalParams,
  harness: SubscribedHarness,
  tokensAfter: number,
) {
  // Private accounting commits; the public event only projects completion.
  attempt.onContextAccountingEvent?.({ kind: "compaction", tokensAfter });
  harness.emit({
    type: "compaction_end",
    reason: "threshold",
    outcome: {
      status: "completed",
      tokensBefore: 180_000,
      tokensAfter,
      willRetry: false,
    },
  });
}

function prepareCompaction(summary: string) {
  mockedCompactDirect.mockResolvedValueOnce(makeCompactionSuccess({ summary, tokensAfter: 40 }));
}

describe("recovery cancellation through the public run owner", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let runEmbeddedAgent: TestRunEmbeddedAgent;
  let session: Awaited<ReturnType<typeof createSharedRunIntegrationSession>> | undefined;
  let sessionAccessor: typeof import("../../config/sessions/session-accessor.js");
  let contextEngine: Awaited<
    ReturnType<(typeof import("../../context-engine/registry.js"))["resolveContextEngine"]>
  >;
  const readLatest = (target: Parameters<typeof sessionAccessor.loadSessionEntry>[0]) =>
    sessionAccessor.loadSessionEntry({ ...target, readConsistency: "latest" });
  const detachedParams = (prefix: string) => {
    const workspaceDir = tempDirs.make(prefix);
    const sessionManager = SessionManager.inMemory(workspaceDir);
    return {
      ...createOverflowRunParams({ workspaceDir }),
      sessionId: sessionManager.getSessionId(),
      sessionManager,
      sessionPersistence: "detached" as const,
    };
  };
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
    sessionAccessor = await import("../../config/sessions/session-accessor.js");
    const { resolveContextEngine } = await import("../../context-engine/registry.js");
    contextEngine = await resolveContextEngine();
  });
  beforeEach(async () => {
    resetSharedRunIntegrationHarnessMocks();
    const { setRuntimeConfigSnapshot } = await import("../../config/runtime-snapshot.js");
    setRuntimeConfigSnapshot({});
    contextEngine.info.ownsCompaction = true;
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (name) => name === "before_compaction" || name === "after_compaction",
    );
    mockedGlobalHookRunner.runBeforeCompaction.mockReset().mockResolvedValue(undefined);
    mockedGlobalHookRunner.runAfterCompaction.mockReset().mockResolvedValue(undefined);
  });
  afterEach(async () => {
    contextEngine.info.ownsCompaction = false;
    await session?.cleanup();
    session = undefined;
    const { clearRuntimeConfigSnapshot } = await import("../../config/runtime-snapshot.js");
    clearRuntimeConfigSnapshot();
  });

  it("fences retired foreground budget observers across physical retries", async () => {
    const firstBudget = {
      contextWindow: 32_768,
      reserveTokens: 8_192,
      fixedTokens: 4_000,
      pendingTokens: 100,
    };
    const retryBudget = { ...firstBudget, fixedTokens: 4_100, pendingTokens: 0 };
    const observed =
      vi.fn<NonNullable<EmbeddedRunAttemptInternalParams["onCompactionRequestBudget"]>>();
    let retiredObserver: EmbeddedRunAttemptInternalParams["onCompactionRequestBudget"];
    type BudgetObservedAttempt = Parameters<typeof mockedRunEmbeddedAttempt>[0] &
      Pick<EmbeddedRunAttemptInternalParams, "onCompactionRequestBudget">;
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attempt: BudgetObservedAttempt) => {
      retiredObserver = attempt.onCompactionRequestBudget;
      retiredObserver?.(firstBudget);
      return makeAttemptResult({ promptError: makeOverflowError(), assistantTexts: [] });
    });
    prepareCompaction("Prior work");
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attempt: BudgetObservedAttempt) => {
      attempt.onCompactionRequestBudget?.(retryBudget);
      retiredObserver?.(firstBudget);
      return makeAttemptResult({ assistantTexts: ["Done."] });
    });

    await runEmbeddedAgent({
      ...detachedParams("openclaw-request-budget-retry-"),
      provider: "anthropic",
      model: "test-model",
      onCompactionRequestBudget: observed,
    });
    retiredObserver?.(firstBudget);

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(observed.mock.calls.map(([budget]) => budget)).toEqual([
      undefined,
      firstBudget,
      undefined,
      retryBudget,
    ]);
  });

  it.each([
    { owner: "caller", kind: "overflow", committed: false },
    { owner: "caller", kind: "timeout", committed: true },
    { owner: "subscription", kind: "timeout", committed: false },
    { owner: "subscription", kind: "overflow", committed: true },
    { owner: "writer-replaced", kind: "timeout", committed: true },
    { owner: "admission-replaced", kind: "timeout", committed: true },
    { owner: "deleted", kind: "timeout", committed: true },
  ] as const)(
    "settles $kind cancellation without stale $owner writes (committed=$committed)",
    async ({ owner, kind, committed }) => {
      const { prepareSystemAgentRunAdmission } = await import("../admitted-run-context.js");
      let replacement: ReturnType<typeof prepareSystemAgentRunAdmission> | undefined;
      const abort = new AbortController();
      const callerError = new Error("caller stopped recovery");
      const onCompactionAccounting = vi.fn<(fact: CompactionAccountingFact | undefined) => void>();
      if (owner !== "caller") {
        session = await createSharedRunIntegrationSession();
      }
      const runParams = session?.runParams ?? detachedParams("openclaw-recovery-cancel-");
      const target = session?.runParams.sessionTarget;
      mockedRunEmbeddedAttempt.mockResolvedValueOnce(
        kind === "overflow"
          ? makeAttemptResult({
              promptError: makeOverflowError(),
              sessionIdUsed: runParams.sessionId,
              assistantTexts: [],
            })
          : timeoutAttempt(runParams.sessionId),
      );
      if (committed) {
        prepareCompaction("Committed before Stop");
        mockedGlobalHookRunner.runAfterCompaction.mockImplementationOnce(async () => {
          if (target && owner === "deleted") {
            await sessionAccessor.deleteSessionEntryLifecycle({
              agentId: target.agentId,
              storePath: target.storePath,
              archiveTranscript: false,
              target: { canonicalKey: target.sessionKey, storeKeys: [target.sessionKey] },
            });
          } else if (target && (owner === "writer-replaced" || owner === "admission-replaced")) {
            await sessionAccessor.updateSessionEntry(target, () => ({
              compactionCount: 7,
              totalTokens: 999,
            }));
            if (owner === "writer-replaced") {
              const { claimAgentSessionWriter } = await import("./run/session-bootstrap.js");
              await claimAgentSessionWriter({ ...runParams, runId: "replacement-writer" });
            } else {
              replacement = prepareSystemAgentRunAdmission(
                {},
                runParams.runId,
                "main",
                "replacement",
              );
              await replacement.admit("embedded");
            }
          }
          abort.abort(callerError);
        });
      } else {
        mockedCompactDirect.mockImplementationOnce(async () => {
          abort.abort(callerError);
          throw callerError;
        });
      }
      try {
        const run = runEmbeddedAgent({
          ...runParams,
          abortSignal: abort.signal,
          ...(owner === "caller" ? { onCompactionAccounting } : {}),
        });
        await expect(run).rejects.toBe(callerError);
        expect(mockedCompactDirect).toHaveBeenCalledOnce();
        expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
        if (target) {
          const entry = readLatest(target);
          if (owner === "deleted") {
            expect(entry).toBeUndefined();
          } else if (owner === "writer-replaced" || owner === "admission-replaced") {
            expect(entry).toMatchObject({
              compactionCount: 7,
              totalTokens: 999,
              activeWriterRunId:
                owner === "writer-replaced" ? "replacement-writer" : runParams.runId,
            });
          } else {
            expect(entry).toMatchObject({ sessionId: runParams.sessionId });
            expect(entry?.compactionCount ?? 0).toBe(committed ? 1 : 0);
            expect(entry?.totalTokens).toBe(committed ? 40 : undefined);
            expect(onCompactionAccounting).not.toHaveBeenCalled();
          }
        } else {
          expect(onCompactionAccounting).toHaveBeenCalledExactlyOnceWith(
            committed
              ? { kind: "presentation-only", count: 1, currentContextSnapshot: { tokens: 40 } }
              : undefined,
          );
        }
      } finally {
        replacement?.close();
      }
    },
  );

  it.each(["returned", "thrown"] as const)(
    "settles observed default counts once when the attempt is %s",
    async (settlement) => {
      session = await createSharedRunIntegrationSession();
      const attemptError = new Error("attempt cleanup failed after completed compaction");
      const onAgentEvent = vi.fn();
      mockSubscribedAttempt(
        async (attempt, harness) => {
          emitCompaction(attempt, harness, 80);
          await harness.subscription.waitForPendingEvents();
          if (settlement === "thrown") {
            throw attemptError;
          }
          return {
            ...timeoutAttempt(attempt.sessionId),
            compactionCount: harness.subscription.getCompactionCount(),
            compactionTokensAfter: 80,
          };
        },
        true,
        true,
      );
      mockSubscribedAttempt(async (attempt, harness) => {
        const assistant = completedAssistant(120);
        harness.emit({ type: "message_start", message: assistant });
        harness.emit({ type: "message_end", message: assistant });
        await harness.subscription.waitForPendingEvents();
        return makeAttemptResult({ sessionIdUsed: attempt.sessionId });
      }, false);
      prepareCompaction("Outer timeout recovery");

      const run = runEmbeddedAgent({ ...session.runParams, onAgentEvent });
      if (settlement === "returned") {
        expect((await run).meta.agentMeta?.compactionCount).toBe(2);
      } else {
        await expect(run).rejects.toBe(attemptError);
      }

      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(settlement === "returned" ? 2 : 1);
      expect(mockedCompactDirect).toHaveBeenCalledTimes(settlement === "returned" ? 1 : 0);
      expect(readLatest(session.runParams.sessionTarget)).toMatchObject({
        compactionCount: settlement === "returned" ? 2 : 1,
        totalTokens: settlement === "returned" ? 120 : 80,
      });
      expect(onAgentEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          stream: "compaction",
          data: expect.objectContaining({ phase: "end", completed: true }),
        }),
      );
    },
  );

  it.each([
    { order: "model-then-compaction", currentContextTokens: 40 },
    { order: "compaction-then-model", currentContextTokens: 120 },
    { order: "compaction-then-unknown", currentContextTokens: undefined },
  ] as const)("carries producer chronology through the run owner ($order)", async (testCase) => {
    session = await createSharedRunIntegrationSession();
    const { runParams } = session;
    const facts = vi.fn<(fact: CompactionAccountingFact | undefined) => void>();
    mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "Done." }]);
    mockSubscribedAttempt(async (attempt, harness) => {
      const assistant = completedAssistant(120, true);
      const emitModel = () => {
        const message =
          testCase.order === "compaction-then-unknown"
            ? completedAssistant(undefined, true)
            : assistant;
        harness.emit({ type: "message_start", message });
        harness.emit({ type: "message_end", message });
      };
      if (testCase.order === "model-then-compaction") {
        emitModel();
      }
      emitCompaction(attempt, harness, 40);
      if (testCase.order !== "model-then-compaction") {
        emitModel();
      }
      await harness.subscription.waitForPendingEvents();
      // Terminal copies can still describe the pre-compaction assistant.
      return makeAttemptResult({
        sessionIdUsed: runParams.sessionId,
        lastAssistant: assistant,
        compactionCount: harness.subscription.getCompactionCount(),
        compactionTokensAfter: 40,
      });
    });

    const result = await runEmbeddedAgent({
      ...runParams,
      onCompactionAccounting: facts,
    });

    expect(result.payloads).toEqual([{ text: "Done." }]);
    expect(facts).toHaveBeenCalledExactlyOnceWith({
      kind: "durable",
      count: 1,
      currentContextSnapshot: { tokens: testCase.currentContextTokens },
      target: {
        ...runParams.sessionTarget,
        lifecycleRevision: undefined,
        activeWriterRunId: runParams.runId,
      },
    });
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
    expect(mockedCompactDirect).not.toHaveBeenCalled();
  });

  it.each(["current", "replaced"] as const)(
    "finalizes opaque native usage only for its %s writer",
    async (writer) => {
      session = await createSharedRunIntegrationSession();
      const { runParams } = session;
      const { sessionId, sessionKey, sessionTarget } = runParams;
      const { createCommandCompactionAccounting } =
        await import("../command/compaction-accounting.js");
      const { updateSessionStoreAfterAgentRun } = await import("../command/session-store.js");
      const { SESSION_TOTAL_TOKENS_VERSION } = await import("../../config/sessions/types.js");
      const { normalizeUsage } = await import("../usage.js");
      useOpenAIPlatformAuthFixture();
      const initialEntry = {
        sessionId,
        updatedAt: 1,
        lifecycleRevision: "native-usage-generation",
        activeWriterRunId: "previous-writer",
        totalTokens: 0,
        totalTokensFresh: true,
        totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
      };
      await sessionAccessor.replaceSessionEntry(sessionTarget, initialEntry);
      const sessionEntry = sessionAccessor.loadExactSessionEntryReadOnly(sessionTarget)?.entry;
      if (!sessionEntry) {
        throw new Error("The command must retain its pre-claim working copy");
      }
      const sessionStore = { [sessionKey]: sessionEntry };
      const accounting = createCommandCompactionAccounting({
        sessionStore,
        persistCounts: true,
        onDurableFact: () => {},
        refreshSessionEntry: () => {},
      });
      const candidate = accounting.beginCandidate();
      const assistant = makeAssistantMessageFixture({
        model: "gpt-5.6-luna",
        stopReason: "stop",
        errorMessage: undefined,
        content: [{ type: "text", text: "Done." }],
      });
      assistant.usage = {
        ...assistant.usage,
        input: 3,
        output: 18,
        cacheRead: 0,
        cacheWrite: 13_354,
        totalTokens: 13_375,
        contextUsage: { state: "available", promptTokens: 13_357, totalTokens: 13_375 },
      };
      mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "Done." }]);
      // Native attempts return usage without the built-in subscription's private events.
      // Keep admission, writer claim, settlement, and final persistence real.
      mockedRunEmbeddedAttempt.mockResolvedValueOnce(
        makeAttemptResult({
          sessionIdUsed: sessionId,
          assistantTexts: ["Done."],
          lastAssistant: assistant,
          currentAttemptAssistant: assistant,
          attemptUsage: normalizeUsage(assistant.usage),
        }),
      );

      const result = await runEmbeddedAgent({
        ...runParams,
        provider: "openai",
        model: "gpt-5.6-luna",
        onCompactionAccounting: candidate.observe,
      });
      await candidate.finish(sessionEntry);
      expect(result.meta.agentMeta?.lastCallUsage?.contextUsage).toEqual({
        state: "available",
        promptTokens: 13_357,
        totalTokens: 13_375,
      });
      expect(sessionStore[sessionKey]).toMatchObject({
        activeWriterRunId: "previous-writer",
        totalTokens: 0,
        totalTokensFresh: true,
      });
      expect(sessionAccessor.loadSessionEntry(sessionTarget)).toMatchObject({
        activeWriterRunId: runParams.runId,
      });
      if (writer === "replaced") {
        const { claimAgentSessionWriter } = await import("./run/session-bootstrap.js");
        await claimAgentSessionWriter({ ...runParams, runId: "replacement-writer" });
      }
      const beforeFinalization = sessionAccessor.loadSessionEntry(sessionTarget);

      await updateSessionStoreAfterAgentRun({
        agentId: sessionTarget.agentId,
        cfg: {},
        agentDir: path.dirname(sessionTarget.storePath),
        sessionId,
        sessionKey,
        storePath: sessionTarget.storePath,
        sessionStore,
        defaultProvider: "openai",
        defaultModel: "gpt-5.6-luna",
        result,
        compactionAccounting: accounting.fact,
      });

      const persisted = readLatest(sessionTarget);
      if (writer === "replaced") {
        expect(persisted).toEqual(beforeFinalization);
        expect(persisted).toMatchObject({ activeWriterRunId: "replacement-writer" });
      } else {
        expect(persisted).toMatchObject({
          totalTokens: 13_357,
          activeWriterRunId: runParams.runId,
          inputTokens: 3,
          outputTokens: 18,
          cacheRead: 0,
          cacheWrite: 13_354,
          totalTokensFresh: true,
          totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
        });
        expect(persisted?.compactionCount).toBeUndefined();
        expect(accounting.fact).toMatchObject({
          kind: "durable",
          count: 0,
          target: { ...sessionTarget, activeWriterRunId: runParams.runId },
        });
      }
      expect(accounting.fact?.currentContextSnapshot).toBeUndefined();
      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
      expect(mockedCompactDirect).not.toHaveBeenCalled();
    },
  );

  it("compacts and accounts a fresh persistent run whose first append creates the session row", async () => {
    const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
    const { SessionManager: PersistentSessionManager } =
      await import("../sessions/session-manager.js");
    const state = await createOpenClawTestState({ label: "fresh-persistent-recovery" });
    const { setRuntimeConfigSnapshot } = await import("../../config/runtime-snapshot.js");
    setRuntimeConfigSnapshot({});
    let manager: Awaited<ReturnType<typeof PersistentSessionManager.openAsync>> | undefined;
    let firstKeptEntryId: string | undefined;
    const runParams = {
      sessionId: "fresh-plugin-task",
      runId: "fresh-plugin-run",
      workspaceDir: state.workspaceDir,
      prompt: "Summarize the latest changes",
      timeoutMs: 30_000,
    };
    try {
      mockedRunEmbeddedAttempt
        .mockImplementationOnce(async (input) => {
          const attempt = input as EmbeddedRunAttemptInternalParams;
          const { agentId, sessionId, sessionKey, storePath } = attempt.sessionTarget ?? {};
          if (!agentId || !sessionId || !sessionKey || !storePath) {
            throw new Error("The public runner must resolve a complete durable target");
          }
          const durableTarget = {
            ...attempt.sessionTarget,
            agentId,
            sessionId,
            sessionKey,
            storePath,
          };
          expect(sessionAccessor.loadSessionEntry(durableTarget)).toBeUndefined();
          manager = await PersistentSessionManager.openAsync(durableTarget, state.workspaceDir);
          firstKeptEntryId = await manager.appendMessageAsync({
            role: "user",
            content: "hello",
            timestamp: 1,
          });
          expect(sessionAccessor.loadSessionEntry(durableTarget)).toMatchObject({
            sessionId: runParams.sessionId,
          });
          return { ...timeoutAttempt(), sessionIdUsed: runParams.sessionId };
        })
        .mockResolvedValueOnce(makeAttemptResult({ sessionIdUsed: runParams.sessionId }));
      mockedCompactDirect.mockImplementationOnce(async () => {
        if (!manager || !firstKeptEntryId) {
          throw new Error("First attempt must persist its real user turn before recovery");
        }
        await manager.appendCompactionAsync("Fresh session summary", firstKeptEntryId, 180_000);
        return makeCompactionSuccess({ summary: "Fresh session summary", tokensAfter: 40 });
      });

      const result = await runEmbeddedAgent(runParams);

      expect(mockedCompactDirect).toHaveBeenCalledOnce();
      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
      expect(result.meta.agentMeta?.compactionCount).toBe(1);
      const target = manager?.getSessionTarget();
      if (!target) {
        throw new Error("Fresh session must remain durable");
      }
      expect(readLatest(target)).toMatchObject({
        sessionId: runParams.sessionId,
        compactionCount: 1,
      });
    } finally {
      const { forgetActiveSessionForShutdown } =
        await import("../../gateway/active-sessions-shutdown-tracker.js");
      forgetActiveSessionForShutdown(runParams.sessionId);
      await state.cleanup();
    }
  });
});
