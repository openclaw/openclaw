import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readMessageIdempotencyKey } from "../../../config/sessions/transcript-message-identity.js";
import { sameSessionTranscriptTargetBinding } from "../../../config/sessions/transcript-target-binding.js";
import {
  assertOwnedTranscriptWriteCommit,
  SessionTranscriptWriterClaimReboundError,
  withSessionTranscriptWriteAssertion,
} from "../../../config/sessions/transcript-write-context.js";
import { isIncognitoSessionKey } from "../../../routing/session-key.js";
import {
  mergeAgentRunAttemptTerminal,
  projectAgentRunAttemptTerminal,
  setAgentRunAttemptTerminalFailure,
  type AgentRunAttemptFailureSource,
} from "../../agent-run-terminal-outcome.js";
import { sanitizeCompactionReplayMessages } from "../../compaction-replay.js";
import type { AgentMessage } from "../../runtime/index.js";
import { SessionTranscriptMessageCommittedError } from "../../sessions/session-manager-message-error.js";
import {
  appendSessionTranscriptNote,
  withSessionManagerWrite,
} from "../../sessions/session-manager-write-admission.js";
import { log } from "../logger.js";
import { clearActiveEmbeddedRun } from "../runs.js";
import { joinWithRunLivenessDeadline, RUN_LIVENESS_JOIN_TIMEOUT_MS } from "./abortable.js";
import type { EmbeddedAttemptExecutionPhaseInput } from "./attempt-execution-types.js";
import { completeEmbeddedAttemptAfterTurn } from "./attempt-finalize.js";
import {
  runEmbeddedAttemptPromptPhase,
  type EmbeddedAttemptPromptState,
} from "./attempt-prompt-phase.js";
import {
  completeEmbeddedAttemptResult,
  type EmbeddedRunAttemptWithReceiptEvidence,
} from "./attempt-result.js";
import type { PreparedStreamRuntime } from "./attempt-stream-runtime.types.js";
import { settleEmbeddedAttemptStream } from "./attempt-stream-settle.js";
import type { EmbeddedAttemptDeferredLifecycleOwner } from "./deferred-lifecycle-owner.js";
import { buildPromptImageFailureNotice } from "./images.js";
import type { EmbeddedAttemptExecutionState, EmbeddedRunAttemptParams } from "./types.js";

const FAILED_PROMPT_MEDIA_NOTE_TYPE = "openclaw.system-note";
const FAILED_PROMPT_MEDIA_NOTE_SOURCE = "prompt-image-hydration";

type StreamCleanupInput = {
  attempt: EmbeddedRunAttemptParams;
  clearAttemptTimeoutTimers: () => void;
  isProbeSession: boolean;
  queueHandle: PreparedStreamRuntime["stream"]["queueHandle"];
  state: EmbeddedAttemptExecutionState;
  unsubscribe: () => void;
  deferredLifecycleOwner?: EmbeddedAttemptDeferredLifecycleOwner;
};

function cleanupEmbeddedAttemptStreamExecution(input: StreamCleanupInput): Error | undefined {
  const { attempt, state } = input;
  const terminal = projectAgentRunAttemptTerminal(state.terminal);
  input.clearAttemptTimeoutTimers();
  if (
    !input.isProbeSession &&
    (terminal.aborted || terminal.timedOut) &&
    !terminal.timedOutDuringCompaction
  ) {
    log.debug(
      `run cleanup: runId=${attempt.runId} sessionId=${attempt.sessionId} aborted=${terminal.aborted} timedOut=${terminal.timedOut}`,
    );
  }
  // Every release belongs to this owner; one broken callback must not strand
  // the active run or mask the prompt failure that caused teardown.
  let firstCleanupError: Error | undefined;
  const cleanups: Array<readonly [string, () => void]> = [
    ["unsubscribe", input.unsubscribe],
    ["backend detach", () => attempt.replyOperation?.detachBackend(input.queueHandle)],
  ];
  if (!input.deferredLifecycleOwner) {
    cleanups.push([
      "active run cleanup",
      () =>
        clearActiveEmbeddedRun(
          attempt.sessionId,
          input.queueHandle,
          attempt.sessionKey,
          attempt.sessionFile,
        ),
    ]);
  }
  for (const [name, cleanup] of cleanups) {
    try {
      cleanup();
    } catch (error) {
      firstCleanupError ??= error instanceof Error ? error : new Error(String(error));
      log.error(
        `CRITICAL: ${name} failed, possible resource leak: runId=${attempt.runId} ${String(error)}`,
      );
    }
  }
  return firstCleanupError;
}

export async function runEmbeddedAttemptSettledPhase(
  input: EmbeddedAttemptExecutionPhaseInput & {
    getRepairedRejectedProviderReplay: () => boolean;
    preparedStreamRuntime: PreparedStreamRuntime;
  },
): Promise<EmbeddedRunAttemptWithReceiptEvidence> {
  const { attempt, state } = input;
  const { sessionRuntime, toolBase } = input.prepared;
  const {
    agentSession: { activeSession },
    sessionManager,
    state: sessionRuntimeState,
    toolResultPromptProjectionState,
    transport: { effectivePromptCacheRetention },
  } = sessionRuntime;
  const { nestedToolActivityState } = toolBase;
  const promptState: EmbeddedAttemptPromptState = {
    contextBudgetStatus: undefined,
    preflightRecovery: undefined,
    yieldAborted: false,
  };
  const preparedStreamRuntime = input.preparedStreamRuntime;
  const {
    abortable,
    isProbeSession,
    onBlockReplyFlush,
    stream: preparedStream,
    timeout: attemptTimeout,
  } = preparedStreamRuntime;
  const {
    subscription,
    queueHandle,
    getBeforeAgentFinalizeRevisionReason,
    getBeforeAgentFinalizeRevisionEntryId,
  } = preparedStream;
  const { unsubscribe, waitForPendingEvents } = subscription;
  const { getRunAbortDeadlineAtMs, clearTimers: clearAttemptTimeoutTimers } = attemptTimeout;
  let settledStream: Awaited<ReturnType<typeof settleEmbeddedAttemptStream>>;
  let messagesSnapshot: AgentMessage[] = [];
  let sessionIdUsed = activeSession.sessionId;
  const sessionFileUsed = attempt.sessionFile;
  let cleanupError: Error | undefined;
  const readTerminal = () => projectAgentRunAttemptTerminal(state.terminal);
  const setFailure = (error: unknown, source: AgentRunAttemptFailureSource | null) => {
    state.terminal = setAgentRunAttemptTerminalFailure(
      state.terminal,
      error !== null && error !== undefined ? { error, source: source ?? "prompt" } : null,
    );
  };
  const markTimedOutDuringCompaction = () => {
    state.terminal = mergeAgentRunAttemptTerminal(state.terminal, {
      kind: "timeout",
      phase: "compaction",
      source: "observation",
    });
  };

  try {
    const { promptStartedAt, transcriptLeafId } = await runEmbeddedAttemptPromptPhase(
      input,
      promptState,
    );

    // Only a failure-free run-budget terminal may publish buffered text.
    const isFailureFreeRunBudgetTimeout = (): boolean => {
      const terminal = readTerminal();
      return terminal.timedOutByRunBudget && !terminal.failed;
    };
    const runBudgetTimeoutTerminal = isFailureFreeRunBudgetTimeout();
    const drainPendingEventsBounded = (afterRunBudgetTimeout: boolean) =>
      joinWithRunLivenessDeadline({
        // Partial-reply callbacks cannot mutate the buffer and may be stalled
        // on transport; timeout salvage needs only the serialized event chain.
        joinWork: afterRunBudgetTimeout
          ? () => waitForPendingEvents({ includePartialReplies: false })
          : waitForPendingEvents,
        ...(afterRunBudgetTimeout ? {} : { runAbortSignal: input.runAbortController.signal }),
        onTimeout: () => {
          log.warn(
            `pending subscription events did not settle within ${RUN_LIVENESS_JOIN_TIMEOUT_MS}ms; ` +
              `proceeding to stream settlement: runId=${attempt.runId}`,
          );
        },
      });
    if (!runBudgetTimeoutTerminal) {
      await drainPendingEventsBounded(false);
    }
    // A timeout may already have aborted the signal, or fire during the first
    // join. Re-read ownership before draining without racing that signal.
    if (runBudgetTimeoutTerminal || isFailureFreeRunBudgetTimeout()) {
      await drainPendingEventsBounded(true);
    }
    // Ownership can change during the drain; publish only after the final read.
    if (isFailureFreeRunBudgetTimeout()) {
      subscription.flushPartialAssistantText();
    }
    const beforeAgentFinalizeRevisionReason = getBeforeAgentFinalizeRevisionReason();
    const beforeAgentFinalizeRevisionEntryId = getBeforeAgentFinalizeRevisionEntryId();
    let rewoundBeforeAgentFinalizeRevision = false;
    if (beforeAgentFinalizeRevisionReason && beforeAgentFinalizeRevisionEntryId) {
      await input.sessionLock.withOwnedTranscriptWrite(() =>
        withSessionManagerWrite(sessionManager, async () => {
          const rejectedEntry = sessionManager.getEntry(beforeAgentFinalizeRevisionEntryId);
          if (rejectedEntry?.type !== "message" || rejectedEntry.message.role !== "assistant") {
            throw new Error(
              `before_agent_finalize persisted assistant entry is missing or invalid ` +
                `(entry=${beforeAgentFinalizeRevisionEntryId})`,
            );
          }
          // Keep persistence append-only while excluding the rejected draft and
          // every trailing descendant from the hidden retry's active branch.
          await sessionManager.appendLeafControlAsync({
            targetId: rejectedEntry.parentId,
            appendParentId: rejectedEntry.parentId,
          });
          rewoundBeforeAgentFinalizeRevision = true;
        }),
      );
    }
    try {
      if (input.getRepairedRejectedProviderReplay() && !rewoundBeforeAgentFinalizeRevision) {
        activeSession.agent.state.messages = sanitizeCompactionReplayMessages(
          sessionManager.buildSessionContext().messages,
        );
      }
      const settleTerminal = readTerminal();
      const streamSettleState = {
        promptError: settleTerminal.promptError,
        promptErrorSource: settleTerminal.promptErrorSource,
        yieldAborted: promptState.yieldAborted,
      };
      try {
        settledStream = await settleEmbeddedAttemptStream({
          attempt,
          activeSession,
          sessionManager,
          toolResultPromptProjectionState,
          withOwnedTranscriptWrite: input.sessionLock.withOwnedTranscriptWrite,
          state: streamSettleState,
          getRunAbortDeadlineAtMs,
          shouldFlushForContextEngine: Boolean(
            input.activeContextEngine && !getBeforeAgentFinalizeRevisionReason(),
          ),
          subscription,
          readLifecycleState: readTerminal,
          markTimedOutDuringCompaction,
          runAbortSignal: input.runAbortController.signal,
          isProbeSession,
          onBlockReplyFlush,
          abortable,
          prePromptMessageCount: sessionRuntimeState.prePromptMessageCount,
          nestedToolActivityState,
          cache: {
            getObservation: preparedStreamRuntime.cache.getObservation,
            retention: effectivePromptCacheRetention,
          },
        });
      } catch (error) {
        // Settlement mutates this shared state before some failures. Publish it so
        // outer teardown keeps the recorded prompt error and attribution.
        setFailure(streamSettleState.promptError, streamSettleState.promptErrorSource);
        throw error;
      }
    } finally {
      if (rewoundBeforeAgentFinalizeRevision) {
        await input.sessionLock.withOwnedTranscriptWrite(() => {
          // Settlement classifies the completed attempt from its original
          // in-memory messages. Later work always sees the rewound branch.
          activeSession.agent.state.messages = sanitizeCompactionReplayMessages(
            sessionManager.buildSessionContext().messages,
          );
        });
      }
    }
    // Publish settled fields before after-turn hooks: those hooks may throw, and
    // outer teardown still needs the completed stream snapshot and usage state.
    setFailure(settledStream.promptError, settledStream.promptErrorSource);
    if (settledStream.timedOutDuringCompaction) {
      markTimedOutDuringCompaction();
    }
    messagesSnapshot = settledStream.messagesSnapshot;
    sessionIdUsed = settledStream.sessionIdUsed;
    sessionRuntimeState.promptCache = settledStream.promptCache;

    await completeEmbeddedAttemptAfterTurn(input, settledStream, {
      yieldAborted: promptState.yieldAborted,
      transcriptLeafId,
      promptStartedAt,
      ...(beforeAgentFinalizeRevisionReason ? { beforeAgentFinalizeRevisionReason } : {}),
    });

    // Keep dedupe stable without exposing the run ID when note metadata is redacted.
    const imageFailureNoteKey =
      sessionRuntimeState.currentTurnImageFailureCount > 0
        ? `${FAILED_PROMPT_MEDIA_NOTE_SOURCE}:${sha256Hex(attempt.runId)}`
        : undefined;
    if (
      imageFailureNoteKey &&
      !activeSession.messages.some(
        (message) =>
          readMessageIdempotencyKey(message) === imageFailureNoteKey ||
          (message.role === "custom" &&
            message.customType === FAILED_PROMPT_MEDIA_NOTE_TYPE &&
            asOptionalRecord(message.details)?.source === FAILED_PROMPT_MEDIA_NOTE_SOURCE &&
            asOptionalRecord(message.details)?.runId === attempt.runId),
      )
    ) {
      const note = {
        role: "custom" as const,
        customType: FAILED_PROMPT_MEDIA_NOTE_TYPE,
        content: buildPromptImageFailureNotice(sessionRuntimeState.currentTurnImageFailureCount),
        display: true,
        idempotencyKey: imageFailureNoteKey,
        details: {
          source: FAILED_PROMPT_MEDIA_NOTE_SOURCE,
          runId: attempt.runId,
          failedMediaCount: sessionRuntimeState.currentTurnImageFailureCount,
        },
        timestamp: Date.now(),
      };
      const target = sessionManager.getSessionTarget();
      const sessionId = sessionManager.getSessionId();
      const assertBinding = () => {
        if (
          sessionManager.getSessionId() !== sessionId ||
          !sameSessionTranscriptTargetBinding(target, sessionManager.getSessionTarget())
        ) {
          throw new SessionTranscriptWriterClaimReboundError();
        }
      };
      let committedMessageId: string | undefined;
      try {
        await input.sessionLock.withOwnedTranscriptWrite(async () => {
          assertBinding();
          if (target) {
            const appendAndPublish = async () => {
              assertBinding();
              const committed = await withSessionTranscriptWriteAssertion(
                target,
                assertBinding,
                () =>
                  appendSessionTranscriptNote(
                    target,
                    note,
                    attempt.config ? { config: attempt.config } : undefined,
                  ),
              );
              committedMessageId = committed.messageId;
              assertBinding();
              assertOwnedTranscriptWriteCommit(target);
              if (committed.appended || committed.currentTail) {
                activeSession.agent.state.messages = [...activeSession.messages, committed.message];
                messagesSnapshot = [...messagesSnapshot, committed.message];
              }
            };
            if (isIncognitoSessionKey(target.sessionKey)) {
              await withSessionManagerWrite(sessionManager, appendAndPublish);
            } else {
              await appendAndPublish();
            }
          } else {
            await withSessionManagerWrite(sessionManager, async () => {
              assertBinding();
              await sessionManager.appendMessageAsync(note);
              assertBinding();
              activeSession.agent.state.messages = [...activeSession.messages, note];
              messagesSnapshot = [...messagesSnapshot, note];
            });
          }
        });
      } catch (error) {
        if (committedMessageId && target) {
          throw new SessionTranscriptMessageCommittedError(committedMessageId, error, target);
        }
        throw error;
      }
    }
  } finally {
    cleanupError = cleanupEmbeddedAttemptStreamExecution({
      attempt,
      clearAttemptTimeoutTimers,
      isProbeSession,
      queueHandle,
      state,
      unsubscribe,
      deferredLifecycleOwner: preparedStreamRuntime.stream.deferredLifecycleOwner,
    });
  }

  if (cleanupError !== undefined) {
    throw cleanupError;
  }

  const beforeAgentFinalizeRevisionReason = getBeforeAgentFinalizeRevisionReason();
  const result = completeEmbeddedAttemptResult(input, settledStream, {
    ...promptState,
    sessionIdUsed,
    sessionFileUsed,
    messagesSnapshot,
    ...(beforeAgentFinalizeRevisionReason ? { beforeAgentFinalizeRevisionReason } : {}),
  });
  state.trajectoryEndRecorded = true;
  return result;
}
