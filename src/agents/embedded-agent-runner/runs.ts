/**
 * Manages active embedded-agent run handles, queues, aborts, and waiters.
 */
import {
  abortActiveReplyRuns,
  abortReplyRunBySessionId,
  abortReplyRunBySessionIdWithAuthorization,
  expireStaleReplyRunBySessionId,
  forceClearReplyRunBySessionId,
  isReplyRunEvidenceStaleBySessionId,
  isReplyRunActiveForSessionId,
  isReplyRunAbortableForCompaction,
  isReplyRunStreamingForSessionId,
  listActiveReplyRunSessionIds,
  queueReplyRunMessage,
  resolveReplyBackendQueueMessageMismatch,
  resolveReplyRunPhaseForSessionId,
  type ReplyOperationPhase,
  waitForReplyRunEndBySessionId,
} from "../../auto-reply/reply/reply-run-registry.js";
import {
  createSteeringAuthorizationAffinity,
  steeringAuthorizationAffinityAllowsControl,
  steeringAuthorizationAffinitiesMatch,
  type AuthorizedActiveRunAbortOutcome,
  type SteeringAuthorizationControlPolicy,
  type SteeringAuthorizationAffinity,
} from "../../auto-reply/reply/steering-authorization-affinity.js";
import {
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticEmbeddedRunEnded,
  markDiagnosticEmbeddedRunStarted,
  resolveRunStaleThresholdMs,
} from "../../logging/diagnostic-run-activity.js";
import {
  diagnosticLogger as diag,
  logMessageQueued,
  logSessionStateChange,
  updateDiagnosticSessionFile,
} from "../../logging/diagnostic.js";
import { createTurnAuthoritySnapshot } from "../../plugins/turn-authority.js";
import { resolveTimerTimeoutMs } from "../../shared/number-coercion.js";
import {
  ACTIVE_EMBEDDED_RUNS,
  ACTIVE_EMBEDDED_RUNS_BY_RUN_ID,
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE,
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY,
  ACTIVE_EMBEDDED_RUN_SNAPSHOTS,
  ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID,
  ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE,
  ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY,
  EMBEDDED_RUN_WAITERS,
  getActiveEmbeddedRunCount,
  RETAINED_EMBEDDED_RUN_ABORTABILITY_RUN_IDS,
  type ActiveEmbeddedRunSnapshot,
  type AbandonedEmbeddedRun,
  type EmbeddedAgentQueueHandle,
  type EmbeddedAgentQueueMessageOptions,
  type EmbeddedRunWaiter,
} from "./run-state.js";
import { resolveEmbeddedSessionFileKey } from "./session-file-key.js";

export {
  getActiveEmbeddedRunCount,
  listActiveEmbeddedRunSessionIds,
  listActiveEmbeddedRunSessionKeys,
  resolveActiveEmbeddedRunSessionId,
  type EmbeddedAgentQueueHandle,
  type EmbeddedAgentQueueMessageOptions,
} from "./run-state.js";

type EmbeddedAgentQueueFailureReason =
  | "no_active_run"
  | "not_streaming"
  | "stale_run"
  | "compacting"
  | "image_input_unsupported"
  | "source_reply_delivery_mode_mismatch"
  | "task_suggestion_delivery_mode_mismatch"
  | "authorization_affinity_mismatch"
  | "transcript_commit_wait_unsupported"
  | "runtime_rejected";

export type EmbeddedAgentQueueMessageOutcome =
  | {
      queued: true;
      sessionId: string;
      target: "embedded_run" | "reply_run";
      gatewayHealth: "live";
      deliveredAtMs?: number;
      enqueuedAtMs?: number;
    }
  | {
      queued: false;
      sessionId: string;
      reason: EmbeddedAgentQueueFailureReason;
      gatewayHealth: "live";
      errorMessage?: string;
    };

/**
 * Process-issued capability for one exact active embedded attempt.
 *
 * The queue closure rechecks handle identity before every injection. A model
 * fallback, restart, or replacement therefore invalidates the capability even
 * when the session, run ID, and sender authority are unchanged.
 */
export type ActiveEmbeddedRunSteeringTarget = Readonly<{
  sessionId: string;
  runId: string;
  queueMessageWithOutcome: (
    text: string,
    options?: EmbeddedAgentQueueMessageOptions,
  ) => Promise<EmbeddedAgentQueueMessageOutcome>;
}>;

/** Opaque identity for one exact active handle across an async authorization wait. */
export type CapturedActiveEmbeddedRunIdentity = Readonly<{
  sessionId: string;
  isCurrent: () => boolean;
  abortIfCurrent: () => AuthorizedActiveRunAbortOutcome;
}>;

const issuedActiveEmbeddedRunSteeringTargets = new WeakSet<object>();
const issuedActiveEmbeddedRunIdentities = new WeakSet<object>();
const abortedEmbeddedRunHandleByOutcome = new WeakMap<
  object,
  { sessionId: string; handle: EmbeddedAgentQueueHandle }
>();

type PreparedEmbeddedAgentQueueMessage =
  | {
      kind: "complete";
      outcome: EmbeddedAgentQueueMessageOutcome;
    }
  | {
      kind: "embedded_run";
      handle: EmbeddedAgentQueueHandle;
    };

// Validation-only affinity. It never reaches a backend handle. The trusted
// harness path uses it to keep every non-authorization queue invariant owned by
// resolveReplyBackendQueueMessageMismatch while bypassing only affinity.
const TRUSTED_AGENT_HARNESS_QUEUE_AFFINITY = createSteeringAuthorizationAffinity({
  turnAuthority: createTurnAuthoritySnapshot({
    principal: { kind: "service", serviceId: "openclaw:trusted-agent-harness-queue" },
    agentId: "openclaw",
    sessionKey: "agent:openclaw:trusted-agent-harness-queue",
    conversationId: "agent:openclaw:trusted-agent-harness-queue",
    controllerKey: "service:openclaw:trusted-agent-harness-queue",
  }),
});

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
function setActiveRunSessionKey(sessionKey: string | undefined, sessionId: string): void {
  const normalizedSessionKey = sessionKey?.trim();
  if (!normalizedSessionKey) {
    return;
  }
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.set(normalizedSessionKey, sessionId);
}

function clearActiveRunSessionKeys(sessionId: string, sessionKey?: string): void {
  const normalizedSessionKey = sessionKey?.trim();
  if (normalizedSessionKey) {
    if (ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.get(normalizedSessionKey) === sessionId) {
      ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.delete(normalizedSessionKey);
    }
    return;
  }
  for (const [key, activeSessionId] of ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY) {
    if (activeSessionId === sessionId) {
      ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.delete(key);
    }
  }
}

function setActiveRunSessionFile(sessionFile: string | undefined, sessionId: string): void {
  if (!sessionFile?.trim()) {
    return;
  }
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE.set(
    resolveEmbeddedSessionFileKey(sessionFile),
    sessionId,
  );
}

function clearEmbeddedRunAbandonmentBySessionId(sessionId: string): void {
  const abandonedRun = ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.get(sessionId);
  if (!abandonedRun) {
    return;
  }
  ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.delete(sessionId);
  const normalizedSessionKey = abandonedRun.sessionKey?.trim();
  if (
    normalizedSessionKey &&
    ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY.get(normalizedSessionKey) === sessionId
  ) {
    ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY.delete(normalizedSessionKey);
  }
  const normalizedSessionFile = abandonedRun.sessionFile?.trim();
  if (normalizedSessionFile) {
    const sessionFileKey = resolveEmbeddedSessionFileKey(normalizedSessionFile);
    if (ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE.get(sessionFileKey) === sessionId) {
      ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE.delete(sessionFileKey);
    }
  }
}

function clearEmbeddedRunAbandonmentBySessionKey(sessionKey: string | undefined): void {
  const normalizedSessionKey = sessionKey?.trim();
  if (!normalizedSessionKey) {
    return;
  }
  const sessionId = ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY.get(normalizedSessionKey);
  if (sessionId) {
    clearEmbeddedRunAbandonmentBySessionId(sessionId);
  }
}

function clearEmbeddedRunAbandonmentBySessionFile(sessionFile: string | undefined): void {
  const normalizedSessionFile = sessionFile?.trim();
  if (!normalizedSessionFile) {
    return;
  }
  const sessionFileKey = resolveEmbeddedSessionFileKey(normalizedSessionFile);
  const sessionId = ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE.get(sessionFileKey);
  if (sessionId) {
    clearEmbeddedRunAbandonmentBySessionId(sessionId);
  }
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
  clearEmbeddedRunAbandonmentBySessionKey(params.sessionKey);
  clearEmbeddedRunAbandonmentBySessionFile(params.sessionFile);
}

function markEmbeddedRunAbandoned(params: {
  sessionId: string;
  sessionKey?: string;
  sessionFile?: string;
  reason: AbandonedEmbeddedRun["reason"];
}): void {
  const sessionId = params.sessionId.trim();
  if (!sessionId) {
    return;
  }
  clearEmbeddedRunAbandonment({
    sessionId,
    sessionKey: params.sessionKey,
    sessionFile: params.sessionFile,
  });
  const abandonedRun: AbandonedEmbeddedRun = {
    sessionId,
    abandonedAtMs: Date.now(),
    reason: params.reason,
    ...(params.sessionKey?.trim() ? { sessionKey: params.sessionKey.trim() } : {}),
    ...(params.sessionFile?.trim() ? { sessionFile: params.sessionFile.trim() } : {}),
  };
  ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.set(sessionId, abandonedRun);
  if (abandonedRun.sessionKey) {
    ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY.set(abandonedRun.sessionKey, sessionId);
  }
  if (abandonedRun.sessionFile) {
    ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE.set(
      resolveEmbeddedSessionFileKey(abandonedRun.sessionFile),
      sessionId,
    );
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
  markEmbeddedRunAbandoned(params);
  return true;
}

export function isEmbeddedRunAbandoned(params: {
  sessionId?: string;
  sessionKey?: string;
  sessionFile?: string;
}): boolean {
  const normalizedSessionId = params.sessionId?.trim();
  if (normalizedSessionId && ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.has(normalizedSessionId)) {
    return true;
  }
  const normalizedSessionKey = params.sessionKey?.trim();
  if (normalizedSessionKey && ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY.has(normalizedSessionKey)) {
    return true;
  }
  const normalizedSessionFile = params.sessionFile?.trim();
  return Boolean(
    normalizedSessionFile &&
    ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE.has(
      resolveEmbeddedSessionFileKey(normalizedSessionFile),
    ),
  );
}

function clearActiveRunSessionFiles(sessionId: string, sessionFile?: string): void {
  const normalizedSessionFile = sessionFile?.trim();
  if (normalizedSessionFile) {
    const sessionFileKey = resolveEmbeddedSessionFileKey(normalizedSessionFile);
    if (ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE.get(sessionFileKey) === sessionId) {
      ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE.delete(sessionFileKey);
    }
  }
  for (const [sessionFileKey, activeSessionId] of ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE) {
    if (activeSessionId === sessionId) {
      ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE.delete(sessionFileKey);
    }
  }
}

/**
 * @deprecated Prefer queueEmbeddedAgentMessageWithOutcomeAsync when callers need to
 * know whether steering was accepted. This sync helper is fire-and-forget after
 * initial eligibility and only logs later runtime rejection.
 */
export function queueEmbeddedAgentMessageWithOutcome(
  sessionId: string,
  text: string,
  options?: EmbeddedAgentQueueMessageOptions,
): EmbeddedAgentQueueMessageOutcome {
  const prepared = prepareEmbeddedAgentQueueMessage(sessionId, text, options);
  return queuePreparedEmbeddedAgentMessageWithOutcome(sessionId, text, options, prepared);
}

/**
 * Internal compatibility path for installed native agent harness plugins.
 * The SDK wrapper is already privileged to register and abort active handles,
 * so it may queue against the exact handle captured here without sender affinity.
 * General runtime callers must use the strict queue functions above.
 *
 * @internal
 */
export function queueEmbeddedAgentHarnessMessageWithOutcome(
  sessionId: string,
  text: string,
  options?: EmbeddedAgentQueueMessageOptions,
): EmbeddedAgentQueueMessageOutcome {
  const prepared = prepareEmbeddedAgentHarnessQueueMessage(sessionId, text, options);
  return queuePreparedEmbeddedAgentMessageWithOutcome(sessionId, text, options, prepared);
}

function queuePreparedEmbeddedAgentMessageWithOutcome(
  sessionId: string,
  text: string,
  options: EmbeddedAgentQueueMessageOptions | undefined,
  prepared: PreparedEmbeddedAgentQueueMessage,
): EmbeddedAgentQueueMessageOutcome {
  if (prepared.kind === "complete") {
    return prepared.outcome;
  }
  logMessageQueued({ sessionId, source: "embedded-agent-runner" });
  void prepared.handle
    .queueMessage(text, options ?? { steeringMode: "all" })
    .catch((err: unknown) => {
      diag.debug(
        `queue message rejected after enqueue: sessionId=${sessionId} err=${formatQueueError(err)}`,
      );
    });
  return {
    queued: true,
    sessionId,
    target: "embedded_run",
    gatewayHealth: "live",
    enqueuedAtMs: Date.now(),
  };
}

function formatQueueError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isEmbeddedQueueHandleMessageInjectable(
  sessionId: string,
  handle: EmbeddedAgentQueueHandle,
): boolean {
  try {
    return handle.isStopped === undefined ? handle.isStreaming() : !handle.isStopped();
  } catch (err) {
    diag.warn(
      `queue message failed: sessionId=${sessionId} reason=injectable_check_failed err=${String(err)}`,
    );
    return false;
  }
}

function isEmbeddedRunHandleAbortable(
  sessionId: string,
  handle: EmbeddedAgentQueueHandle,
): boolean {
  try {
    return handle.isAbortable?.() !== false;
  } catch (err) {
    diag.warn(
      `abort failed: sessionId=${sessionId} reason=abortable_check_failed err=${String(err)}`,
    );
    return false;
  }
}

export function isEmbeddedAgentRunAbortableForRunId(runId: string): boolean {
  const normalizedRunId = runId.trim();
  if (!normalizedRunId) {
    return true;
  }
  const handle = ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(normalizedRunId);
  return handle ? isEmbeddedRunHandleAbortable(normalizedRunId, handle) : true;
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
  options?: EmbeddedAgentQueueMessageOptions,
): Promise<EmbeddedAgentQueueMessageOutcome> {
  const prepared = prepareEmbeddedAgentQueueMessage(sessionId, text, options);
  return await queuePreparedEmbeddedAgentMessageWithOutcomeAsync(
    sessionId,
    text,
    options,
    prepared,
  );
}

async function queuePreparedEmbeddedAgentMessageWithOutcomeAsync(
  sessionId: string,
  text: string,
  options: EmbeddedAgentQueueMessageOptions | undefined,
  prepared: PreparedEmbeddedAgentQueueMessage,
): Promise<EmbeddedAgentQueueMessageOutcome> {
  if (prepared.kind === "complete") {
    return prepared.outcome;
  }
  try {
    const enqueuedAtMs = Date.now();
    await prepared.handle.queueMessage(text, options ?? { steeringMode: "all" });
    const deliveredAtMs = options?.waitForTranscriptCommit ? Date.now() : undefined;
    logMessageQueued({ sessionId, source: "embedded-agent-runner" });
    return {
      queued: true,
      sessionId,
      target: "embedded_run",
      gatewayHealth: "live",
      ...(deliveredAtMs !== undefined ? { deliveredAtMs } : {}),
      enqueuedAtMs,
    };
  } catch (err) {
    const errorMessage = formatQueueError(err);
    diag.debug(`queue message rejected: sessionId=${sessionId} err=${errorMessage}`);
    return createQueueFailureOutcome(sessionId, "runtime_rejected", errorMessage);
  }
}

/** Capture one exact active attempt for a later trusted internal handoff. */
export function captureActiveEmbeddedRunSteeringTarget(params: {
  sessionId?: string;
  runId?: string;
  steeringAuthorizationAffinity?: SteeringAuthorizationAffinity;
}): ActiveEmbeddedRunSteeringTarget | undefined {
  const sessionId = params.sessionId?.trim();
  const runId = params.runId?.trim();
  if (!sessionId || !runId) {
    return undefined;
  }
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  const steeringAuthorizationAffinity = handle?.steeringAuthorizationAffinity;
  if (
    !handle ||
    handle.runId !== runId ||
    !steeringAuthorizationAffinity ||
    !steeringAuthorizationAffinitiesMatch(
      steeringAuthorizationAffinity,
      params.steeringAuthorizationAffinity,
    )
  ) {
    return undefined;
  }

  const target: ActiveEmbeddedRunSteeringTarget = Object.freeze({
    sessionId,
    runId,
    queueMessageWithOutcome: async (
      text: string,
      options?: EmbeddedAgentQueueMessageOptions,
    ): Promise<EmbeddedAgentQueueMessageOutcome> => {
      if (
        !issuedActiveEmbeddedRunSteeringTargets.has(target) ||
        ACTIVE_EMBEDDED_RUNS.get(sessionId) !== handle ||
        handle.runId !== runId
      ) {
        return createQueueFailureOutcome(sessionId, "no_active_run");
      }
      return await queueEmbeddedAgentMessageForCapturedHandle({
        sessionId,
        handle,
        text,
        options: {
          ...options,
          steeringAuthorizationAffinity,
        },
      });
    },
  });
  issuedActiveEmbeddedRunSteeringTargets.add(target);
  return target;
}

/** Capture handle identity without exposing the mutable runtime handle. */
export function captureActiveEmbeddedRunIdentity(
  sessionId: string,
): CapturedActiveEmbeddedRunIdentity | undefined {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    return undefined;
  }
  const handle = ACTIVE_EMBEDDED_RUNS.get(normalizedSessionId);
  if (!handle) {
    return undefined;
  }
  const identity: CapturedActiveEmbeddedRunIdentity = Object.freeze({
    sessionId: normalizedSessionId,
    isCurrent: () =>
      issuedActiveEmbeddedRunIdentities.has(identity) &&
      ACTIVE_EMBEDDED_RUNS.get(normalizedSessionId) === handle,
    abortIfCurrent: (): AuthorizedActiveRunAbortOutcome => {
      if (
        !issuedActiveEmbeddedRunIdentities.has(identity) ||
        ACTIVE_EMBEDDED_RUNS.get(normalizedSessionId) !== handle
      ) {
        return {
          status: "not_active",
          replacementObserved: ACTIVE_EMBEDDED_RUNS.has(normalizedSessionId),
        };
      }
      if (!isEmbeddedRunHandleAbortable(normalizedSessionId, handle)) {
        return { status: "not_abortable", replacementObserved: false };
      }
      try {
        handle.abort();
        const current = ACTIVE_EMBEDDED_RUNS.get(normalizedSessionId);
        return Object.freeze({
          status: "aborted" as const,
          replacementObserved: current !== undefined && current !== handle,
          ...(handle.steeringAuthorizationAffinity
            ? { controlledAuthorizationAffinity: handle.steeringAuthorizationAffinity }
            : {}),
        });
      } catch (error) {
        diag.warn(`captured abort failed: sessionId=${normalizedSessionId} err=${String(error)}`);
        return { status: "failed", replacementObserved: false };
      }
    },
  });
  issuedActiveEmbeddedRunIdentities.add(identity);
  return identity;
}

async function queueEmbeddedAgentMessageForCapturedHandle(params: {
  sessionId: string;
  handle: EmbeddedAgentQueueHandle;
  text: string;
  options?: EmbeddedAgentQueueMessageOptions;
}): Promise<EmbeddedAgentQueueMessageOutcome> {
  const prepared = prepareEmbeddedAgentQueueMessageForHandle(
    params.sessionId,
    params.text,
    params.options,
    params.handle,
    false,
  );
  return await queuePreparedEmbeddedAgentMessageWithOutcomeAsync(
    params.sessionId,
    params.text,
    params.options,
    prepared,
  );
}

function prepareEmbeddedAgentQueueMessage(
  sessionId: string,
  text: string,
  options?: EmbeddedAgentQueueMessageOptions,
): PreparedEmbeddedAgentQueueMessage {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  return prepareEmbeddedAgentQueueMessageForHandle(sessionId, text, options, handle, false);
}

function prepareEmbeddedAgentHarnessQueueMessage(
  sessionId: string,
  text: string,
  options?: EmbeddedAgentQueueMessageOptions,
): PreparedEmbeddedAgentQueueMessage {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle) {
    diag.debug(`queue message failed: sessionId=${sessionId} reason=no_active_run`);
    return { kind: "complete", outcome: createQueueFailureOutcome(sessionId, "no_active_run") };
  }
  return prepareEmbeddedAgentQueueMessageForHandle(sessionId, text, options, handle, true);
}

function prepareEmbeddedAgentQueueMessageForHandle(
  sessionId: string,
  text: string,
  options: EmbeddedAgentQueueMessageOptions | undefined,
  handle: EmbeddedAgentQueueHandle | undefined,
  trustedAgentHarness: boolean,
): PreparedEmbeddedAgentQueueMessage {
  if (!handle) {
    // A stale reply-backed run must produce the same closed reason as the
    // embedded gate so announce delivery falls through to direct instead of
    // reading the wedged op as active and dropping the handoff.
    if (isReplyRunEvidenceStaleBySessionId(sessionId)) {
      diag.debug(`queue message failed: sessionId=${sessionId} reason=stale_run`);
      return { kind: "complete", outcome: createQueueFailureOutcome(sessionId, "stale_run") };
    }
    if (options?.waitForTranscriptCommit === true) {
      diag.debug(
        `queue message failed: sessionId=${sessionId} reason=transcript_commit_wait_unsupported`,
      );
      return {
        kind: "complete",
        outcome: createQueueFailureOutcome(sessionId, "transcript_commit_wait_unsupported"),
      };
    }
    const queuedReplyRunMessage = queueReplyRunMessage(sessionId, text, options);
    if (queuedReplyRunMessage) {
      logMessageQueued({ sessionId, source: "embedded-agent-runner" });
      return {
        kind: "complete",
        outcome: {
          queued: true,
          sessionId,
          target: "reply_run",
          gatewayHealth: "live",
          enqueuedAtMs: Date.now(),
        },
      };
    }
    diag.debug(`queue message failed: sessionId=${sessionId} reason=no_active_run`);
    return { kind: "complete", outcome: createQueueFailureOutcome(sessionId, "no_active_run") };
  }
  if (!isEmbeddedQueueHandleMessageInjectable(sessionId, handle)) {
    diag.debug(`queue message failed: sessionId=${sessionId} reason=not_streaming`);
    return { kind: "complete", outcome: createQueueFailureOutcome(sessionId, "not_streaming") };
  }
  const activity = getDiagnosticSessionActivitySnapshot({ sessionId });
  if (
    typeof activity.lastProgressAgeMs === "number" &&
    activity.lastProgressAgeMs > resolveRunStaleThresholdMs(activity)
  ) {
    diag.debug(`queue message failed: sessionId=${sessionId} reason=stale_run`);
    return { kind: "complete", outcome: createQueueFailureOutcome(sessionId, "stale_run") };
  }
  if (handle.isCompacting()) {
    diag.debug(`queue message failed: sessionId=${sessionId} reason=compacting`);
    return { kind: "complete", outcome: createQueueFailureOutcome(sessionId, "compacting") };
  }
  if (options?.waitForTranscriptCommit === true && handle.supportsTranscriptCommitWait !== true) {
    diag.debug(
      `queue message failed: sessionId=${sessionId} reason=transcript_commit_wait_unsupported`,
    );
    return {
      kind: "complete",
      outcome: createQueueFailureOutcome(sessionId, "transcript_commit_wait_unsupported"),
    };
  }
  const deliveryModeMismatch = trustedAgentHarness
    ? resolveReplyBackendQueueMessageMismatch(
        {
          sourceReplyDeliveryMode: handle.sourceReplyDeliveryMode,
          steeringAuthorizationAffinity: TRUSTED_AGENT_HARNESS_QUEUE_AFFINITY,
          supportsQueueMessageImages: handle.supportsQueueMessageImages,
          taskSuggestionDeliveryMode: handle.taskSuggestionDeliveryMode,
        },
        {
          ...options,
          steeringAuthorizationAffinity: TRUSTED_AGENT_HARNESS_QUEUE_AFFINITY,
        },
      )
    : resolveReplyBackendQueueMessageMismatch(handle, options);
  if (deliveryModeMismatch) {
    diag.debug(`queue message failed: sessionId=${sessionId} reason=${deliveryModeMismatch}`);
    return {
      kind: "complete",
      outcome: createQueueFailureOutcome(sessionId, deliveryModeMismatch),
    };
  }
  return { kind: "embedded_run", handle };
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
    return true;
  }

  const abortActiveEmbeddedRunHandles = (params: {
    shouldAbort: (handle: EmbeddedAgentQueueHandle) => boolean;
    formatDebugMessage: (sessionId: string) => string;
    skipSessionIds?: ReadonlySet<string>;
  }): boolean => {
    let aborted = false;
    for (const [id, handle] of ACTIVE_EMBEDDED_RUNS) {
      if (params.skipSessionIds?.has(id)) {
        continue;
      }
      if (!params.shouldAbort(handle)) {
        continue;
      }
      if (!isEmbeddedRunHandleAbortable(id, handle)) {
        continue;
      }
      diag.debug(params.formatDebugMessage(id));
      try {
        handle.abort(opts?.reason);
        aborted = true;
      } catch (err) {
        diag.warn(`abort failed: sessionId=${id} err=${String(err)}`);
      }
    }
    return aborted;
  };

  const mode = opts?.mode;
  if (mode === "compacting") {
    const replyOwnedSessionIds = new Set(listActiveReplyRunSessionIds());
    const replyAborted = abortActiveReplyRuns({
      mode,
      onAbortError: (id, err) =>
        diag.warn(`abort failed: sessionId=${id} owner=reply_run err=${String(err)}`),
    });
    const aborted = abortActiveEmbeddedRunHandles({
      shouldAbort: (handle) => handle.isCompacting(),
      formatDebugMessage: (id) => `aborting compacting run: sessionId=${id}`,
      skipSessionIds: replyOwnedSessionIds,
    });
    return replyAborted || aborted;
  }

  if (mode === "all") {
    const replyOwnedSessionIds = new Set(listActiveReplyRunSessionIds());
    const replyAborted = abortActiveReplyRuns({
      mode,
      onAbortError: (id, err) =>
        diag.warn(`abort failed: sessionId=${id} owner=reply_run err=${String(err)}`),
    });
    const aborted = abortActiveEmbeddedRunHandles({
      shouldAbort: () => true,
      formatDebugMessage: (id) => `aborting run: sessionId=${id}`,
      skipSessionIds: replyOwnedSessionIds,
    });
    return replyAborted || aborted;
  }

  return false;
}

/**
 * Abort one captured active run only when its immutable turn authority permits control.
 * The post-abort identity check prevents a synchronous replacement from being mistaken
 * for the run that was authorized.
 */
export function abortActiveRunWithSteeringAuthorization(params: {
  sessionId: string;
  steeringAuthorizationAffinity?: SteeringAuthorizationAffinity;
  policy: SteeringAuthorizationControlPolicy;
}): AuthorizedActiveRunAbortOutcome {
  const handle = ACTIVE_EMBEDDED_RUNS.get(params.sessionId);
  if (!handle) {
    return abortReplyRunBySessionIdWithAuthorization(params);
  }
  if (
    !steeringAuthorizationAffinityAllowsControl({
      expected: handle.steeringAuthorizationAffinity,
      incoming: params.steeringAuthorizationAffinity,
      policy: params.policy,
    })
  ) {
    return { status: "unauthorized", replacementObserved: false };
  }
  if (!isEmbeddedRunHandleAbortable(params.sessionId, handle)) {
    return { status: "not_abortable", replacementObserved: false };
  }
  diag.debug(`authorized abort: sessionId=${params.sessionId}`);
  try {
    handle.abort();
    const current = ACTIVE_EMBEDDED_RUNS.get(params.sessionId);
    const outcome: AuthorizedActiveRunAbortOutcome = Object.freeze({
      status: "aborted",
      replacementObserved: current !== undefined && current !== handle,
      controlledAuthorizationAffinity: handle.steeringAuthorizationAffinity,
    });
    abortedEmbeddedRunHandleByOutcome.set(outcome, { sessionId: params.sessionId, handle });
    return outcome;
  } catch (error) {
    diag.warn(`authorized abort failed: sessionId=${params.sessionId} err=${String(error)}`);
    return { status: "failed", replacementObserved: false };
  }
}

/** Recheck the captured run after an awaited controller cleanup, before clearing queues. */
export function authorizedActiveRunAbortObservedReplacement(
  outcome: AuthorizedActiveRunAbortOutcome,
): boolean {
  if (outcome.replacementObserved) {
    return true;
  }
  const captured = abortedEmbeddedRunHandleByOutcome.get(outcome);
  if (!captured) {
    return false;
  }
  const current = ACTIVE_EMBEDDED_RUNS.get(captured.sessionId);
  return current !== undefined && current !== captured.handle;
}

export function isEmbeddedAgentRunActive(sessionId: string): boolean {
  const active = ACTIVE_EMBEDDED_RUNS.has(sessionId) || isReplyRunActiveForSessionId(sessionId);
  if (active) {
    diag.debug(`run active check: sessionId=${sessionId} active=true`);
  }
  return active;
}

export function resolveEmbeddedAgentReplyRunPhase(
  sessionId: string,
): ReplyOperationPhase | undefined {
  return resolveReplyRunPhaseForSessionId(sessionId);
}

export function isEmbeddedAgentRunHandleActive(sessionId: string): boolean {
  const active = ACTIVE_EMBEDDED_RUNS.has(sessionId);
  if (active) {
    diag.debug(`run handle active check: sessionId=${sessionId} active=true`);
  }
  return active;
}

export function isEmbeddedAgentRunAbortableForCompaction(sessionId: string): boolean {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  const active = handle ? true : isReplyRunAbortableForCompaction(sessionId);
  if (active) {
    diag.debug(`run compact coordination check: sessionId=${sessionId} active=true`);
  }
  return active;
}

export function isEmbeddedAgentRunStreaming(sessionId: string): boolean {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle) {
    return isReplyRunStreamingForSessionId(sessionId);
  }
  return handle.isStreaming();
}

export function resolveActiveEmbeddedRunHandleSessionId(sessionKey: string): string | undefined {
  const normalizedSessionKey = sessionKey.trim();
  if (!normalizedSessionKey) {
    return undefined;
  }
  return ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.get(normalizedSessionKey);
}

export function resolveActiveEmbeddedRunHandleSessionIdBySessionFile(
  sessionFile: string,
): string | undefined {
  const normalizedSessionFile = sessionFile.trim();
  if (!normalizedSessionFile) {
    return undefined;
  }
  return ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE.get(
    resolveEmbeddedSessionFileKey(normalizedSessionFile),
  );
}

export function resolveActiveEmbeddedRunSessionIdBySessionFile(
  sessionFile: string,
): string | undefined {
  return resolveActiveEmbeddedRunHandleSessionIdBySessionFile(sessionFile);
}

export function getActiveEmbeddedRunSnapshot(
  sessionId: string,
): ActiveEmbeddedRunSnapshot | undefined {
  return ACTIVE_EMBEDDED_RUN_SNAPSHOTS.get(sessionId);
}

/**
 * Wait for active embedded runs to drain.
 *
 * Used during restarts so in-flight runs can release session write locks before
 * the next lifecycle starts. If no timeout is passed, waits indefinitely.
 */
export async function waitForActiveEmbeddedRuns(
  timeoutMs?: number,
  opts?: { pollMs?: number },
): Promise<{ drained: boolean }> {
  const pollMsRaw = opts?.pollMs ?? 250;
  const pollMs = resolveTimerTimeoutMs(pollMsRaw, 250, 10);
  if (timeoutMs !== undefined && timeoutMs <= 0) {
    return { drained: getActiveEmbeddedRunCount() === 0 };
  }
  const maxWaitMs =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
      ? Math.max(pollMs, Math.floor(timeoutMs))
      : undefined;

  const startedAt = Date.now();
  while (true) {
    if (getActiveEmbeddedRunCount() === 0) {
      return { drained: true };
    }
    const elapsedMs = Date.now() - startedAt;
    if (maxWaitMs !== undefined && elapsedMs >= maxWaitMs) {
      diag.warn(
        `wait for active embedded runs timed out: activeRuns=${getActiveEmbeddedRunCount()} timeoutMs=${maxWaitMs}`,
      );
      return { drained: false };
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, pollMs);
    });
  }
}

function waitForCurrentEmbeddedAgentRunEnd(
  sessionId: string,
  timeoutMs: number | null,
): Promise<boolean> {
  if (!ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
    return waitForReplyRunEndBySessionId(sessionId, timeoutMs);
  }
  const timeoutLabel = timeoutMs === null ? "none" : String(timeoutMs);
  diag.debug(`waiting for run end: sessionId=${sessionId} timeoutMs=${timeoutLabel}`);
  return new Promise((resolve) => {
    const waiters = EMBEDDED_RUN_WAITERS.get(sessionId) ?? new Set();
    const waiter: EmbeddedRunWaiter = {
      resolve,
    };
    if (timeoutMs !== null) {
      waiter.timer = setTimeout(
        () => {
          waiters.delete(waiter);
          if (waiters.size === 0) {
            EMBEDDED_RUN_WAITERS.delete(sessionId);
          }
          diag.warn(`wait timeout: sessionId=${sessionId} timeoutMs=${timeoutMs}`);
          resolve(false);
        },
        resolveTimerTimeoutMs(timeoutMs, 100, 100),
      );
    }
    waiters.add(waiter);
    EMBEDDED_RUN_WAITERS.set(sessionId, waiters);
    if (!ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
      waiters.delete(waiter);
      if (waiters.size === 0) {
        EMBEDDED_RUN_WAITERS.delete(sessionId);
      }
      if (waiter.timer) {
        clearTimeout(waiter.timer);
      }
      resolve(true);
    }
  });
}

export async function waitForEmbeddedAgentRunEnd(
  sessionId: string,
  timeoutMs: number | null = 15_000,
): Promise<boolean> {
  if (!sessionId) {
    return true;
  }
  const deadline = timeoutMs === null ? undefined : Date.now() + timeoutMs;
  while (isEmbeddedAgentRunActive(sessionId)) {
    const remainingMs = deadline === undefined ? null : deadline - Date.now();
    if (remainingMs !== null && remainingMs <= 0) {
      return false;
    }
    if (!(await waitForCurrentEmbeddedAgentRunEnd(sessionId, remainingMs))) {
      return false;
    }
  }
  return true;
}

export type AbortAndDrainEmbeddedAgentRunResult = {
  aborted: boolean;
  drained: boolean;
  forceCleared: boolean;
};

export async function abortAndDrainEmbeddedAgentRun(params: {
  sessionId: string;
  sessionKey?: string;
  settleMs?: number;
  forceClear?: boolean;
  reason?: string;
}): Promise<AbortAndDrainEmbeddedAgentRunResult> {
  const settleMs = params.settleMs ?? 15_000;
  // Recovery is a staleness expiry: stamp run_stalled on the reply operation
  // BEFORE any handle abort, or the run loop's abort handler re-enters
  // abortByUser and misattributes the watchdog kill to the user.
  const expiredReplyRun =
    params.reason === "stuck_recovery" &&
    expireStaleReplyRunBySessionId(params.sessionId, "stuck_recovery");
  if (expiredReplyRun && !ACTIVE_EMBEDDED_RUNS.has(params.sessionId)) {
    // Reply expiry aborts synchronously and clears registry ownership. Let the
    // command lane observe that abort before recovery decides whether to reset it.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    const drained = await waitForEmbeddedAgentRunEnd(params.sessionId, settleMs);
    return { aborted: true, drained, forceCleared: false };
  }
  const aborted = abortEmbeddedAgentRun(params.sessionId) || expiredReplyRun;
  const drained = aborted ? await waitForEmbeddedAgentRunEnd(params.sessionId, settleMs) : false;
  const forceCleared =
    params.forceClear === true && (!aborted || !drained)
      ? forceClearEmbeddedAgentRun(params.sessionId, params.sessionKey, params.reason)
      : false;
  return { aborted, drained, forceCleared };
}

function notifyEmbeddedRunEnded(sessionId: string) {
  const waiters = EMBEDDED_RUN_WAITERS.get(sessionId);
  if (!waiters || waiters.size === 0) {
    return;
  }
  EMBEDDED_RUN_WAITERS.delete(sessionId);
  diag.debug(`notifying waiters: sessionId=${sessionId} waiterCount=${waiters.size}`);
  for (const waiter of waiters) {
    if (waiter.timer) {
      clearTimeout(waiter.timer);
    }
    waiter.resolve(true);
  }
}

export function setActiveEmbeddedRun(
  sessionId: string,
  handle: EmbeddedAgentQueueHandle,
  sessionKey?: string,
  sessionFile?: string,
) {
  const previousHandle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  const wasActive = previousHandle !== undefined;
  if (previousHandle) {
    clearEmbeddedRunAbortability(previousHandle, { retainFinalizing: true });
  }
  clearEmbeddedRunAbandonment({ sessionId, sessionKey, sessionFile });
  ACTIVE_EMBEDDED_RUNS.set(sessionId, handle);
  if (handle.runId) {
    ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.set(handle.runId, handle);
  }
  setActiveRunSessionKey(sessionKey, sessionId);
  clearActiveRunSessionFiles(sessionId);
  setActiveRunSessionFile(sessionFile, sessionId);
  logSessionStateChange({
    sessionId,
    sessionKey,
    sessionFile,
    state: "processing",
    reason: wasActive ? "run_replaced" : "run_started",
  });
  markDiagnosticEmbeddedRunStarted({ sessionId, sessionKey });
  if (!sessionId.startsWith("probe-")) {
    diag.debug(`run registered: sessionId=${sessionId} totalActive=${ACTIVE_EMBEDDED_RUNS.size}`);
  }
}

export function updateActiveEmbeddedRunSnapshot(
  sessionId: string,
  snapshot: ActiveEmbeddedRunSnapshot,
) {
  if (!ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
    return;
  }
  ACTIVE_EMBEDDED_RUN_SNAPSHOTS.set(sessionId, snapshot);
}

export function updateActiveEmbeddedRunSessionFile(
  sessionId: string,
  sessionFile: string | undefined,
): void {
  if (!ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
    return;
  }
  clearActiveRunSessionFiles(sessionId);
  setActiveRunSessionFile(sessionFile, sessionId);
  updateDiagnosticSessionFile({ sessionId, sessionFile });
}

export function clearActiveEmbeddedRun(
  sessionId: string,
  handle: EmbeddedAgentQueueHandle,
  sessionKey?: string,
  sessionFile?: string,
  reason = "run_completed",
) {
  const activeHandle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (activeHandle === undefined) {
    return;
  }
  if (activeHandle === handle) {
    ACTIVE_EMBEDDED_RUNS.delete(sessionId);
    clearEmbeddedRunAbortability(handle, { retainFinalizing: true });
    ACTIVE_EMBEDDED_RUN_SNAPSHOTS.delete(sessionId);
    clearActiveRunSessionKeys(sessionId, sessionKey);
    clearActiveRunSessionFiles(sessionId, sessionFile);
    logSessionStateChange({
      sessionId,
      sessionKey,
      sessionFile,
      state: "idle",
      reason,
    });
    markDiagnosticEmbeddedRunEnded({ sessionId, sessionKey });
    if (!sessionId.startsWith("probe-")) {
      diag.debug(`run cleared: sessionId=${sessionId} totalActive=${ACTIVE_EMBEDDED_RUNS.size}`);
    }
    notifyEmbeddedRunEnded(sessionId);
  } else {
    diag.debug(`run clear skipped: sessionId=${sessionId} reason=handle_mismatch`);
  }
}

function forceClearEmbeddedAgentRun(
  sessionId: string,
  sessionKey?: string,
  reason = "stuck_recovery",
): boolean {
  let cleared = false;
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (handle) {
    ACTIVE_EMBEDDED_RUNS.delete(sessionId);
    clearEmbeddedRunAbortability(handle);
    ACTIVE_EMBEDDED_RUN_SNAPSHOTS.delete(sessionId);
    clearActiveRunSessionKeys(sessionId, sessionKey);
    clearActiveRunSessionFiles(sessionId);
    logSessionStateChange({ sessionId, sessionKey, state: "idle", reason });
    markDiagnosticEmbeddedRunEnded({ sessionId, sessionKey });
    notifyEmbeddedRunEnded(sessionId);
    cleared = true;
  }
  const cause = new Error(`Embedded run force-cleared by ${reason}`);
  return forceClearReplyRunBySessionId(sessionId, cause) || cleared;
}

const testing = {
  resetActiveEmbeddedRuns() {
    for (const waiters of EMBEDDED_RUN_WAITERS.values()) {
      for (const waiter of waiters) {
        if (waiter.timer) {
          clearTimeout(waiter.timer);
        }
        waiter.resolve(true);
      }
    }
    EMBEDDED_RUN_WAITERS.clear();
    ACTIVE_EMBEDDED_RUNS.clear();
    ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.clear();
    RETAINED_EMBEDDED_RUN_ABORTABILITY_RUN_IDS.clear();
    ACTIVE_EMBEDDED_RUN_SNAPSHOTS.clear();
    ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.clear();
    ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE.clear();
    ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.clear();
    ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY.clear();
    ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE.clear();
  },
};

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.embeddedRunsTestApi")] =
    testing;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
