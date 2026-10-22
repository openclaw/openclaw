import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { expect, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { makeTextToolResult } from "../../../test/helpers/text-tool-result.js";
import type { ContextEngine } from "../../context-engine/types.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { PreparedAgentRunAdmission } from "../admitted-run-context.js";
import { serializeAgentEventCallback } from "../embedded-agent-subscribe.callback.js";
import type { EmbeddedRunCompactionRecoveryInput } from "./run/compaction-runtime.js";
import type { PreparedEmbeddedRunInput } from "./run/execution-context.js";
import { clearEmbeddedSessionPromptStates } from "./session-prompt-state.js";
import { createUsageAccumulator } from "./usage-accumulator.js";

type RecoveryKind = "overflow" | "timeout";
type AuthorityLoss = "closed" | "replaced" | "writer-replaced";
type FixtureOptions = {
  oversized?: boolean;
  replyAdmission?: boolean;
  inMemory?: boolean;
  detached?: boolean;
  historicalTurns?: number;
  contextTokenBudget?: number;
  toolResultText?: string;
};
export type RecoveryFixture = Awaited<ReturnType<typeof createRecoveryFixture>>;

// The engine is synthetic; admission, writer claims, safety timeout, recovery,
// hooks, session state, transcript writes, and reopen reads are composed for real.
async function createRecoveryFixture(state: OpenClawTestState, options: FixtureOptions) {
  const { workspaceDir } = state;
  const { appendTranscriptMessage, loadTranscriptEvents, loadSessionEntry, replaceSessionEntry } =
    await import("../../config/sessions/session-accessor.js");
  const { waitForSessionTranscriptIndexReconcile } =
    await import("../../config/sessions/session-transcript-reconcile.js");
  const { closeOpenClawAgentDatabaseByPathAsync } =
    await import("../../state/openclaw-agent-db.js");
  const { SessionManager } = await import("../sessions/session-manager.js");
  const { makeAgentAssistantMessage, makeAgentUserMessage } =
    await import("../test-helpers/agent-message-fixtures.js");
  const { makeAttemptResult, makeOverflowError } =
    await import("./run.overflow-compaction.fixture.js");
  const { createEmbeddedRunContextRecoveryState } = await import("./run/context-recovery-state.js");
  const { createEmbeddedRunCompactionRuntime } = await import("./run/compaction-runtime.js");
  const { createEmbeddedRunSessionPromptState } = await import("./run/session-prompt-state.js");
  const { claimAgentSessionWriter } = await import("./run/session-bootstrap.js");
  const { prepareSystemAgentRunAdmission, resolveAdmittedRunActiveAssertion } =
    await import("../admitted-run-context.js");
  const { getAgentRunLifecycleGeneration } = await import("../../infra/agent-run-registry.js");
  const { recoverEmbeddedRunOverflow } = await import("./run/overflow-context-recovery.js");
  const { recoverEmbeddedRunTimeout } = await import("./run/timeout-context-recovery.js");
  const { onInternalSessionTranscriptUpdate } = await import("../../sessions/transcript-events.js");
  const { forgetActiveSessionForShutdown } =
    await import("../../gateway/active-sessions-shutdown-tracker.js");
  const { createHookRunnerWithRegistry } = await import("../../plugins/hooks.test-fixtures.js");
  const { buildContextEngineRuntimeSettings } =
    await import("../../context-engine/runtime-settings.js");
  const { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } =
    await import("../../context-engine/host-compat.js");

  const { admitReplyTurn } = await import("../../auto-reply/reply/reply-turn-admission.js");
  const { waitForReplyRunSuccessorAdmission } =
    await import("../../sessions/session-controller.wait.js");
  let replyOperation: PreparedEmbeddedRunInput["runParams"]["replyOperation"];

  const memoryManager = options.inMemory ? SessionManager.inMemory(workspaceDir) : undefined;
  const sessionId = memoryManager?.getSessionId() ?? randomUUID();
  const identity = {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
  };
  const target = {
    ...identity,
    storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
  };
  const toolResult = makeTextToolResult(
    "fixture-call",
    "read",
    options.toolResultText ??
      (options.oversized === false ? "small output" : "fixture output ".repeat(1_800)),
    false,
    5,
  );
  const recentUser = makeAgentUserMessage({ content: "Read the fixture output", timestamp: 3 });
  const messages = [
    makeAgentUserMessage({ content: "Earlier topic", timestamp: 1 }),
    makeAgentAssistantMessage({
      content: [{ type: "text", text: "Earlier answer" }],
      timestamp: 2,
    }),
    recentUser,
    makeAgentAssistantMessage({
      content: [
        { type: "toolCall", id: "fixture-call", name: "read", arguments: { path: "fixture.txt" } },
      ],
      stopReason: "toolUse",
      timestamp: 4,
    }),
    toolResult,
  ];
  if (!memoryManager) {
    await replaceSessionEntry(target, { sessionId, updatedAt: 1 });
  }
  if (options.historicalTurns) {
    const history = memoryManager ?? (await SessionManager.openAsync(target, workspaceDir));
    for (let index = 0; index < options.historicalTurns; index += 1) {
      await history.appendMessageAsync(
        makeAgentUserMessage({ content: `Archived request ${index}` }),
      );
      await history.appendMessageAsync(
        makeAgentAssistantMessage({
          content: [{ type: "toolCall", id: `archived-${index}`, name: "read", arguments: {} }],
          stopReason: "toolUse",
        }),
      );
      await history.appendMessageAsync({
        ...toolResult,
        toolCallId: `archived-${index}`,
        content: [{ type: "text", text: "archived output ".repeat(12_000) }],
      });
      await history.appendResetBoundaryAsync("new");
    }
  }
  let recentUserId: string | undefined;
  for (const message of messages) {
    const messageId = memoryManager
      ? await memoryManager.appendMessageAsync(message)
      : (await appendTranscriptMessage(target, { cwd: workspaceDir, message })).messageId;
    if (message === recentUser) {
      recentUserId = messageId;
    }
  }
  const firstKeptEntryId = expectDefined(
    recentUserId,
    "Fixture must persist the recent user before compaction",
  );
  const controller = new AbortController();
  const callerError = new Error("caller stopped the admitted recovery");
  const runId = randomUUID();
  const admission = prepareSystemAgentRunAdmission({}, runId, "main", "compaction-recovery-test");
  const admissions: PreparedAgentRunAdmission[] = [admission];
  const work: Promise<unknown>[] = [];
  let unsubscribe = () => {};
  let forgetCommittedSuccessor = () => {};
  const drain = () =>
    waitForSessionTranscriptIndexReconcile({
      agentId: target.agentId,
      path: target.storePath,
      env: state.env,
    });
  const dispose = async () => {
    for (const ownedAdmission of admissions) {
      ownedAdmission.close();
    }
    controller.abort(callerError);
    await Promise.allSettled(work);
    if (replyOperation) {
      replyOperation.complete();
      await waitForReplyRunSuccessorAdmission(target.sessionKey, null);
    }
    try {
      await drain();
    } finally {
      unsubscribe();
      forgetActiveSessionForShutdown(target.sessionId);
      forgetCommittedSuccessor();
      await closeOpenClawAgentDatabaseByPathAsync(target.storePath, target.agentId);
    }
  };
  try {
    const admittedRunContext = await admission.admit("embedded");
    const assertActive = expectDefined(
      resolveAdmittedRunActiveAssertion(admittedRunContext, controller.signal),
      "Fixture must capture a real live admission",
    );
    assertActive();
    const runParams: PreparedEmbeddedRunInput["runParams"] = {
      ...identity,
      runId,
      sessionFile: target.sessionKey,
      workspaceDir,
      prompt: "continue",
      timeoutMs: 30_000,
      config: {},
      abortSignal: controller.signal,
      admittedRunContext,
      sessionPersistence: options.detached ? "detached" : undefined,
      ...(memoryManager
        ? { sessionManager: memoryManager, sessionPersistence: "detached" }
        : { sessionTarget: target }),
    };
    const writerFence = await claimAgentSessionWriter(runParams);
    if (memoryManager || options.detached) {
      expect(writerFence).toBeUndefined();
    } else {
      expect(writerFence?.expectedWriterRunId).toBe(runId);
      runParams.sessionTarget = {
        ...target,
        expectedLifecycleRevision: writerFence?.expectedLifecycleRevision,
        expectedWriterRunId: writerFence?.expectedWriterRunId,
      };
    }
    if (options.replyAdmission) {
      const reply = await admitReplyTurn({
        ...target,
        kind: "visible",
        resetTriggered: false,
        upstreamAbortSignal: controller.signal,
      });
      if (reply.status !== "owned") {
        throw new Error("Fixture requires retained reply admission");
      }
      replyOperation = reply.operation;
      runParams.replyOperation = replyOperation;
    }
    const sessionPromptState = await createEmbeddedRunSessionPromptState({
      runParams,
      sessionAgentId: "main",
      resolvedSessionKey: target.sessionKey,
      lifecycleGeneration: getAgentRunLifecycleGeneration(),
      onInterrupt: (reason) => controller.abort(reason),
    });
    forgetCommittedSuccessor = () => {
      const accepted = sessionPromptState.committedCompactionSuccessor;
      clearEmbeddedSessionPromptStates([sessionId, sessionPromptState.sessionId]);
      if (accepted) {
        forgetActiveSessionForShutdown(accepted.sessionId);
      }
    };
    // The worker accepts only the exact fence fields carried by an admitted run target.
    const fencedTarget = {
      ...target,
      expectedLifecycleRevision: writerFence?.expectedLifecycleRevision,
      expectedWriterRunId: writerFence?.expectedWriterRunId,
    };
    const openWriter = async () =>
      memoryManager ?? (await SessionManager.openAsync(fencedTarget, workspaceDir));
    const compact = vi.fn<ContextEngine["compact"]>(async () => {
      const writer = await openWriter();
      await writer.appendCompactionAsync("Summary of earlier topic", firstKeptEntryId, 4_097);
      return recoveryCompaction({ summary: "Summary of earlier topic", firstKeptEntryId });
    });
    const maintain = vi.fn<NonNullable<ContextEngine["maintain"]>>(async () =>
      unchangedMaintenance(),
    );
    const track = <T>(pending: Promise<T>) => {
      work.push(pending);
      return pending;
    };
    const contextEngine: ContextEngine = {
      info: { id: "fixture-engine", name: "Fixture engine", ownsCompaction: true },
      ingest: async () => {
        throw new Error("Unexpected ingest in recovery");
      },
      assemble: async () => {
        throw new Error("Unexpected assemble in recovery");
      },
      compact: (params) => track(compact(params)),
      maintain: (params) => track(maintain(params)),
    };
    const beforeHook = vi.fn(async () => {});
    const afterHook = vi.fn(async () => {});
    const { runner: hookRunner } = createHookRunnerWithRegistry([
      { hookName: "before_compaction", handler: beforeHook },
      { hookName: "after_compaction", handler: afterHook },
    ]);
    const onAgentEvent =
      vi.fn<NonNullable<PreparedEmbeddedRunInput["runParams"]["onAgentEvent"]>>();
    runParams.onAgentEvent = serializeAgentEventCallback(onAgentEvent);
    const runtime = createEmbeddedRunCompactionRuntime({
      runParams,
      contextEngine,
      hookRunner,
      hookContext: { ...identity, workspaceDir },
      sessionPromptState,
    });
    const recoveryState = createEmbeddedRunContextRecoveryState();
    const usageAccumulator = createUsageAccumulator();
    const retries = [
      vi.spyOn(sessionPromptState, "prepareCompactedTranscriptRetry"),
      vi.spyOn(sessionPromptState, "continueFromCurrentTranscript"),
      vi.spyOn(sessionPromptState, "markOwnedTranscriptRetry"),
    ];
    const armPostCompactionGuard = vi.fn();
    const updates = vi.fn();
    unsubscribe = onInternalSessionTranscriptUpdate((event) => {
      if (event.sessionKey === target.sessionKey) {
        updates(event);
      }
    });
    const recover = (kind: RecoveryKind, mixedPreflight = false) => {
      const promptError = makeOverflowError();
      const input: EmbeddedRunCompactionRecoveryInput = {
        runParams,
        state: recoveryState,
        usageAccumulator,
        contextEngine,
        contextTokenBudget: options.contextTokenBudget ?? 4_096,
        genericCompactionRecoveryAllowed: true,
        attempt: makeAttemptResult({
          ...(kind === "timeout" ? { timedOut: true } : { promptError }),
          sessionIdUsed: sessionId,
          messagesSnapshot: messages,
          ...(mixedPreflight
            ? { preflightRecovery: { route: "compact_then_truncate", source: "mid-turn" } }
            : {}),
        }),
        runtimeAuthPlan: undefined,
        resolvedSessionKey: target.sessionKey,
        sessionAgentId: "main",
        agentDir: state.agentDir(),
        workspaceDir,
        modelSelection: {
          provider: "fixture-provider",
          model: "fixture-model",
          authProfileIdSource: "auto",
        },
        harnessRuntime: "openclaw",
        thinkLevel: "off",
        resolveContextEnginePluginId: () => undefined,
        buildRuntimeSettings: ({ tokenBudget, degradedReason }) =>
          buildContextEngineRuntimeSettings({
            contextEngineHost: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
            promptTokenBudget: tokenBudget,
            degradedReason,
          }),
        ...runtime,
        getActiveSession: () => ({
          id: sessionPromptState.sessionId,
          file: sessionPromptState.sessionFile,
          target: sessionPromptState.sessionTarget,
        }),
        prepareCompactedTranscriptRetry: sessionPromptState.prepareCompactedTranscriptRetry,
        armPostCompactionGuard,
      };
      if (kind === "timeout") {
        return recoverEmbeddedRunTimeout({
          ...input,
          timedOut: true,
          signalOwnedInterruption: false,
          timedOutDuringCompaction: false,
          timedOutDuringToolExecution: false,
          timedOutByRunBudget: false,
          lastRunPromptUsage: { input: 3_100, total: 3_100 },
        });
      }
      return recoverEmbeddedRunOverflow({
        ...input,
        aborted: false,
        signalOwnedInterruption: false,
        promptError,
        attemptCompactionCount: 0,
        prepareCurrentTranscriptRetry: sessionPromptState.continueFromCurrentTranscript,
        markOwnedTranscriptRetry: sessionPromptState.markOwnedTranscriptRetry,
      });
    };
    const snapshot = async () => {
      await drain();
      // Reopen independently: a cached manager can hide a durable append or leaf change.
      await closeOpenClawAgentDatabaseByPathAsync(target.storePath, target.agentId);
      const manager = memoryManager ?? (await SessionManager.openAsync(target, workspaceDir));
      const events = memoryManager
        ? memoryManager.getEntries()
        : await loadTranscriptEvents(target);
      const entries = manager.getEntries();
      return {
        resetCount: entries.filter((entry) => entry.type === "reset").length,
        eventDigests: events.map((entry) =>
          createHash("sha256").update(JSON.stringify(entry)).digest("hex"),
        ),
        leafId: manager.getLeafId(),
        compactionIds: entries
          .filter((entry) => entry.type === "compaction")
          .map((entry) => entry.id),
        toolResultChars: manager.buildSessionContext().messages.reduce((sum, message) => {
          if (message.role !== "toolResult") {
            return sum;
          }
          return message.content.reduce(
            (chars, block) => chars + (block.type === "text" ? block.text.length : 0),
            sum,
          );
        }, 0),
      };
    };
    const invalidate = async (loss: AuthorityLoss) => {
      if (loss === "closed") {
        admission.close();
      } else {
        const replacementRunId = loss === "replaced" ? runId : randomUUID();
        const replacement = prepareSystemAgentRunAdmission(
          {},
          replacementRunId,
          "main",
          "replacement-recovery-test",
        );
        admissions.push(replacement);
        const replacementContext = await replacement.admit("embedded");
        if (loss === "writer-replaced") {
          const replacementFence = await claimAgentSessionWriter({
            ...runParams,
            runId: replacementRunId,
            admittedRunContext: replacementContext,
          });
          expect(replacementFence?.expectedWriterRunId).toBe(replacementRunId);
          // No registered runner handle exists here: only the durable writer changes.
          assertActive();
        }
      }
      expect(controller.signal.aborted).toBe(false);
      if (loss !== "writer-replaced") {
        expect(assertActive).toThrow();
      }
    };
    const expectNoContinuation = () => {
      for (const retry of [...retries, armPostCompactionGuard]) {
        expect(retry).not.toHaveBeenCalled();
      }
      expect(
        onAgentEvent.mock.calls.filter(
          ([event]) =>
            event.stream !== "compaction" ||
            (event.data.phase !== "start" && event.data.phase !== "end"),
        ),
      ).toEqual([]);
    };
    return {
      compact,
      maintain,
      target,
      replyOperation,
      beforeHook,
      afterHook,
      onAgentEvent,
      updates,
      controller,
      callerError,
      recoveryState,
      runId,
      recover,
      snapshot,
      invalidate,
      openWriter,
      expectNoContinuation,
      assertActive,
      dispose,
      stop: () => {
        admission.close();
        controller.abort(callerError);
      },
      loadEntry: () => loadSessionEntry(target),
      getCommittedSuccessor: () => sessionPromptState.committedCompactionSuccessor,
      getSessionTarget: () => sessionPromptState.sessionTarget,
      replacement: {
        entryId: firstKeptEntryId,
        message: makeAgentUserMessage({ content: "Maintenance replacement", timestamp: 3 }),
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

export function recoveryCompaction(
  result: Partial<NonNullable<Awaited<ReturnType<ContextEngine["compact"]>>["result"]>> = {},
) {
  return {
    ok: true,
    compacted: true,
    result: { summary: "successor context", tokensBefore: 4_097, tokensAfter: 3_000, ...result },
  };
}

export function unchangedMaintenance() {
  return { changed: false, rewrittenEntries: 0, bytesFreed: 0 };
}

export async function withRecoveryFixture(
  options: FixtureOptions,
  body: (fixture: RecoveryFixture) => Promise<void>,
) {
  await withOpenClawTestState(
    { label: "compaction-recovery", scenario: "minimal" },
    async (state) => {
      const fixture = await createRecoveryFixture(state, options);
      try {
        await body(fixture);
      } finally {
        await fixture.dispose();
      }
    },
  );
}

export async function waitForCompactionAbort(
  signal: AbortSignal | undefined,
  onStarted?: () => void,
): Promise<never> {
  if (!signal) {
    throw new Error("Compaction must receive the real safety-wrapper signal");
  }
  if (signal.aborted) {
    throw toErrorObject(signal.reason, "Compaction aborted");
  }
  const pending = createDeferred<never>();
  const onAbort = () => pending.reject(toErrorObject(signal.reason, "Compaction aborted"));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    onStarted?.();
    return await pending.promise;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
