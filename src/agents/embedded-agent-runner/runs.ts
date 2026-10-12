import {
  collectErrorGraphCandidates,
  readErrorCauses,
} from "@openclaw/normalization-core/error-coercion";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  MessageInjectionAcceptedUnconfirmedError,
  MessageInjectionAuthorityError,
  MessageInjectionWithdrawnError,
} from "../../auto-reply/reply/message-injection-authority.js";
import type { ReplyMessageInjectionOptions } from "../../auto-reply/reply/reply-run-registry.contracts.js";
import {
  abortActiveReplyRuns,
  abortReplyRunBySessionId,
  expireStaleReplyRunBySessionId,
  forceClearReplyOperation,
  hasCommittedReplyOperationOutcome,
  hasReplyOperationExecutionStarted,
  isReplyRunEvidenceStaleBySessionId,
  isReplyRunActiveForSessionId,
  isReplyRunAbortableForCompaction,
  listActiveReplyRunSessionIds,
  resolveActiveReplyOperationForSessionId,
  resolveActiveReplyRunSessionId,
  resolveReplyBackendQueueMessageMismatch,
  supersedeReplyRunByRunId,
  type ReplyOperation,
  waitForReplyOperationOwnerSettlement,
} from "../../auto-reply/reply/reply-run-registry.js";
import {
  getAttachedBackend,
  isReplyOperationAbortable,
} from "../../auto-reply/reply/reply-run-registry.state.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../infra/agent-events.js";
import {
  getActiveAgentRunDelegatedAuthority,
  getAgentRunContext,
} from "../../infra/agent-run-registry.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { notifyGatewayWorkMetricsChanged } from "../../infra/gateway-work-metrics-events.js";
import {
  getDiagnosticSessionActivitySnapshot,
  isDiagnosticEmbeddedRunOwnerClosed,
  markDiagnosticEmbeddedRunEnded,
  markDiagnosticEmbeddedRunStarted,
  markDiagnosticRunProgress,
  resolveRunStaleThresholdMs,
} from "../../logging/diagnostic-run-activity.js";
import { logMessageQueuedWithBacklogPolicy } from "../../logging/diagnostic-runtime.js";
import { diagnosticLogger as diag, logSessionStateChange } from "../../logging/diagnostic.js";
import { hasPromptImageInput } from "../../media/prompt-image-input.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { settlesWithin } from "../../shared/settle-within.js";
import { QuestionAnswerUnconfirmedError } from "../harness/gateway-question-dispatch.js";
import { resolveSessionPlacementForcedTerminalSettlement } from "../session-placement-forced-terminal-settlement.js";
import { getGatewayToolCallerIdentity } from "../tools/gateway-caller-context.js";
import {
  notifyEmbeddedRunEnded,
  waitForCurrentEmbeddedAgentRunEnd,
  waitForEmbeddedAgentRunEnd,
} from "./active-run-projections.js";
import {
  persistForceClearedEmbeddedRunTerminalState,
  tryLoadForceClearSessionSnapshot,
} from "./force-clear-session-state.js";
import {
  createEmbeddedMessageInjectionQueue,
  prepareEmbeddedInjectionAuthority,
  resolveEmbeddedInjection,
  type EmbeddedInjectionPreparation,
} from "./message-injection-target.js";
import {
  ACTIVE_EMBEDDED_RUNS,
  ACTIVE_EMBEDDED_RUNS_BY_RUN_ID,
  ACTIVE_EMBEDDED_RUN_REGISTRATIONS,
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE,
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY,
  ACTIVE_EMBEDDED_RUN_SNAPSHOTS,
  ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID,
  ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE,
  ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY,
  EMBEDDED_RUN_COMPLETION_CLAIMS,
  EMBEDDED_RUN_FORCED_TERMINAL_SETTLEMENTS,
  EMBEDDED_RUN_WAITERS,
  RETAINED_EMBEDDED_RUN_ABORTABILITY_RUN_IDS,
  setActiveEmbeddedRunLifecycleGeneration,
  setActiveEmbeddedRunSessionIndexes,
  resolveActiveEmbeddedRunRecoveryBlocker,
  type ActiveEmbeddedRunSnapshot,
  type AbortAndDrainEmbeddedAgentRunResult,
  type AbandonedEmbeddedRun,
  type EmbeddedAgentQueueHandle,
  type EmbeddedRunCompletionClaim,
  type EmbeddedRunCompletionRegistration,
  type EmbeddedRunRegistration,
  type EmbeddedRunWaiter,
  type EmbeddedAgentQueueFailureReason,
  type EmbeddedAgentQueueMessageOutcome,
  type PreparedEmbeddedAgentQueueMessage,
} from "./run-state.js";
import {
  canSteerEmbeddedRunDuringCompaction,
  isEmbeddedRunHandleAbortable,
  isEmbeddedRunHandleSupersedable,
} from "./runs.probes.js";
import {
  clearActiveRunSessionIndex,
  normalizeSessionFileRegistryKey,
} from "./runs.session-index.js";
export { isEmbeddedAgentRunActive, waitForEmbeddedAgentRunEnd } from "./active-run-projections.js";

export type {
  EmbeddedAgentQueueHandle,
  EmbeddedAgentQueueMessageOptions,
  EmbeddedAgentQueueMessageOutcome,
} from "./run-state.js";

export type EmbeddedRunTimeoutRecoveryMarker = {
  sessionId: string;
  recoveryToken: symbol;
};

function createQueueFailureOutcome(
  sessionId: string,
  reason: EmbeddedAgentQueueFailureReason,
  errorMessage?: string,
): EmbeddedAgentQueueMessageOutcome {
  return {
    queued: false,
    sessionId,
    reason,
    gatewayHealth: "live",
    ...(errorMessage ? { errorMessage } : {}),
  };
}

export function formatEmbeddedAgentQueueFailureSummary(
  outcome: EmbeddedAgentQueueMessageOutcome,
): string | undefined {
  if (outcome.queued) {
    return undefined;
  }
  const errorPart = outcome.errorMessage ? ` error=${outcome.errorMessage}` : "";
  return `queue_message_failed reason=${outcome.reason} sessionId=${outcome.sessionId} gatewayHealth=${outcome.gatewayHealth}${errorPart}`;
}
function clearEmbeddedRunAbandonmentBySessionId(sessionId: string): void {
  const abandonedRun = ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.get(sessionId);
  if (!abandonedRun) {
    return;
  }
  ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.delete(sessionId);
  const clearIndex = (index: Map<string, string>, key: string | undefined) => {
    if (key && index.get(key) === sessionId) {
      index.delete(key);
    }
  };
  clearIndex(ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY, abandonedRun.sessionKey?.trim());
  clearIndex(
    ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE,
    normalizeSessionFileRegistryKey(abandonedRun.sessionFile),
  );
}

function clearEmbeddedRunAbandonment(params: {
  sessionId?: string;
  sessionKey?: string;
  sessionFile?: string;
}): void {
  const normalizedSessionId = params.sessionId?.trim();
  if (normalizedSessionId) {
    clearEmbeddedRunAbandonmentBySessionId(normalizedSessionId);
  }
  for (const [key, index] of [
    [params.sessionKey?.trim(), ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY],
    [
      normalizeSessionFileRegistryKey(params.sessionFile),
      ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE,
    ],
  ] as const) {
    const sessionId = key ? index.get(key) : undefined;
    if (sessionId) {
      clearEmbeddedRunAbandonmentBySessionId(sessionId);
    }
  }
}

export function markActiveEmbeddedRunAbandoned(params: {
  sessionId: string;
  handle: EmbeddedAgentQueueHandle;
  sessionKey?: string;
  sessionFile?: string;
  reason: AbandonedEmbeddedRun["reason"];
}): boolean {
  const sessionId = params.sessionId.trim();
  if (!sessionId || ACTIVE_EMBEDDED_RUNS.get(sessionId) !== params.handle) {
    return false;
  }
  const abandonedParams = { ...params, runId: params.handle.runId };
  clearEmbeddedRunAbandonment({ ...abandonedParams, sessionId });
  const normalizedSessionFile = normalizeSessionFileRegistryKey(abandonedParams.sessionFile);
  const abandonedRun: AbandonedEmbeddedRun = {
    sessionId,
    ...(abandonedParams.runId?.trim() ? { runId: abandonedParams.runId.trim() } : {}),
    abandonedAtMs: Date.now(),
    reason: abandonedParams.reason,
    ...(abandonedParams.sessionKey?.trim()
      ? { sessionKey: abandonedParams.sessionKey.trim() }
      : {}),
    ...(normalizedSessionFile ? { sessionFile: normalizedSessionFile } : {}),
  };
  ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.set(sessionId, abandonedRun);
  if (abandonedRun.sessionKey) {
    ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY.set(abandonedRun.sessionKey, sessionId);
  }
  if (abandonedRun.sessionFile) {
    ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE.set(abandonedRun.sessionFile, sessionId);
  }
  return true;
}

export function resolveEmbeddedRunAbandonment(params: {
  sessionId?: string;
  sessionKey?: string;
  sessionFile?: string;
}): AbandonedEmbeddedRun["reason"] | undefined {
  const normalizedSessionId = params.sessionId?.trim();
  const normalizedSessionKey = params.sessionKey?.trim();
  const normalizedSessionFile = normalizeSessionFileRegistryKey(params.sessionFile);
  const sessionIds = [
    normalizedSessionId,
    normalizedSessionKey
      ? ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY.get(normalizedSessionKey)
      : undefined,
    normalizedSessionFile
      ? ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE.get(normalizedSessionFile)
      : undefined,
  ];
  const reasons = new Set(
    sessionIds.map((sessionId) =>
      sessionId ? ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.get(sessionId)?.reason : undefined,
    ),
  );
  return reasons.has("timeout")
    ? "timeout"
    : reasons.has("recovering_timeout")
      ? "recovering_timeout"
      : undefined;
}

/**
 * Temporarily releases terminal-timeout delivery suppression while a timed-out
 * attempt is performing an eligible compaction-and-retry recovery.
 */
export function markEmbeddedRunRecoveringTimeout(params: {
  sessionId: string;
  runId?: string;
}): EmbeddedRunTimeoutRecoveryMarker | undefined {
  const abandoned = ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.get(params.sessionId.trim());
  if (
    !abandoned ||
    abandoned.reason !== "timeout" ||
    (abandoned.runId && abandoned.runId !== params.runId?.trim())
  ) {
    return undefined;
  }
  const recoveryToken = Symbol("openclaw.embeddedRunTimeoutRecovery");
  abandoned.reason = "recovering_timeout";
  abandoned.recoveryToken = recoveryToken;
  return { sessionId: abandoned.sessionId, recoveryToken };
}

/** Restores terminal-timeout suppression when recovery cannot continue. */
export function restoreEmbeddedRunTimeoutAbandonment(
  marker: EmbeddedRunTimeoutRecoveryMarker,
): boolean {
  const abandoned = ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.get(marker.sessionId.trim());
  if (
    !abandoned ||
    abandoned.reason !== "recovering_timeout" ||
    abandoned.recoveryToken !== marker.recoveryToken
  ) {
    return false;
  }
  abandoned.reason = "timeout";
  delete abandoned.recoveryToken;
  return true;
}

/**
 * @deprecated Prefer queueEmbeddedAgentMessageWithOutcomeAsync when callers need to
 * know whether steering was accepted. This sync helper is fire-and-forget after
 * initial eligibility and only logs later runtime rejection.
 */
export function queueEmbeddedAgentMessageWithOutcome(
  sessionId: string,
  text: string,
  options?: ReplyMessageInjectionOptions,
): EmbeddedAgentQueueMessageOutcome {
  const prepared = prepareEmbeddedAgentQueueMessage(sessionId, options);
  if (prepared.kind === "complete") {
    return prepared.outcome;
  }
  logActiveRunMessageAccepted(sessionId);
  void prepared.queueMessage(text, prepared.options).catch((err: unknown) => {
    const message = `queue message rejected after enqueue: sessionId=${sessionId} err=${formatErrorMessage(err)}`;
    diag[err instanceof QuestionAnswerUnconfirmedError ? "warn" : "debug"](message);
  });
  return {
    queued: true,
    sessionId,
    target: "embedded_run",
    gatewayHealth: "live",
    enqueuedAtMs: Date.now(),
  };
}

function logActiveRunMessageAccepted(sessionId: string): void {
  // Active-run steering is consumed by the current turn, not queued as another
  // turn for the single idle transition to drain. Keep the event and activity.
  logMessageQueuedWithBacklogPolicy(
    {
      sessionId,
      source: "embedded-agent-runner",
    },
    false,
  );
}

export function isEmbeddedAgentRunAbortableForRunId(runId: string): boolean {
  const normalizedRunId = runId.trim();
  const handle = normalizedRunId ? ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(normalizedRunId) : undefined;
  return handle ? isEmbeddedRunHandleAbortable(normalizedRunId, handle) : true;
}

/** Cancels one exact process-local run after recording its superseded terminal owner. */
export function supersedeEmbeddedAgentRunByRunId(runId: string, beforeCancel: () => void): boolean {
  const normalizedRunId = runId.trim();
  if (!normalizedRunId) {
    return false;
  }
  const handle = ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(normalizedRunId);
  if (handle) {
    if (!isEmbeddedRunHandleSupersedable(normalizedRunId, handle)) {
      return false;
    }
    beforeCancel();
    if (handle.cancel) {
      handle.cancel("superseded");
    } else {
      handle.abort();
    }
    const registration = ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle);
    if (registration) {
      notifyEmbeddedRunEnded(registration.sessionId, handle, true);
    }
    return true;
  }
  return supersedeReplyRunByRunId(normalizedRunId, beforeCancel);
}

export function clearEmbeddedAgentRunAbortabilityForRunId(runId: string): void {
  const normalizedRunId = runId.trim();
  if (normalizedRunId) {
    ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.delete(normalizedRunId);
    RETAINED_EMBEDDED_RUN_ABORTABILITY_RUN_IDS.delete(normalizedRunId);
  }
}

export function retainEmbeddedAgentRunAbortabilityForRunId(runId: string): void {
  const normalizedRunId = runId.trim();
  if (normalizedRunId) {
    RETAINED_EMBEDDED_RUN_ABORTABILITY_RUN_IDS.add(normalizedRunId);
  }
}

function clearEmbeddedRunAbortability(
  handle: EmbeddedAgentQueueHandle,
  opts?: { retainFinalizing?: boolean },
): void {
  ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle)?.humanInputWaits?.clear();
  if (!handle.runId || ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(handle.runId) !== handle) {
    return;
  }
  if (
    opts?.retainFinalizing &&
    RETAINED_EMBEDDED_RUN_ABORTABILITY_RUN_IDS.has(handle.runId) &&
    !isEmbeddedRunHandleAbortable(handle.runId, handle)
  ) {
    return;
  }
  ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.delete(handle.runId);
}

export async function queueEmbeddedAgentMessageWithOutcomeAsync(
  sessionId: string,
  text: string,
  options?: ReplyMessageInjectionOptions,
): Promise<EmbeddedAgentQueueMessageOutcome> {
  return queueEmbeddedAgentMessageAsync(sessionId, text, options);
}

/** TUI preflight requires V2 ownership; failure leaves ordinary input to local queue policy. */
export async function claimPendingEmbeddedAgentQuestionAnswer(
  sessionId: string,
  text: string,
): Promise<{ runId: string } | null> {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle?.runId?.trim() || handle.messageInjectionV2?.version !== 2) {
    return null;
  }
  const runId = handle.runId;
  const registration = ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle);
  const injection = resolveEmbeddedInjection(sessionId, handle);
  if (!injection?.claimPendingUserInputAnswer) {
    return null;
  }
  try {
    registration?.toolAuthority?.assertActive();
  } catch {
    return null;
  }
  if (
    ACTIVE_EMBEDDED_RUNS.get(sessionId) !== handle ||
    ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) !== registration
  ) {
    return null;
  }
  // V2 carries the captured owner assertion through persistence and final dispatch.
  // An unconfirmed answer must propagate; queue fallback could replay accepted input.
  const claimed = await injection.claimPendingUserInputAnswer(text, { isInboundUserMessage: true });
  if (!claimed) {
    return null;
  }
  logActiveRunMessageAccepted(sessionId);
  return { runId };
}

/** Source-bound callers require an explicitly guarded backend, never a V1 fallback. */
export async function queueGuardedEmbeddedAgentMessageWithOutcomeAsync(
  sessionId: string,
  text: string,
  options: ReplyMessageInjectionOptions | undefined,
  canInject: () => boolean,
  sourcePreparation?: EmbeddedInjectionPreparation,
): Promise<EmbeddedAgentQueueMessageOutcome> {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  const onQueueSettled = options?.onQueueSettled;
  if (!handle || !onQueueSettled) {
    return queueEmbeddedAgentMessageAsync(sessionId, text, options, canInject, sourcePreparation);
  }
  // Bind custody before dispatch: a backend can accept synchronously, then end
  // without reporting per-input settlement. Never follow a same-session successor.
  const waiters = EMBEDDED_RUN_WAITERS.get(sessionId) ?? new Set<EmbeddedRunWaiter>();
  const operation = resolveActiveReplyOperationForSessionId(sessionId);
  const abortSignal =
    operation && getAttachedBackend(operation) === handle ? operation.abortSignal : undefined;
  let settled = false;
  const close = (notify: boolean) => {
    if (settled) {
      return;
    }
    settled = true;
    waiters.delete(waiter);
    if (waiters.size === 0 && EMBEDDED_RUN_WAITERS.get(sessionId) === waiters) {
      EMBEDDED_RUN_WAITERS.delete(sessionId);
    }
    abortSignal?.removeEventListener("abort", settle);
    if (notify) {
      onQueueSettled();
    }
  };
  const settle = () => close(true);
  const waiter: EmbeddedRunWaiter = { handle, resolve: settle, settleOnAbort: true };
  waiters.add(waiter);
  EMBEDDED_RUN_WAITERS.set(sessionId, waiters);
  abortSignal?.addEventListener("abort", settle, { once: true });
  if (abortSignal?.aborted || handle.isAborted?.()) {
    settle();
  }
  try {
    const outcome = await queueEmbeddedAgentMessageAsync(
      sessionId,
      text,
      { ...options, onQueueSettled: settle },
      canInject,
      sourcePreparation,
    );
    if (!outcome.queued) {
      // Admission can retry without transcript waiting; rejection never owns custody.
      close(false);
    }
    return outcome;
  } catch (error) {
    close(false);
    throw error;
  }
}

const queueEmbeddedAgentMessageAsync = createEmbeddedMessageInjectionQueue(async (...args) => {
  const [sessionId, input, options, canInject, sourcePreparation, release, assertCurrent] = args;
  let text = input;
  let prepared: PreparedEmbeddedAgentQueueMessage;
  try {
    assertCurrent();
    text = (await sourcePreparation?.prepareMessage?.()) ?? text;
    assertCurrent();
    const authority =
      options?.toolAuthorityOverlay || sourcePreparation
        ? await prepareEmbeddedInjectionAuthority(sessionId, options, canInject, sourcePreparation)
        : undefined;
    assertCurrent();
    prepared = prepareEmbeddedAgentQueueMessage(
      sessionId,
      options,
      canInject,
      authority,
      sourcePreparation,
    );
  } catch (error) {
    if (error instanceof MessageInjectionAuthorityError) {
      return createQueueFailureOutcome(sessionId, "tool_authority_mismatch");
    }
    return createQueueFailureOutcome(sessionId, "runtime_rejected", formatErrorMessage(error));
  }
  const enqueuedAtMs = Date.now();
  const queuedOutcome = {
    queued: true,
    sessionId,
    target: "embedded_run",
    gatewayHealth: "live",
  } satisfies EmbeddedAgentQueueMessageOutcome;
  let queueAccepted = false;
  const unconfirmed = (errorMessage: string): EmbeddedAgentQueueMessageOutcome => {
    diag.warn(
      `queue message accepted without confirmation: sessionId=${sessionId} err=${errorMessage}`,
    );
    logActiveRunMessageAccepted(sessionId);
    return {
      ...queuedOutcome,
      ...(prepared.kind === "embedded_run" && prepared.runId ? { runId: prepared.runId } : {}),
      transcriptCommit: "unconfirmed",
      errorMessage,
      enqueuedAtMs,
    };
  };
  const failed = (error: unknown): EmbeddedAgentQueueMessageOutcome => {
    const candidates = collectErrorGraphCandidates(error, readErrorCauses);
    const accepted = candidates.findLast(
      (candidate) => candidate instanceof MessageInjectionAcceptedUnconfirmedError,
    );
    const questionUnconfirmed = candidates.findLast(
      (candidate) => candidate instanceof QuestionAnswerUnconfirmedError,
    );
    const withdrawn = candidates.some(
      (candidate) => candidate instanceof MessageInjectionWithdrawnError,
    );
    if (accepted || (queueAccepted && (!withdrawn || questionUnconfirmed))) {
      return unconfirmed(accepted?.message ?? formatErrorMessage(error));
    }
    if (questionUnconfirmed) {
      throw questionUnconfirmed;
    }
    const errorMessage = formatErrorMessage(error);
    diag.debug(`queue message rejected: sessionId=${sessionId} err=${errorMessage}`);
    return createQueueFailureOutcome(sessionId, "runtime_rejected", errorMessage);
  };
  if (prepared.kind === "complete") {
    const { outcome, pendingInput } = prepared;
    if (!outcome.queued && options?.isInboundUserMessage === true && pendingInput) {
      const authorityMismatch =
        outcome.reason === "tool_authority_mismatch" ||
        outcome.reason === "input_visibility_mismatch";
      if (hasPromptImageInput(options)) {
        if (authorityMismatch || outcome.reason === "image_input_unsupported") {
          try {
            const cancellation = pendingInput.cancelPendingUserInput?.("image-reply");
            release();
            await cancellation;
          } catch (err) {
            diag.warn(
              `failed to cancel pending user input before queued image fallback: sessionId=${sessionId} err=${formatErrorMessage(err)}`,
            );
          }
        }
      } else if (authorityMismatch && pendingInput.claimPendingUserInputAnswer) {
        const claimPendingUserInputAnswer = pendingInput.claimPendingUserInputAnswer;
        try {
          const claim = claimPendingUserInputAnswer(text, options);
          release();
          if (await claim) {
            queueAccepted = true;
            options.onQueueAccepted?.(true);
            options.onQueueSettled?.();
            logActiveRunMessageAccepted(sessionId);
            return {
              ...queuedOutcome,
              enqueuedAtMs: Date.now(),
            };
          }
        } catch (err) {
          return failed(err);
        }
      }
    }
    return outcome;
  }
  try {
    if (prepared.prepareQueueMessage) {
      await prepared.prepareQueueMessage();
    }
    const delivery = prepared.queueMessage(text, {
      ...prepared.options,
      onQueueAccepted: (accepted) => {
        // Once the backend owns input, observer failures cannot release it for replay.
        queueAccepted ||= accepted;
        prepared.options.onQueueAccepted?.(accepted);
      },
    });
    release();
    const queueResult = await delivery;
    queueAccepted = true;
    if (queueResult?.transcriptCommit === "unconfirmed") {
      return unconfirmed(queueResult.errorMessage);
    }
    const deliveredAtMs = options?.waitForTranscriptCommit ? Date.now() : undefined;
    logActiveRunMessageAccepted(sessionId);
    return {
      ...queuedOutcome,
      ...(prepared.runId ? { runId: prepared.runId } : {}),
      ...(deliveredAtMs !== undefined ? { deliveredAtMs } : {}),
      enqueuedAtMs,
    };
  } catch (err) {
    return failed(err);
  }
});

function prepareEmbeddedAgentQueueMessage(
  sessionId: string,
  options?: ReplyMessageInjectionOptions,
  sourceCanInject?: () => boolean,
  prepared?: { fingerprint?: string; preparation: EmbeddedInjectionPreparation },
  sourcePreparation?: EmbeddedInjectionPreparation,
): PreparedEmbeddedAgentQueueMessage {
  const preparation = prepared?.preparation ?? sourcePreparation;
  preparation?.assertCurrent();
  const reject = (
    reason: EmbeddedAgentQueueFailureReason,
    logFailure = false,
  ): PreparedEmbeddedAgentQueueMessage => {
    if (logFailure) {
      diag.debug(`queue message failed: sessionId=${sessionId} reason=${reason}`);
    }
    return { kind: "complete", outcome: createQueueFailureOutcome(sessionId, reason) };
  };
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle) {
    // A stale reply-backed run must produce the same closed reason as the
    // embedded gate so announce delivery falls through to direct instead of
    // reading the wedged op as active and dropping the handoff.
    if (isReplyRunEvidenceStaleBySessionId(sessionId)) {
      return reject("stale_run", true);
    }
    if (options?.waitForTranscriptCommit === true) {
      return reject("transcript_commit_wait_unsupported", true);
    }
    return reject("no_active_run");
  }
  const registration = ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle);
  if (sourceCanInject && handle.messageInjectionV2?.version !== 2) {
    return reject("guarded_injection_unsupported");
  }
  const injection = resolveEmbeddedInjection(
    sessionId,
    handle,
    sourceCanInject,
    preparation,
    options,
  );
  if (!injection) {
    return reject("not_streaming", true);
  }
  const recoveryBlocker = resolveActiveEmbeddedRunRecoveryBlocker(sessionId, handle);
  if (ACTIVE_EMBEDDED_RUNS.get(sessionId) !== handle) {
    return reject("no_active_run");
  }
  const activity = getDiagnosticSessionActivitySnapshot({ sessionId });
  if (
    typeof activity.lastProgressAgeMs === "number" &&
    activity.lastProgressAgeMs > resolveRunStaleThresholdMs(activity) &&
    !recoveryBlocker
  ) {
    return reject("stale_run", true);
  }
  if (!canSteerEmbeddedRunDuringCompaction(sessionId, handle)) {
    return reject("compacting", true);
  }
  if (options?.waitForTranscriptCommit === true && handle.supportsTranscriptCommitWait !== true) {
    return reject("transcript_commit_wait_unsupported", true);
  }
  const operation = resolveActiveReplyOperationForSessionId(sessionId);
  const ownedOperation =
    operation && getAttachedBackend(operation) === handle ? operation : undefined;
  const { toolAuthorityOverlay, ...backendOptions } = options ?? { steeringMode: "all" as const };
  if (toolAuthorityOverlay) {
    // An overlay is caller evidence; a supplied raw hash cannot override it.
    try {
      backendOptions.toolAuthorityFingerprint = prepared
        ? prepared.fingerprint
        : registration?.toolAuthority
          ? registration.toolAuthority.project(toolAuthorityOverlay)
          : ownedOperation?.projectToolAuthorityFingerprint(toolAuthorityOverlay);
    } catch {
      backendOptions.toolAuthorityFingerprint = undefined;
    }
    if (!backendOptions.toolAuthorityFingerprint) {
      return reject("tool_authority_mismatch");
    }
  }
  const deliveryModeMismatch = resolveReplyBackendQueueMessageMismatch(
    handle,
    backendOptions,
    ownedOperation,
  );
  if (deliveryModeMismatch) {
    const activeFingerprint = normalizeOptionalString(handle.toolAuthorityFingerprint);
    // Projected caller authority takes precedence over raw route-mismatch proof.
    const pendingInputAuthorityProven =
      (!toolAuthorityOverlay || deliveryModeMismatch === "input_visibility_mismatch") &&
      (deliveryModeMismatch !== "input_visibility_mismatch" ||
        handle.messageInjectionV2?.version === 2) &&
      activeFingerprint &&
      (normalizeOptionalString(backendOptions.toolAuthorityFingerprint) === activeFingerprint ||
        (!toolAuthorityOverlay &&
          normalizeOptionalString(options?.pendingInputAuthorityFingerprint) ===
            activeFingerprint));
    diag.debug(`queue message failed: sessionId=${sessionId} reason=${deliveryModeMismatch}`);
    return {
      kind: "complete",
      outcome: createQueueFailureOutcome(sessionId, deliveryModeMismatch),
      ...(pendingInputAuthorityProven ? { pendingInput: injection } : {}),
    };
  }
  try {
    registration?.toolAuthority?.assertActive();
  } catch {
    return reject("tool_authority_mismatch");
  }
  if (
    ACTIVE_EMBEDDED_RUNS.get(sessionId) !== handle ||
    ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) !== registration ||
    (ownedOperation &&
      (resolveActiveReplyOperationForSessionId(sessionId) !== ownedOperation ||
        getAttachedBackend(ownedOperation) !== handle))
  ) {
    return reject("no_active_run");
  }
  return {
    kind: "embedded_run",
    runId: handle.runId,
    queueMessage: injection.queueMessage,
    prepareQueueMessage: injection.prepareQueueMessage,
    options: backendOptions,
  };
}

function revokeCompletionClaim(sessionId: string, runId?: string): void {
  const claim = EMBEDDED_RUN_COMPLETION_CLAIMS.get(sessionId);
  if (claim && (runId === undefined || claim.runId === runId)) {
    claim.settleRegistration(undefined);
    EMBEDDED_RUN_COMPLETION_CLAIMS.delete(sessionId);
  }
}

/**
 * Abort embedded OpenClaw runs.
 *
 * - With a sessionId, aborts that single run.
 * - With no sessionId, supports targeted abort modes (for example, compacting runs only).
 */
export function abortEmbeddedAgentRun(sessionId: string): boolean;
export function abortEmbeddedAgentRun(
  sessionId: undefined,
  opts: { mode: "all" | "compacting"; reason?: "restart" },
): boolean;
export function abortEmbeddedAgentRun(
  sessionId?: string,
  opts?: { mode?: "all" | "compacting"; reason?: "restart" },
): boolean {
  if (typeof sessionId === "string" && sessionId.length > 0) {
    const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
    if (!handle) {
      if (abortReplyRunBySessionId(sessionId)) {
        return true;
      }
      diag.debug(`abort failed: sessionId=${sessionId} reason=no_active_run`);
      return false;
    }
    if (!isEmbeddedRunHandleAbortable(sessionId, handle)) {
      diag.debug(`abort failed: sessionId=${sessionId} reason=not_abortable`);
      return false;
    }
    diag.debug(`aborting run: sessionId=${sessionId}`);
    try {
      handle.abort(opts?.reason);
    } catch (err) {
      diag.warn(`abort failed: sessionId=${sessionId} err=${String(err)}`);
      return false;
    }
    revokeCompletionClaim(sessionId, handle.runId);
    notifyEmbeddedRunEnded(sessionId, handle, true);
    return true;
  }

  const mode = opts?.mode;
  if (mode !== "all" && mode !== "compacting") {
    return false;
  }
  const replyOwnedSessionIds = new Set(listActiveReplyRunSessionIds());
  const replyAborted = abortActiveReplyRuns({
    mode,
    onAbortError: (id, err) =>
      diag.warn(`abort failed: sessionId=${id} owner=reply_run err=${String(err)}`),
  });
  let aborted = false;
  for (const [id, handle] of ACTIVE_EMBEDDED_RUNS) {
    if (replyOwnedSessionIds.has(id) || !isEmbeddedRunHandleAbortable(id, handle, mode)) {
      continue;
    }
    diag.debug(`aborting ${mode === "compacting" ? "compacting " : ""}run: sessionId=${id}`);
    try {
      handle.abort(opts?.reason);
      revokeCompletionClaim(id, handle.runId);
      notifyEmbeddedRunEnded(id, handle, true);
      aborted = true;
    } catch (err) {
      diag.warn(`abort failed: sessionId=${id} err=${String(err)}`);
    }
  }
  return replyAborted || aborted;
}

type EmbeddedHeartbeatPreemptionResult = "not-heartbeat" | "drained" | "timed-out";

export async function preemptAndDrainEmbeddedHeartbeatRun(
  sessionId: string,
  timeoutMs: number,
): Promise<EmbeddedHeartbeatPreemptionResult> {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle?.preemptByVisibleTurn) {
    return "not-heartbeat";
  }
  const drainPromise = waitForCurrentEmbeddedAgentRunEnd(sessionId, timeoutMs, handle);
  try {
    handle.preemptByVisibleTurn();
  } catch (err) {
    diag.warn(`heartbeat preemption failed: sessionId=${sessionId} err=${String(err)}`);
  } finally {
    notifyGatewayWorkMetricsChanged();
  }
  return (await drainPromise) ? "drained" : "timed-out";
}

function logActiveRunCheck(sessionId: string, active: boolean, label: string): boolean {
  if (active) {
    diag.debug(`${label}: sessionId=${sessionId} active=true`);
  }
  return active;
}

export function prepareEmbeddedAgentRunCompletionClaim(sessionId: string, runId: string) {
  const { promise: registered, resolve: settleRegistration } = createDeferredCore<
    EmbeddedRunCompletionRegistration | undefined
  >();
  const claim: EmbeddedRunCompletionClaim = {
    runId,
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
    promoted: false,
    settleRegistration,
  };
  revokeCompletionClaim(sessionId);
  EMBEDDED_RUN_COMPLETION_CLAIMS.set(sessionId, claim);
  const consume = (allowUnregistered: boolean): boolean => {
    if (EMBEDDED_RUN_COMPLETION_CLAIMS.get(sessionId) !== claim) {
      return false;
    }
    EMBEDDED_RUN_COMPLETION_CLAIMS.delete(sessionId);
    if (!claim.promoted) {
      claim.settleRegistration(undefined);
    }
    return (
      (allowUnregistered || claim.promoted) &&
      isAgentEventLifecycleGenerationCurrent(claim.lifecycleGeneration)
    );
  };
  const bindOperationalRunInstance = (
    instance: NonNullable<EmbeddedRunRegistration["operationalRunInstance"]>,
  ): boolean => {
    if (
      EMBEDDED_RUN_COMPLETION_CLAIMS.get(sessionId) !== claim ||
      !isAgentEventLifecycleGenerationCurrent(claim.lifecycleGeneration) ||
      instance.runId !== runId ||
      (claim.operationalRunInstance !== undefined && claim.operationalRunInstance !== instance)
    ) {
      return false;
    }
    claim.operationalRunInstance = instance;
    return true;
  };
  const resolveCurrentRegistration = (): EmbeddedRunCompletionRegistration | undefined => {
    if (
      EMBEDDED_RUN_COMPLETION_CLAIMS.get(sessionId) !== claim ||
      !isAgentEventLifecycleGenerationCurrent(claim.lifecycleGeneration)
    ) {
      return undefined;
    }
    const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
    const registration = handle ? ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) : undefined;
    const toolAuthority = registration?.toolAuthority;
    if (
      !handle ||
      handle.runId !== runId ||
      !toolAuthority ||
      !claim.operationalRunInstance ||
      registration.operationalRunInstance !== claim.operationalRunInstance
    ) {
      return undefined;
    }
    try {
      toolAuthority.assertActive();
    } catch {
      return undefined;
    }
    return EMBEDDED_RUN_COMPLETION_CLAIMS.get(sessionId) === claim &&
      ACTIVE_EMBEDDED_RUNS.get(sessionId) === handle &&
      ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) === registration &&
      isAgentEventLifecycleGenerationCurrent(claim.lifecycleGeneration)
      ? { toolAuthority }
      : undefined;
  };
  return {
    bindOperationalRunInstance,
    claimCompletion: () => consume(false),
    claimFailure: () => consume(true),
    resolveCurrentRegistration,
    registered,
  };
}

/** Operational progress includes maintenance, including permission changes and cancellation. */
export function resolveEmbeddedAgentRunProgressState(
  sessionId: string,
): "queued" | "running" | undefined {
  return resolveEmbeddedRunProgressState(sessionId, "operational");
}

type SessionProgressOwner = { agentId?: string; defaultAgentId?: string };

function matchesSessionProgressOwner(
  owner: SessionProgressOwner,
  recorded: { agentId?: string; sessionKey?: string },
): boolean {
  const requestedAgentId = owner.agentId ?? owner.defaultAgentId;
  const recordedAgentId =
    recorded.agentId ?? parseAgentSessionKey(recorded.sessionKey)?.agentId ?? owner.defaultAgentId;
  return Boolean(
    requestedAgentId &&
    recordedAgentId &&
    normalizeAgentId(requestedAgentId) === normalizeAgentId(recordedAgentId),
  );
}

/** Session presentation uses the retained run owner, even after its context is released. */
export function resolveEmbeddedAgentSessionProgressState(
  sessionId: string,
  owner: SessionProgressOwner,
): "queued" | "running" | undefined {
  return resolveEmbeddedRunProgressState(sessionId, owner);
}

function resolveEmbeddedRunProgressState(
  sessionId: string,
  scope: "operational" | SessionProgressOwner,
): "queued" | "running" | undefined {
  const replyOperation = resolveActiveReplyOperationForSessionId(sessionId);
  const replyPhase = replyOperation?.phase;
  const replyInProgress =
    replyPhase !== undefined &&
    replyPhase !== "completed" &&
    replyPhase !== "failed" &&
    replyPhase !== "aborted" &&
    (scope === "operational" ||
      (replyOperation &&
        matchesSessionProgressOwner(scope, {
          agentId: replyOperation.agentId,
          sessionKey: replyOperation.key,
        })));
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  const registration = handle && ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle);
  const handleInProgress =
    isEmbeddedRunHandleInProgress(handle) &&
    (scope === "operational" ||
      (registration &&
        registration.projectSessionActive !== false &&
        matchesSessionProgressOwner(scope, registration)));
  // Reply operations and embedded handles are independent lifecycle owners.
  // A retained terminal owner must not hide a newer live owner for the session.
  if (
    handleInProgress ||
    (replyInProgress &&
      replyOperation &&
      replyPhase !== "waiting_for_global_lane" &&
      hasReplyOperationExecutionStarted(replyOperation))
  ) {
    return "running";
  }
  return replyInProgress ? "queued" : undefined;
}

export type EmbeddedReplyActivity = Pick<ReplyOperation, "phase" | "lastActivityAtMs"> & {
  /** Terminal outcome committed; only delivery/finalization remains. */
  terminalOutcomeCommitted: boolean;
};

export function resolveEmbeddedReplyActivity(sessionId: string): EmbeddedReplyActivity | undefined {
  const operation = resolveActiveReplyOperationForSessionId(sessionId);
  return operation
    ? {
        phase: operation.phase,
        lastActivityAtMs: operation.lastActivityAtMs,
        terminalOutcomeCommitted: hasCommittedReplyOperationOutcome(operation),
      }
    : undefined;
}

/**
 * True when work other than `runId` now holds the session. `runId` must name a
 * run admitted outside reply dispatch (cron), so an active reply run is other work.
 */
export function isEmbeddedAgentSessionHeldByOtherRun(sessionId: string, runId: string): boolean {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  return handle ? handle.runId !== runId : isReplyRunActiveForSessionId(sessionId);
}

export function isEmbeddedAgentRunHandleActive(sessionId: string): boolean {
  const active = ACTIVE_EMBEDDED_RUNS.has(sessionId);
  return logActiveRunCheck(sessionId, active, "run handle active check");
}

export function isEmbeddedAgentRunAbortableForCompaction(sessionId: string): boolean {
  const active = ACTIVE_EMBEDDED_RUNS.has(sessionId) || isReplyRunAbortableForCompaction(sessionId);
  return logActiveRunCheck(sessionId, active, "run compact coordination check");
}

export function isEmbeddedAgentRunStreaming(sessionId: string): boolean {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  return handle?.isStreaming() ?? false;
}

export function resolveActiveEmbeddedRunHandleSessionId(sessionKey: string): string | undefined {
  const normalizedSessionKey = sessionKey.trim();
  return normalizedSessionKey
    ? ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.get(normalizedSessionKey)
    : undefined;
}

function isEmbeddedRunHandleInProgress(
  handle: EmbeddedAgentQueueHandle | undefined,
): handle is EmbeddedAgentQueueHandle {
  try {
    return handle ? !handle.isAborted?.() : false;
  } catch {
    // A failed optional status probe cannot prove that live work has ended.
    return true;
  }
}

export type ActiveEmbeddedRunOwner = {
  runId: string;
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  startedAtMs?: number;
  abort: () => boolean;
};

function projectActiveEmbeddedRunOwner(
  registration: { sessionId: string; sessionKey?: string; agentId?: string },
  handle: EmbeddedAgentQueueHandle,
): ActiveEmbeddedRunOwner | undefined {
  const runId = handle.runId;
  if (!runId || !isEmbeddedRunHandleInProgress(handle)) {
    return undefined;
  }
  return {
    runId,
    sessionId: registration.sessionId,
    ...(registration.sessionKey ? { sessionKey: registration.sessionKey } : {}),
    ...(registration.agentId ? { agentId: registration.agentId } : {}),
    ...(handle.startedAtMs === undefined ? {} : { startedAtMs: handle.startedAtMs }),
    // A recovered run ID is correlation only. Recheck the captured owner before
    // Stop so a stale UI action cannot abort replacement work in the session.
    abort: () => {
      if (
        ACTIVE_EMBEDDED_RUNS.get(registration.sessionId) !== handle ||
        ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(runId) !== handle ||
        !isEmbeddedRunHandleAbortable(runId, handle)
      ) {
        return false;
      }
      try {
        if (handle.cancel) {
          handle.cancel("user_abort");
        } else {
          handle.abort();
        }
        revokeCompletionClaim(registration.sessionId, runId);
        notifyEmbeddedRunEnded(registration.sessionId, handle, true);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function resolveActiveEmbeddedRunOwner(
  sessionId: string,
): ActiveEmbeddedRunOwner | undefined {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  const registration = handle ? ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) : undefined;
  return handle && registration ? projectActiveEmbeddedRunOwner(registration, handle) : undefined;
}

/** Lifecycle drains retain the exact handle, including compaction without a run ID. */
export function captureEmbeddedRunDrainTarget(sessionId: string, owner: SessionProgressOwner) {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  const registration = handle && ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle);
  if (!handle || !registration || !matchesSessionProgressOwner(owner, registration)) {
    return undefined;
  }
  const waiting = new AbortController();
  const ended = waitForCurrentEmbeddedAgentRunEnd(sessionId, null, handle, waiting.signal);
  const isActive = () =>
    !waiting.signal.aborted &&
    ACTIVE_EMBEDDED_RUNS.get(sessionId) === handle &&
    ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) === registration;
  return {
    sessionId,
    agentId: registration.agentId,
    sessionKey: registration.sessionKey,
    isActive,
    abort: () => isActive() && abortEmbeddedAgentRun(sessionId),
    waitForEnd: async (timeoutMs: number | null) =>
      (timeoutMs === null ||
        (await settlesWithin(ended, resolveTimerTimeoutMs(timeoutMs, 100, 100)))) &&
      (await ended),
    release: () => waiting.abort(),
  };
}

export type EmbeddedRunDrainTarget = NonNullable<ReturnType<typeof captureEmbeddedRunDrainTarget>>;

function resolveRegisteredEmbeddedRunByRunId(runId: string) {
  const normalizedRunId = runId.trim();
  const handle = normalizedRunId ? ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(normalizedRunId) : undefined;
  const registration = handle ? ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) : undefined;
  return handle && registration && ACTIVE_EMBEDDED_RUNS.get(registration.sessionId) === handle
    ? { handle, registration }
    : undefined;
}

export function resolveActiveEmbeddedRunOwnerByRunId(
  runId: string,
): ActiveEmbeddedRunOwner | undefined {
  const active = resolveRegisteredEmbeddedRunByRunId(runId);
  return active ? projectActiveEmbeddedRunOwner(active.registration, active.handle) : undefined;
}

export function isActiveEmbeddedRunId(runId: string): boolean {
  const active = resolveRegisteredEmbeddedRunByRunId(runId);
  return Boolean(active && isEmbeddedRunHandleInProgress(active.handle));
}

export function resolveActiveEmbeddedRunHandleSessionIdBySessionFile(
  sessionFile: string,
): string | undefined {
  const normalizedSessionFile = normalizeSessionFileRegistryKey(sessionFile);
  return normalizedSessionFile
    ? ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE.get(normalizedSessionFile)
    : undefined;
}

export { resolveActiveEmbeddedRunHandleSessionIdBySessionFile as resolveActiveEmbeddedRunSessionIdBySessionFile };

export function getActiveEmbeddedRunSnapshot(
  sessionId: string,
): ActiveEmbeddedRunSnapshot | undefined {
  return ACTIVE_EMBEDDED_RUN_SNAPSHOTS.get(sessionId);
}

export async function abortAndDrainEmbeddedAgentRun(params: {
  sessionId: string;
  sessionKey?: string;
  settleMs?: number;
  forceClear?: boolean;
  reason?: string;
}): Promise<AbortAndDrainEmbeddedAgentRunResult> {
  const isStuckRecovery = params.reason === "stuck_recovery";
  const settleMs = params.settleMs ?? 15_000;
  const settleDeadline = Date.now() + settleMs;
  const embeddedRunHandle = ACTIVE_EMBEDDED_RUNS.get(params.sessionId);
  // Capture the exact handle's session owner before cancellation can replace the run.
  const agentId = embeddedRunHandle
    ? ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(embeddedRunHandle)?.agentId
    : undefined;
  const replyOperation = resolveActiveReplyOperationForSessionId(params.sessionId);
  if (isStuckRecovery && replyOperation && hasCommittedReplyOperationOutcome(replyOperation)) {
    return { aborted: false, drained: false, forceCleared: false };
  }
  if (
    isStuckRecovery &&
    embeddedRunHandle &&
    (!replyOperation || isReplyOperationAbortable(replyOperation)) &&
    isEmbeddedRunHandleAbortable(params.sessionId, embeddedRunHandle) &&
    embeddedRunHandle.recoverStalledModelCall?.() === true
  ) {
    return { aborted: true, drained: false, forceCleared: false, recoveringModelAttempt: true };
  }
  const persistenceSnapshot =
    params.forceClear === true && params.sessionKey
      ? tryLoadForceClearSessionSnapshot(
          params.sessionKey,
          agentId,
          embeddedRunHandle?.runId ??
            (replyOperation ? getAttachedBackend(replyOperation)?.runId : undefined),
        )
      : undefined;
  const staleExpiryBarrier = isStuckRecovery ? createDeferredCore() : undefined;
  // Terminal recovery stamps expiry before cancellation can re-enter user abort.
  const expiredReplyRun =
    isStuckRecovery &&
    expireStaleReplyRunBySessionId(params.sessionId, "stuck_recovery", {
      afterClearBarrier: staleExpiryBarrier?.promise,
      followupAdmissionBarrierTimeout: settleMs + 1_000,
    });
  const stampedStaleReplyRun =
    isStuckRecovery && replyOperation?.staleExpiryReason === "stuck_recovery";
  try {
    if (expiredReplyRun && !ACTIVE_EMBEDDED_RUNS.has(params.sessionId)) {
      // Let lane completion run before terminal recovery decides whether to reset.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
    let aborted = abortEmbeddedAgentRun(params.sessionId) || expiredReplyRun;
    const embeddedDrained =
      aborted || stampedStaleReplyRun
        ? await waitForEmbeddedAgentRunEnd(params.sessionId, settleMs)
        : false;
    const ownerSettled =
      !stampedStaleReplyRun ||
      !replyOperation ||
      (await waitForReplyOperationOwnerSettlement(
        replyOperation,
        Math.max(100, settleDeadline - Date.now()),
      ));
    if (!ownerSettled) {
      diag.warn(
        `stuck recovery: reply owner settlement timed out sessionId=${params.sessionId} settleMs=${settleMs}`,
      );
    }
    const drained = embeddedDrained && ownerSettled;
    // Count the exact settled stale owner as the accepted abort.
    aborted ||= stampedStaleReplyRun && drained;
    const forceCleared =
      params.forceClear === true &&
      ((!expiredReplyRun && stampedStaleReplyRun && !ownerSettled) || !aborted || !drained)
        ? await forceClearEmbeddedAgentRun(
            params.sessionId,
            embeddedRunHandle,
            replyOperation,
            params.sessionKey,
            params.reason,
          )
        : false;
    if (forceCleared && params.sessionKey && persistenceSnapshot) {
      await persistForceClearedEmbeddedRunTerminalState(
        {
          ...persistenceSnapshot,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
        },
        (sessionId, sessionKey) =>
          ACTIVE_EMBEDDED_RUNS.has(sessionId) ||
          ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.has(sessionKey) ||
          isReplyRunActiveForSessionId(sessionId) ||
          resolveActiveReplyRunSessionId(sessionKey) !== undefined,
      );
    }
    return { aborted, drained, forceCleared };
  } finally {
    // Queue drains registered on the stale owner must not start while its
    // backend can still claim the same session and requeue the adopted turn.
    staleExpiryBarrier?.resolve();
  }
}

export function setActiveEmbeddedRun(
  sessionId: string,
  handle: EmbeddedAgentQueueHandle,
  sessionKey?: string,
  sessionFile?: string,
  agentId?: string,
) {
  const sessionIdentity = { sessionId, sessionKey, sessionFile };
  const incomingLifecycleGeneration = setActiveEmbeddedRunLifecycleGeneration(
    handle,
    getAgentEventLifecycleGeneration(),
  );
  // The immutable handle generation rejects delayed stale registration even
  // when rotation left no replacement owner in the session slot.
  if (!isAgentEventLifecycleGenerationCurrent(incomingLifecycleGeneration)) {
    revokeCompletionClaim(sessionId, handle.runId);
    try {
      handle.abort("restart");
    } catch (error) {
      diag.warn(`stale run registration abort failed: sessionId=${sessionId} err=${String(error)}`);
      throw error;
    }
    return;
  }
  if (handle.diagnosticOwner && isDiagnosticEmbeddedRunOwnerClosed(handle.diagnosticOwner)) {
    revokeCompletionClaim(sessionId, handle.runId);
    handle.abort("restart");
    return;
  }
  const caller = getGatewayToolCallerIdentity();
  const revokeClaimOnFailure = <T>(operation: () => T): T => {
    try {
      return operation();
    } catch (error) {
      revokeCompletionClaim(sessionId, handle.runId);
      throw error;
    }
  };
  const toolAuthority = revokeClaimOnFailure(() =>
    caller?.embeddedRunToolAuthorityBinding?.({
      ...sessionIdentity,
      agentId,
      handle,
    }),
  );
  const previousHandle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (previousHandle) {
    previousHandle.closeDiagnostics?.();
    clearEmbeddedRunAbortability(previousHandle, { retainFinalizing: true });
    EMBEDDED_RUN_FORCED_TERMINAL_SETTLEMENTS.delete(previousHandle);
  }
  revokeClaimOnFailure(() => toolAuthority?.assertActive());
  clearEmbeddedRunAbandonment(sessionIdentity);
  ACTIVE_EMBEDDED_RUNS.set(sessionId, handle);
  // The dispatch scope carries the admitted instance across both core and
  // plugin attempts. A handle's public runId alone cannot confer wait authority.
  const operationalRunInstance = caller?.operationalRunInstance;
  const runContext = handle.runId ? getAgentRunContext(handle.runId) : undefined;
  ACTIVE_EMBEDDED_RUN_REGISTRATIONS.set(handle, {
    projectSessionActive:
      runContext?.lifecycleGeneration === incomingLifecycleGeneration
        ? runContext.projectSessionActive
        : undefined,
    toolAuthority,
    operationalRunInstance,
    sessionId,
    // Legacy SDK callers may omit this; a matching live binding proves the captured owner.
    agentId: agentId ?? (toolAuthority ? caller?.agentId : undefined),
    ...(sessionKey ? { sessionKey } : {}),
    delegatedAuthority:
      operationalRunInstance?.runId === handle.runId && operationalRunInstance
        ? getActiveAgentRunDelegatedAuthority(operationalRunInstance)
        : undefined,
    onHumanInputResolved: () => {
      const operation = resolveActiveReplyOperationForSessionId(sessionId);
      if (operation && getAttachedBackend(operation) === handle) {
        operation.recordActivity();
      }
      markDiagnosticRunProgress({ sessionId, sessionKey, reason: "human_input:resolved" });
      // A real resolution resumes work and invalidates recovery queued before it.
      // This does not refresh progress while waiting or extend any run deadline.
      logSessionStateChange({
        ...sessionIdentity,
        state: "processing",
        reason: "human_input_resolved",
      });
    },
  });
  const forcedTerminalSettlement = resolveSessionPlacementForcedTerminalSettlement();
  if (forcedTerminalSettlement) {
    EMBEDDED_RUN_FORCED_TERMINAL_SETTLEMENTS.set(handle, forcedTerminalSettlement);
  }
  if (handle.runId) {
    ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.set(handle.runId, handle);
  }
  setActiveEmbeddedRunSessionIndexes(sessionId, sessionKey, sessionFile);
  notifyGatewayWorkMetricsChanged();
  logSessionStateChange({
    ...sessionIdentity,
    state: "processing",
    reason: previousHandle !== undefined ? "run_replaced" : "run_started",
  });
  markDiagnosticEmbeddedRunStarted({
    sessionId,
    sessionKey,
    runId: handle.runId,
    owner: handle.diagnosticOwner,
  });
  if (!sessionId.startsWith("probe-")) {
    diag.debug(`run registered: sessionId=${sessionId} totalActive=${ACTIVE_EMBEDDED_RUNS.size}`);
  }
  const completionClaim = EMBEDDED_RUN_COMPLETION_CLAIMS.get(sessionId);
  if (
    completionClaim &&
    completionClaim.runId === handle.runId &&
    completionClaim.lifecycleGeneration === incomingLifecycleGeneration &&
    (completionClaim.operationalRunInstance === undefined ||
      completionClaim.operationalRunInstance === operationalRunInstance)
  ) {
    completionClaim.promoted = true;
    completionClaim.settleRegistration(toolAuthority ? { toolAuthority } : undefined);
  } else if (completionClaim) {
    revokeCompletionClaim(sessionId);
  }
}

export function updateActiveEmbeddedRunSnapshot(
  sessionId: string,
  snapshot: ActiveEmbeddedRunSnapshot,
) {
  if (ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
    ACTIVE_EMBEDDED_RUN_SNAPSHOTS.set(sessionId, snapshot);
  }
}

function removeActiveEmbeddedRun(
  context: { sessionId: string; sessionKey?: string; sessionFile?: string },
  handle: EmbeddedAgentQueueHandle,
  reason: string,
  opts?: { retainFinalizing?: boolean },
) {
  const { sessionId, sessionKey } = context;
  handle.closeDiagnostics?.();
  ACTIVE_EMBEDDED_RUNS.delete(sessionId);
  clearEmbeddedRunAbortability(handle, opts);
  ACTIVE_EMBEDDED_RUN_SNAPSHOTS.delete(sessionId);
  clearActiveRunSessionIndex(ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY, sessionId, sessionKey?.trim());
  clearActiveRunSessionIndex(ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE, sessionId);
  notifyGatewayWorkMetricsChanged();
  logSessionStateChange({ ...context, state: "idle", reason });
  if (!handle.diagnosticOwner) {
    markDiagnosticEmbeddedRunEnded({ sessionId, sessionKey });
  }
}

export function clearActiveEmbeddedRun(
  sessionId: string,
  handle: EmbeddedAgentQueueHandle,
  sessionKey?: string,
  sessionFile?: string,
  reason = "run_completed",
) {
  const activeHandle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (activeHandle === handle) {
    removeActiveEmbeddedRun({ sessionId, sessionKey, sessionFile }, handle, reason, {
      retainFinalizing: true,
    });
    if (!sessionId.startsWith("probe-")) {
      diag.debug(`run cleared: sessionId=${sessionId} totalActive=${ACTIVE_EMBEDDED_RUNS.size}`);
    }
  } else if (activeHandle !== undefined) {
    diag.debug(`run clear skipped: sessionId=${sessionId} reason=handle_mismatch`);
  }
  EMBEDDED_RUN_FORCED_TERMINAL_SETTLEMENTS.delete(handle);
  // Exact-handle waiters own teardown even after another run takes the session slot.
  notifyEmbeddedRunEnded(sessionId, handle);
}

async function forceClearEmbeddedAgentRun(
  sessionId: string,
  expectedHandle: EmbeddedAgentQueueHandle | undefined,
  expectedReplyOperation: ReplyOperation | undefined,
  sessionKey?: string,
  reason = "stuck_recovery",
): Promise<boolean> {
  let cleared = false;
  let forcedTerminalSettlement: (() => Promise<void>) | undefined;
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (handle && handle === expectedHandle) {
    forcedTerminalSettlement = EMBEDDED_RUN_FORCED_TERMINAL_SETTLEMENTS.get(handle);
    EMBEDDED_RUN_FORCED_TERMINAL_SETTLEMENTS.delete(handle);
    removeActiveEmbeddedRun({ sessionId, sessionKey }, handle, reason);
    notifyEmbeddedRunEnded(sessionId, handle);
    cleared = true;
  }
  const cause = new Error(`Embedded run force-cleared by ${reason}`);
  try {
    return (
      (expectedReplyOperation ? forceClearReplyOperation(expectedReplyOperation, cause) : false) ||
      cleared
    );
  } finally {
    await forcedTerminalSettlement?.();
  }
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
