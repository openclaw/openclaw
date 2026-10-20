import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../infra/agent-events.js";
import {
  getActiveAgentRunDelegatedAuthority,
  getAgentRunContext,
} from "../../infra/agent-run-registry.js";
import { notifyGatewayWorkMetricsChanged } from "../../infra/gateway-work-metrics-events.js";
import {
  isDiagnosticEmbeddedRunOwnerClosed,
  markDiagnosticEmbeddedRunEnded,
  markDiagnosticEmbeddedRunStarted,
  markDiagnosticRunProgress,
} from "../../logging/diagnostic-run-activity.js";
import { diagnosticLogger as diag, logSessionStateChange } from "../../logging/diagnostic.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import type {
  SessionControllerEntry,
  ReplyBackendHandle,
} from "../../sessions/session-controller.contracts.js";
import {
  abortActiveReplyRuns,
  resolveActiveReplyOperationForSessionId,
  type ReplyOperation,
  waitForReplyOperationOwnerSettlement,
} from "../../sessions/session-controller.js";
import {
  waitForCapturedSessionNativeAttemptEnd,
  waitForSessionNativeAttemptEnd,
} from "../../sessions/session-controller.native-runtime.js";
import {
  assertSessionControllerOperation,
  getAttachedBackend,
  getSessionControllerEntryForOperation,
  getSessionControllerOperation,
  markReplyOperationExecutionStarted,
  readSessionControllerOperationState,
  resolveReplyRunForCurrentSessionId,
} from "../../sessions/session-controller.state.js";
import {
  captureSessionControllerStop,
  stopSession,
} from "../../sessions/session-controller.stop.js";
import {
  sessionTargetOwnersMatch,
  type SessionTarget,
} from "../../sessions/session-controller.target.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { settlesWithin } from "../../shared/settle-within.js";
import { SessionControllerAdmissionRequiredError } from "../harness/errors.js";
import {
  createAgentRunDirectAbortError,
  createAgentRunRestartAbortError,
} from "../run-termination.js";
import { resolveSessionPlacementForcedTerminalSettlement } from "../session-placement-forced-terminal-settlement.js";
import { getGatewayToolCallerIdentity } from "../tools/gateway-caller-context.js";
import {
  getActiveNativeAttempt,
  getDetachedNativeAttachment,
  nativeAttemptAttachments,
  attachNativeAttempt,
  detachNativeAttempt,
  embeddedRunCleanupAttachment,
  getControllerEmbeddedAttachment,
  getEmbeddedRunAttachment,
  isCurrentEmbeddedRunAttachment,
  waitForEmbeddedRunOwnerSettlement,
  ACTIVE_EMBEDDED_RUNS_BY_RUN_ID,
  ACTIVE_EMBEDDED_RUNS_BY_FILE,
  ACTIVE_EMBEDDED_RUN_SNAPSHOTS,
  ABANDONED_EMBEDDED_RUNS,
  EMBEDDED_RUN_COMPLETION_CLAIMS,
  EMBEDDED_RUN_FORCED_TERMINAL_SETTLEMENTS,
  type ActiveEmbeddedRunSnapshot,
  type AbandonedEmbeddedRun,
  type EmbeddedAgentQueueHandle,
  type EmbeddedRunCompletionClaim,
  type EmbeddedRunCompletionRegistration,
  type ActiveEmbeddedRunAttachment,
  type EmbeddedRunRegistration,
} from "./run-state.js";
import { isEmbeddedRunHandleAbortable, isEmbeddedRunHandleInProgress } from "./runs.probes.js";
import { normalizeSessionFileRegistryKey } from "./runs.session-index.js";
import { createEmbeddedRunsTestApi } from "./runs.test-cleanup.js";

export type { EmbeddedAgentQueueHandle, EmbeddedAgentQueueMessageOptions } from "./run-state.js";
export { claimPendingEmbeddedAgentQuestionAnswer } from "./runs.question-answer.js";

export type EmbeddedRunTimeoutRecoveryMarker = AbandonedEmbeddedRun;

type AbandonmentOwner = SessionControllerEntry | string;
type AbandonmentQuery = {
  sessionId?: string;
  sessionKey?: string;
  sessionFile?: string;
  target?: SessionTarget;
};

function matchesAbandonment(
  owner: AbandonmentOwner,
  abandoned: AbandonedEmbeddedRun,
  query: AbandonmentQuery,
): boolean {
  if (
    query.target &&
    (typeof owner === "string" ||
      !owner.target ||
      !sessionTargetOwnersMatch(owner.target, query.target))
  ) {
    return false;
  }
  const key = query.sessionKey?.trim() ?? query.target?.sessionKey;
  const file = query.sessionFile;
  return Boolean(
    (query.sessionId?.trim() && abandoned.sessionId === query.sessionId.trim()) ||
    (key &&
      (abandoned.sessionKey === key ||
        (typeof owner !== "string" && owner.logicalAliases.has(key)))) ||
    (file && abandoned.sessionFile === file),
  );
}

function clearEmbeddedRunAbandonment(owner: AbandonmentOwner, params: AbandonmentQuery): void {
  const query = { ...params, sessionFile: normalizeSessionFileRegistryKey(params.sessionFile) };
  for (const [previousOwner, abandoned] of ABANDONED_EMBEDDED_RUNS) {
    // Idle entries are pruned. A successor may have a new entry and session ID,
    // but only the same store/agent and logical key or file clears its timeout.
    const sameScope =
      typeof owner === "string"
        ? typeof previousOwner === "string"
        : typeof previousOwner !== "string" &&
          (owner.target && previousOwner.target
            ? sessionTargetOwnersMatch(owner.target, previousOwner.target)
            : owner.target === previousOwner.target);
    if (
      previousOwner === owner ||
      (sameScope && matchesAbandonment(previousOwner, abandoned, query))
    ) {
      ABANDONED_EMBEDDED_RUNS.delete(previousOwner);
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
  const attachment = getEmbeddedRunAttachment(params.handle);
  if (
    !sessionId ||
    !attachment ||
    attachment.sessionId !== sessionId ||
    !isCurrentEmbeddedRunAttachment(attachment)
  ) {
    return false;
  }
  const owner = attachment.operation
    ? getSessionControllerEntryForOperation(attachment.operation)
    : sessionId;
  clearEmbeddedRunAbandonment(owner, params);
  const sessionKey = (params.sessionKey ?? attachment.sessionKey)?.trim();
  const sessionFile = normalizeSessionFileRegistryKey(params.sessionFile);
  const runId = params.handle.runId?.trim();
  ABANDONED_EMBEDDED_RUNS.set(owner, {
    sessionId,
    ...(runId ? { runId } : {}),
    abandonedAtMs: Date.now(),
    reason: params.reason,
    ...(sessionKey ? { sessionKey } : {}),
    ...(sessionFile ? { sessionFile } : {}),
  });
  return true;
}

export function resolveEmbeddedRunAbandonment(
  params: AbandonmentQuery,
): AbandonedEmbeddedRun["reason"] | undefined {
  const query = { ...params, sessionFile: normalizeSessionFileRegistryKey(params.sessionFile) };
  const matches = [...ABANDONED_EMBEDDED_RUNS].filter(
    ([owner, abandoned]) =>
      (!query.sessionFile || abandoned.sessionFile === query.sessionFile) &&
      matchesAbandonment(owner, abandoned, query),
  );
  return matches.length === 1 ? matches[0]![1].reason : undefined;
}

/**
 * Temporarily releases terminal-timeout delivery suppression while a timed-out
 * attempt is performing an eligible compaction-and-retry recovery.
 */
export function markEmbeddedRunRecoveringTimeout(params: {
  sessionId: string;
  runId?: string;
  operation?: ReplyOperation;
}): EmbeddedRunTimeoutRecoveryMarker | undefined {
  const matches = params.operation
    ? [ABANDONED_EMBEDDED_RUNS.get(getSessionControllerEntryForOperation(params.operation))]
    : [...ABANDONED_EMBEDDED_RUNS.values()].filter(
        (abandoned) =>
          abandoned.sessionId === params.sessionId.trim() &&
          (!abandoned.runId || abandoned.runId === params.runId?.trim()),
      );
  const abandoned = matches.length === 1 ? matches[0] : undefined;
  if (
    !abandoned ||
    abandoned.sessionId !== params.sessionId.trim() ||
    abandoned.reason !== "timeout" ||
    (abandoned.runId && abandoned.runId !== params.runId?.trim())
  ) {
    return undefined;
  }
  abandoned.reason = "recovering_timeout";
  return abandoned;
}

/** Restores terminal-timeout suppression when recovery cannot continue. */
export function restoreEmbeddedRunTimeoutAbandonment(
  marker: EmbeddedRunTimeoutRecoveryMarker,
): boolean {
  if (
    marker.reason !== "recovering_timeout" ||
    ![...ABANDONED_EMBEDDED_RUNS.values()].includes(marker)
  ) {
    return false;
  }
  marker.reason = "timeout";
  return true;
}

function clearEmbeddedRunAbortability(handle: EmbeddedAgentQueueHandle): void {
  getEmbeddedRunAttachment(handle)?.humanInputWaits?.clear();
  if (!handle.runId || ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(handle.runId)?.handle !== handle) {
    return;
  }
  ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.delete(handle.runId);
}

/** Interrupt aborts the exact turn and keeps its waiting inputs and children. */
function interruptSessionTurn(operation: ReplyOperation, reason?: "restart"): boolean {
  return stopSession({
    source: "interrupt",
    capture: captureSessionControllerStop({ operations: [operation] }),
    // A direct run abort keeps its typed reason, so callers record it as a direct abort.
    reason:
      reason === "restart" ? createAgentRunRestartAbortError() : createAgentRunDirectAbortError(),
    // The controller result distinguishes a committed abort from an observer failure.
    onError: () => "continue",
  }).aborted;
}

function completionTargetsMatch(a: SessionTarget, b: SessionTarget): boolean {
  return (
    sessionTargetOwnersMatch(a, b) &&
    (a.sessionKey === b.sessionKey ||
      a.aliases.includes(b.sessionKey) ||
      b.aliases.includes(a.sessionKey))
  );
}

function completionClaimTarget(claim: EmbeddedRunCompletionClaim): SessionTarget | undefined {
  return claim.operation
    ? getSessionControllerEntryForOperation(claim.operation).target
    : claim.target;
}

function revokeCompletionClaim(sessionId: string, runId?: string, target?: SessionTarget): void {
  for (const claim of EMBEDDED_RUN_COMPLETION_CLAIMS) {
    const owner = completionClaimTarget(claim);
    const matchesOwner = target
      ? owner && completionTargetsMatch(owner, target)
      : !claim.target && claim.sessionId === sessionId;
    if (matchesOwner && (runId === undefined || claim.runId === runId)) {
      claim.settleRegistration(undefined);
      EMBEDDED_RUN_COMPLETION_CLAIMS.delete(claim);
    }
  }
}

/** Cancellation uses physical custody, even when an idle alias hides its ID projection. */
function isCurrentDetachedCancellationTarget(registration: ActiveEmbeddedRunAttachment): boolean {
  return (
    !registration.operation &&
    resolveReplyRunForCurrentSessionId(registration.sessionId).kind === "none" &&
    getDetachedNativeAttachment(registration.sessionId) === registration
  );
}

function abortCapturedDetachedNativeAttempt(
  registration: ActiveEmbeddedRunAttachment,
  isCurrent: () => boolean,
  reason?: "restart",
): boolean {
  const { sessionId, handle } = registration;
  if (
    registration.operation ||
    !isEmbeddedRunHandleAbortable(sessionId, handle, "all") ||
    !isCurrent()
  ) {
    return false;
  }
  try {
    handle.abort(reason);
  } catch (err) {
    diag.warn(`abort failed: sessionId=${sessionId} err=${String(err)}`);
    return false;
  }
  revokeCompletionClaim(sessionId, handle.runId);
  return true;
}

/**
 * Abort embedded OpenClaw runs.
 *
 * - With a sessionId, aborts that single run.
 * - With no sessionId, supports targeted abort modes (for example, compacting runs only).
 */
export function abortEmbeddedAgentRun(sessionId: string, opts?: { reason?: "restart" }): boolean;
export function abortEmbeddedAgentRun(
  sessionId: undefined,
  opts: { mode: "all" | "compacting"; reason?: "restart" },
): boolean;
export function abortEmbeddedAgentRun(
  sessionId?: string,
  opts?: { mode?: "all" | "compacting"; reason?: "restart" },
): boolean {
  if (typeof sessionId === "string" && sessionId.length > 0) {
    const operation = resolveActiveReplyOperationForSessionId(sessionId);
    if (operation) {
      return interruptSessionTurn(operation, opts?.reason);
    }
    const registration = getDetachedNativeAttachment(sessionId);
    if (!registration) {
      return false;
    }
    // Detached runtimes have no session turn; their exact handle owns cancellation.
    return abortCapturedDetachedNativeAttempt(
      registration,
      () => isCurrentDetachedCancellationTarget(registration),
      opts?.reason,
    );
  }

  const mode = opts?.mode;
  if (mode !== "all" && mode !== "compacting") {
    return false;
  }
  const detachedTargets = [...nativeAttemptAttachments()].filter(
    isCurrentDetachedCancellationTarget,
  );
  const replyAborted = abortActiveReplyRuns({
    mode,
    onAbortError: (id, err) =>
      diag.warn(`abort failed: sessionId=${id} owner=reply_run err=${String(err)}`),
  });
  let aborted = false;
  for (const registration of detachedTargets) {
    const { sessionId: id, handle } = registration;
    if (
      !isCurrentDetachedCancellationTarget(registration) ||
      !isEmbeddedRunHandleAbortable(id, handle, mode) ||
      !isCurrentDetachedCancellationTarget(registration)
    ) {
      continue;
    }
    diag.debug(`aborting ${mode === "compacting" ? "compacting " : ""}run: sessionId=${id}`);
    try {
      handle.abort(opts?.reason);
      revokeCompletionClaim(id, handle.runId);
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
  const handle = getActiveNativeAttempt(sessionId);
  if (!handle?.preemptByVisibleTurn) {
    return "not-heartbeat";
  }
  const drainPromise = waitForSessionNativeAttemptEnd(sessionId, timeoutMs, handle);
  try {
    if (!handle.preemptByVisibleTurn()) {
      return "not-heartbeat";
    }
  } catch (err) {
    diag.warn(`heartbeat preemption failed: sessionId=${sessionId} err=${String(err)}`);
  } finally {
    notifyGatewayWorkMetricsChanged();
  }
  return (await drainPromise) ? "drained" : "timed-out";
}

export function prepareEmbeddedAgentRunCompletionClaim(
  sessionId: string,
  runId: string,
  target?: SessionTarget,
): {
  bindOperationalRunInstance: (
    instance: NonNullable<EmbeddedRunRegistration["operationalRunInstance"]>,
  ) => boolean;
  claimCompletion: () => boolean;
  claimFailure: () => boolean;
  resolveCurrentRegistration: () => EmbeddedRunCompletionRegistration | undefined;
  registered: Promise<EmbeddedRunCompletionRegistration | undefined>;
} {
  const { promise: registered, resolve: settleRegistration } = createDeferredCore<
    EmbeddedRunCompletionRegistration | undefined
  >();
  const claim: EmbeddedRunCompletionClaim = {
    sessionId,
    target,
    runId,
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
    promoted: false,
    settleRegistration,
  };
  revokeCompletionClaim(sessionId, undefined, target);
  EMBEDDED_RUN_COMPLETION_CLAIMS.add(claim);
  const consume = (allowUnregistered: boolean): boolean => {
    if (!EMBEDDED_RUN_COMPLETION_CLAIMS.has(claim)) {
      return false;
    }
    EMBEDDED_RUN_COMPLETION_CLAIMS.delete(claim);
    if (!claim.promoted) {
      claim.settleRegistration(undefined);
    }
    return (
      (allowUnregistered || claim.promoted) &&
      !claim.operation?.abortSignal.aborted &&
      isAgentEventLifecycleGenerationCurrent(claim.lifecycleGeneration)
    );
  };
  const bindOperationalRunInstance = (
    instance: NonNullable<EmbeddedRunRegistration["operationalRunInstance"]>,
  ): boolean => {
    if (
      !EMBEDDED_RUN_COMPLETION_CLAIMS.has(claim) ||
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
      !EMBEDDED_RUN_COMPLETION_CLAIMS.has(claim) ||
      !isAgentEventLifecycleGenerationCurrent(claim.lifecycleGeneration)
    ) {
      return undefined;
    }
    const registration = claim.attachment;
    const handle = registration?.handle;
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
    return EMBEDDED_RUN_COMPLETION_CLAIMS.has(claim) &&
      registration &&
      isCurrentEmbeddedRunAttachment(registration) &&
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

export function isEmbeddedAgentRunHandleActive(sessionId: string): boolean {
  return Boolean(getActiveNativeAttempt(sessionId));
}

/** @internal Exposed for unit tests only. */
export function resolveActiveEmbeddedRunHandleSessionId(sessionKey: string): string | undefined {
  const normalizedSessionKey = sessionKey.trim();
  if (!normalizedSessionKey) {
    return undefined;
  }
  // Logical aliases outlive turns; native lookup follows the exact registration key.
  const operation = getSessionControllerOperation(normalizedSessionKey);
  const registration = operation && getControllerEmbeddedAttachment(operation);
  return registration?.sessionKey?.trim() === normalizedSessionKey
    ? registration.sessionId
    : undefined;
}

export type ActiveEmbeddedRunOwner = {
  runId: string;
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  startedAtMs?: number;
  abort: () => boolean;
  /** Stops this captured owner and distinguishes a frozen writer from a stale target. */
  stop: () => "aborted" | "finalizing" | "unchanged";
  /** Joins this captured native attempt and its producer, never a same-ID successor. */
  waitForSettlement: () => Promise<void>;
};

function projectActiveEmbeddedRunOwner(
  registration: ActiveEmbeddedRunAttachment,
  handle: EmbeddedAgentQueueHandle,
): ActiveEmbeddedRunOwner | undefined {
  const runId = handle.runId;
  if (!runId || !isEmbeddedRunHandleInProgress(handle)) {
    return undefined;
  }
  const stop = (): "aborted" | "finalizing" | "unchanged" => {
    if (
      (registration.operation
        ? getControllerEmbeddedAttachment(registration.operation) !== registration
        : getActiveNativeAttempt(registration.sessionId) !== handle) ||
      getEmbeddedRunAttachment(handle) !== registration ||
      ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(runId)?.handle !== handle
    ) {
      return "unchanged";
    }
    if (registration.operation?.abortFrozen || !isEmbeddedRunHandleAbortable(runId, handle)) {
      return "finalizing";
    }
    try {
      if (registration.operation) {
        if (!registration.operation.abortByUser()) {
          return "unchanged";
        }
      } else if (handle.cancel) {
        handle.cancel("user_abort");
      } else {
        handle.abort();
      }
      revokeCompletionClaim(
        registration.sessionId,
        runId,
        registration.operation
          ? getSessionControllerEntryForOperation(registration.operation).target
          : undefined,
      );
      return "aborted";
    } catch {
      // A throwing backend cannot undo cancellation already committed by its owner.
      return registration.operation?.result?.kind === "aborted" ? "aborted" : "unchanged";
    }
  };
  return {
    runId,
    sessionId: registration.sessionId,
    ...(registration.sessionKey ? { sessionKey: registration.sessionKey } : {}),
    ...(registration.agentId ? { agentId: registration.agentId } : {}),
    ...(handle.startedAtMs === undefined ? {} : { startedAtMs: handle.startedAtMs }),
    waitForSettlement: () => waitForEmbeddedRunOwnerSettlement(registration),
    // A recovered run ID is correlation only. Recheck the captured owner before
    // Stop so a stale UI action cannot abort replacement work in the session.
    stop,
    abort: () => stop() === "aborted",
  };
}

export function resolveActiveEmbeddedRunOwner(
  sessionId: string,
): ActiveEmbeddedRunOwner | undefined {
  const handle = getActiveNativeAttempt(sessionId);
  const registration = handle ? getEmbeddedRunAttachment(handle) : undefined;
  return handle && registration ? projectActiveEmbeddedRunOwner(registration, handle) : undefined;
}

export function resolveActiveEmbeddedRunOwnerForOperation(
  operation: ReplyOperation,
): ActiveEmbeddedRunOwner | undefined {
  const attachment = getControllerEmbeddedAttachment(operation);
  return attachment ? projectActiveEmbeddedRunOwner(attachment, attachment.handle) : undefined;
}

export function resolveActiveEmbeddedRunOwnerByRunId(
  runId: string,
): ActiveEmbeddedRunOwner | undefined {
  const normalizedRunId = runId.trim();
  const handle = normalizedRunId
    ? ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(normalizedRunId)?.handle
    : undefined;
  if (!handle) {
    return undefined;
  }
  const registration = getEmbeddedRunAttachment(handle);
  const current = registration?.operation
    ? getControllerEmbeddedAttachment(registration.operation) === registration
    : registration && getActiveNativeAttempt(registration.sessionId) === handle;
  return registration && current ? projectActiveEmbeddedRunOwner(registration, handle) : undefined;
}

export type EmbeddedRunDrainTarget = NonNullable<ReturnType<typeof captureEmbeddedRunDrainTarget>>;

/** Lifecycle drains join the captured producer even after its registration is retired. */
export function captureEmbeddedRunDrainTarget(
  target: string | ActiveEmbeddedRunAttachment,
  owner: { agentId?: string; defaultAgentId?: string },
) {
  const handle = typeof target === "string" ? getActiveNativeAttempt(target) : target.handle;
  const registration =
    typeof target === "string" ? handle && getEmbeddedRunAttachment(handle) : target;
  const expectedAgentId = owner.agentId ?? owner.defaultAgentId;
  const recordedAgentId =
    registration?.agentId ??
    parseAgentSessionKey(registration?.sessionKey)?.agentId ??
    owner.defaultAgentId;
  if (
    !handle ||
    !registration ||
    !expectedAgentId ||
    !recordedAgentId ||
    normalizeAgentId(expectedAgentId) !== normalizeAgentId(recordedAgentId)
  ) {
    return undefined;
  }
  const sessionId = registration.sessionId;
  let released = false;
  const ended = waitForEmbeddedRunOwnerSettlement(registration).then(() => true);
  const isActive = () => !released && !registration.settled;
  return {
    sessionId,
    agentId: registration.agentId,
    sessionKey: registration.sessionKey,
    isActive,
    isAborted: () => !isEmbeddedRunHandleInProgress(handle),
    abort: () => {
      if (
        !isActive() ||
        (registration.operation && getEmbeddedRunAttachment(handle) !== registration)
      ) {
        return false;
      }
      return registration.operation
        ? interruptSessionTurn(registration.operation)
        : abortCapturedDetachedNativeAttempt(
            registration,
            () => getDetachedNativeAttachment(sessionId) === registration,
          );
    },
    waitForEnd: async (timeoutMs: number | null) =>
      timeoutMs === null
        ? await ended
        : await settlesWithin(ended, resolveTimerTimeoutMs(timeoutMs, 100, 100)),
    release: () => {
      released = true;
    },
  };
}

export function isActiveEmbeddedRunId(runId: string): boolean {
  const normalizedRunId = runId.trim();
  const handle = normalizedRunId
    ? ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(normalizedRunId)?.handle
    : undefined;
  const registration = handle ? getEmbeddedRunAttachment(handle) : undefined;
  return Boolean(
    handle &&
    registration &&
    isCurrentEmbeddedRunAttachment(registration) &&
    isEmbeddedRunHandleInProgress(handle),
  );
}

/** Exact transcript ownership is independent of ambiguous session-ID projections. */
export function resolveActiveEmbeddedRunBySessionFile(
  sessionFile: string,
): ActiveEmbeddedRunAttachment | undefined {
  const normalizedSessionFile = normalizeSessionFileRegistryKey(sessionFile);
  return normalizedSessionFile
    ? ACTIVE_EMBEDDED_RUNS_BY_FILE.get(normalizedSessionFile)
    : undefined;
}

export function resolveActiveEmbeddedRunSessionIdBySessionFile(
  sessionFile: string,
): string | undefined {
  return resolveActiveEmbeddedRunBySessionFile(sessionFile)?.sessionId;
}

function clearActiveEmbeddedRunFiles(attachment: ActiveEmbeddedRunAttachment): void {
  for (const [key, owner] of ACTIVE_EMBEDDED_RUNS_BY_FILE) {
    if (owner === attachment) {
      ACTIVE_EMBEDDED_RUNS_BY_FILE.delete(key);
    }
  }
}

export function getActiveEmbeddedRunSnapshot(
  sessionFile: string,
): ActiveEmbeddedRunSnapshot | undefined {
  const attachment = resolveActiveEmbeddedRunBySessionFile(sessionFile);
  return attachment && isCurrentEmbeddedRunAttachment(attachment)
    ? ACTIVE_EMBEDDED_RUN_SNAPSHOTS.get(attachment)
    : undefined;
}

export type AbortAndDrainEmbeddedAgentRunResult = {
  aborted: boolean;
  drained: boolean;
  forceCleared: boolean;
  recoveringModelAttempt?: true;
};

type AbortAndDrainEmbeddedAgentRunParams = {
  sessionId: string;
  sessionKey?: string;
  settleMs?: number;
  forceClear?: boolean;
  reason?: string;
};

export async function abortAndDrainEmbeddedAgentRun(
  params: AbortAndDrainEmbeddedAgentRunParams,
): Promise<AbortAndDrainEmbeddedAgentRunResult> {
  // Capture both owners before cancellation can reenter and install a successor.
  const operation = resolveActiveReplyOperationForSessionId(params.sessionId);
  const registration = operation
    ? getControllerEmbeddedAttachment(operation)
    : getDetachedNativeAttachment(params.sessionId);
  return await abortAndDrainCapturedEmbeddedAgentRun(params, operation, registration);
}

/** A known invocation selects its registered owner even when session IDs overlap. */
export async function abortAndDrainEmbeddedAgentRunByRunId(
  params: AbortAndDrainEmbeddedAgentRunParams & { runId: string },
): Promise<AbortAndDrainEmbeddedAgentRunResult | undefined> {
  const registration = ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(params.runId);
  if (!registration || registration.sessionId !== params.sessionId) {
    return undefined;
  }
  return await abortAndDrainCapturedEmbeddedAgentRun(params, registration.operation, registration);
}

async function abortAndDrainCapturedEmbeddedAgentRun(
  params: AbortAndDrainEmbeddedAgentRunParams,
  operation: ReplyOperation | undefined,
  registration: ActiveEmbeddedRunAttachment | undefined,
): Promise<AbortAndDrainEmbeddedAgentRunResult> {
  const settleMs = params.settleMs ?? 15_000;
  const settleDeadline = Date.now() + resolveTimerTimeoutMs(settleMs, 100, 100);
  const handle = registration?.handle;
  let aborted = false;
  if (params.reason === "stuck_recovery" && operation) {
    const wasAborted = operation.abortSignal.aborted;
    const decision = await operation.watchdog.tick();
    if (decision.action === "observe" && decision.reason === "model_recovery") {
      return { aborted: true, drained: false, forceCleared: false, recoveringModelAttempt: true };
    }
    // A committed Stop may tick as cleanup-blocked; report it as accepted, not settled.
    aborted =
      (!wasAborted && operation.abortSignal.aborted) ||
      decision.action === "stop" ||
      decision.action === "expire_cleanup";
  } else if (operation) {
    aborted = interruptSessionTurn(operation);
  } else if (
    registration &&
    handle &&
    isEmbeddedRunHandleAbortable(params.sessionId, handle) &&
    isCurrentDetachedCancellationTarget(registration)
  ) {
    try {
      const recoveringModelAttempt =
        params.reason === "stuck_recovery" && handle.recoverStalledModelCall?.() === true;
      if (isCurrentDetachedCancellationTarget(registration)) {
        if (recoveringModelAttempt) {
          return {
            aborted: true,
            drained: false,
            forceCleared: false,
            recoveringModelAttempt: true,
          };
        }
        handle.abort();
        aborted = true;
      }
    } catch (err) {
      diag.warn(`abort failed: sessionId=${params.sessionId} err=${String(err)}`);
    }
  }
  const remainingMs = Math.max(0, settleDeadline - Date.now());
  const nativeSettlement = waitForCapturedSessionNativeAttemptEnd(
    params.sessionId,
    remainingMs,
    registration,
  );
  const ownerSettlement = operation
    ? waitForReplyOperationOwnerSettlement(operation, remainingMs)
    : Promise.resolve(true);
  // Detached cleanup cannot prove writer revocation or raw backend completion.
  if (params.forceClear && handle && !operation) {
    const cleanup = EMBEDDED_RUN_FORCED_TERMINAL_SETTLEMENTS.get(handle);
    if (cleanup && getEmbeddedRunAttachment(handle) === registration) {
      await cleanup();
    }
  }
  const [nativeSettled, ownerSettled] = await Promise.all([nativeSettlement, ownerSettlement]);
  const drained = nativeSettled && ownerSettled;
  const forceCleared =
    params.forceClear && !drained && operation
      ? await readSessionControllerOperationState(operation)?.forceCleanup(
          () =>
            !registration ||
            (getControllerEmbeddedAttachment(operation) === registration &&
              getEmbeddedRunAttachment(registration.handle) === registration),
          handle ? EMBEDDED_RUN_FORCED_TERMINAL_SETTLEMENTS.get(handle) : undefined,
        )
      : false;
  // Fenced admission may retire while the exact native attachment still owns raw cleanup.
  return { aborted, drained, forceCleared: forceCleared === true };
}

function hasNativeBackendControl(
  handle: EmbeddedAgentQueueHandle,
): handle is EmbeddedAgentQueueHandle & ReplyBackendHandle {
  return handle.kind === "embedded" && typeof handle.cancel === "function";
}

export function attachActiveEmbeddedRun(
  sessionId: string,
  handle: EmbeddedAgentQueueHandle,
  sessionKey?: string,
  sessionFile?: string,
  agentId?: string,
  admittedOperation?: ReplyOperation,
  lifecycleGeneration = getAgentEventLifecycleGeneration(),
) {
  const sessionIdentity = { sessionId, sessionKey, sessionFile };
  let completionTarget = admittedOperation
    ? getSessionControllerEntryForOperation(admittedOperation).target
    : undefined;
  const incomingLifecycleGeneration =
    handle[embeddedRunCleanupAttachment]?.lifecycleGeneration ?? lifecycleGeneration;
  // The immutable handle generation rejects delayed stale registration even
  // when rotation left no replacement owner in the session slot.
  if (!isAgentEventLifecycleGenerationCurrent(incomingLifecycleGeneration)) {
    revokeCompletionClaim(sessionId, handle.runId, completionTarget);
    try {
      handle.abort("restart");
    } catch (error) {
      diag.warn(`stale run registration abort failed: sessionId=${sessionId} err=${String(error)}`);
      throw error;
    }
    return undefined;
  }
  if (handle.diagnosticOwner && isDiagnosticEmbeddedRunOwnerClosed(handle.diagnosticOwner)) {
    revokeCompletionClaim(sessionId, handle.runId, completionTarget);
    handle.abort("restart");
    return undefined;
  }
  const caller = getGatewayToolCallerIdentity();
  let toolAuthority: EmbeddedRunRegistration["toolAuthority"];
  try {
    toolAuthority = caller?.embeddedRunToolAuthorityBinding?.({
      ...sessionIdentity,
      agentId,
      handle,
    });
  } catch (error) {
    revokeCompletionClaim(sessionId, handle.runId, completionTarget);
    throw error;
  }
  const operation = toolAuthority?.operation ?? admittedOperation;
  completionTarget = operation
    ? getSessionControllerEntryForOperation(operation).target
    : undefined;
  if (
    admittedOperation &&
    toolAuthority?.operation &&
    admittedOperation !== toolAuthority.operation
  ) {
    throw new Error("Native registration received conflicting session turn owners");
  }
  if (operation) {
    assertSessionControllerOperation(operation);
    if (
      (sessionKey !== undefined && operation.key !== sessionKey) ||
      operation.sessionId !== sessionId ||
      (operation.agentId && agentId && operation.agentId !== normalizeAgentId(agentId))
    ) {
      throw new Error("Native registration does not match the exact admitted session turn");
    }
  } else if (sessionKey && toolAuthority?.detached === true) {
    // A prepared detached attempt can carry a policy key without owning that session.
    toolAuthority.assertActive();
  } else if (sessionKey) {
    throw new SessionControllerAdmissionRequiredError();
  }
  const previousAttachment = operation
    ? getControllerEmbeddedAttachment(operation)
    : getDetachedNativeAttachment(sessionId);
  const wasActive = previousAttachment !== undefined;
  if (previousAttachment) {
    const previousHandle = previousAttachment.handle;
    previousAttachment.watchdogAttempt?.close();
    previousAttachment.closeWatchdogWait?.();
    previousHandle.closeDiagnostics?.();
    clearEmbeddedRunAbortability(previousHandle);
    detachNativeAttempt(previousAttachment);
    clearActiveEmbeddedRunFiles(previousAttachment);
    ACTIVE_EMBEDDED_RUN_SNAPSHOTS.delete(previousAttachment);
    EMBEDDED_RUN_FORCED_TERMINAL_SETTLEMENTS.delete(previousHandle);
  }
  try {
    toolAuthority?.assertRegistrationActive();
  } catch (error) {
    revokeCompletionClaim(sessionId, handle.runId, completionTarget);
    throw error;
  }
  clearEmbeddedRunAbandonment(
    operation ? getSessionControllerEntryForOperation(operation) : sessionId,
    { sessionId, sessionKey, sessionFile },
  );
  if (operation && getAttachedBackend(operation) !== handle) {
    if (hasNativeBackendControl(handle)) {
      operation.attachBackend(handle);
    } else {
      operation.attachBackend({
        ...handle,
        kind: "embedded",
        cancel: (reason) =>
          handle.cancel
            ? handle.cancel(reason)
            : handle.abort(reason === "restart" ? reason : undefined),
      });
    }
  }
  // The dispatch scope carries the admitted instance across both core and
  // plugin attempts. A handle's public runId alone cannot confer wait authority.
  const operationalRunInstance = caller?.operationalRunInstance;
  const runContext = handle.runId ? getAgentRunContext(handle.runId) : undefined;
  const watchdogAttempt = handle.diagnosticOwner?.watchdogAttempt ?? toolAuthority?.watchdogAttempt;
  const registration: EmbeddedRunRegistration = {
    handle,
    lifecycleGeneration: incomingLifecycleGeneration,
    settlement: createDeferredCore(),
    watchdogAttempt,
    projectSessionActive:
      (operation
        ? getSessionControllerEntryForOperation(operation).attachment?.projectSessionActive
        : undefined) ??
      (runContext?.lifecycleGeneration === incomingLifecycleGeneration
        ? runContext.projectSessionActive
        : undefined),
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
      if (operation && getActiveNativeAttempt(sessionId) === handle) {
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
  };
  let attachment: ActiveEmbeddedRunAttachment = registration;
  if (operation) {
    const controllerAttachment = getSessionControllerEntryForOperation(operation).attachment;
    if (!controllerAttachment || controllerAttachment.operation !== operation) {
      throw new Error("Native registration requires its controller backend attachment");
    }
    attachment = Object.assign(controllerAttachment, registration, { operation });
  }
  attachNativeAttempt(attachment);
  handle[embeddedRunCleanupAttachment] = attachment;
  if (watchdogAttempt && handle.ownsLiveness) {
    const wait = watchdogAttempt.beginWait({
      kind: "runtime_owned",
      isCurrent: () => {
        if (
          getEmbeddedRunAttachment(handle) !== attachment ||
          (operation && getSessionControllerEntryForOperation(operation).attachment !== attachment)
        ) {
          return false;
        }
        toolAuthority?.assertActive();
        return handle.ownsLiveness?.() === true && !handle.isAborted?.() && !handle.isStopped?.();
      },
    });
    attachment.closeWatchdogWait = () => wait.close();
  }
  if (operation) {
    if (toolAuthority?.sourceTurnId) {
      // Native attempts may carry an execution ID; durable admission owns the logical source.
      getSessionControllerEntryForOperation(operation).sourceTurnId ??= toolAuthority.sourceTurnId;
    }
    markReplyOperationExecutionStarted(operation);
    if (operation.phase === "queued") {
      operation.setPhase("running");
    }
  }
  const forcedTerminalSettlement = resolveSessionPlacementForcedTerminalSettlement();
  if (forcedTerminalSettlement) {
    EMBEDDED_RUN_FORCED_TERMINAL_SETTLEMENTS.set(handle, forcedTerminalSettlement);
  }
  if (handle.runId) {
    ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.set(handle.runId, attachment);
  }
  const normalizedSessionFile = normalizeSessionFileRegistryKey(sessionFile);
  if (normalizedSessionFile) {
    ACTIVE_EMBEDDED_RUNS_BY_FILE.set(normalizedSessionFile, attachment);
  }
  notifyGatewayWorkMetricsChanged();
  logSessionStateChange({
    ...sessionIdentity,
    state: "processing",
    reason: wasActive ? "run_replaced" : "run_started",
  });
  markDiagnosticEmbeddedRunStarted({
    sessionId,
    sessionKey,
    runId: handle.runId,
    owner: handle.diagnosticOwner,
  });
  for (const completionClaim of EMBEDDED_RUN_COMPLETION_CLAIMS) {
    const owner = completionClaimTarget(completionClaim);
    // Pending two-argument claims have no physical owner until admission.
    // Promoted claims follow their operation, including compaction successors.
    const matchesOwner = owner
      ? completionTarget && completionTargetsMatch(owner, completionTarget)
      : completionClaim.sessionId === sessionId;
    if (!matchesOwner) {
      continue;
    }
    const matchesSession =
      completionClaim.sessionId === sessionId ||
      (operation === completionClaim.operation &&
        operation?.hasOwnedSessionId(completionClaim.sessionId) &&
        operation.hasOwnedSessionId(sessionId));
    if (
      matchesSession &&
      completionClaim.runId === handle.runId &&
      completionClaim.lifecycleGeneration === incomingLifecycleGeneration &&
      (completionClaim.operation === undefined || completionClaim.operation === operation) &&
      (completionClaim.operationalRunInstance === undefined ||
        completionClaim.operationalRunInstance === operationalRunInstance)
    ) {
      completionClaim.operation = operation;
      completionClaim.attachment = attachment;
      completionClaim.promoted = true;
      completionClaim.settleRegistration(toolAuthority ? { toolAuthority } : undefined);
    } else {
      completionClaim.settleRegistration(undefined);
      EMBEDDED_RUN_COMPLETION_CLAIMS.delete(completionClaim);
    }
  }
  return attachment;
}

export function updateActiveEmbeddedRunSnapshot(
  attachment: ActiveEmbeddedRunAttachment | undefined,
  snapshot: ActiveEmbeddedRunSnapshot,
) {
  if (!attachment || !isCurrentEmbeddedRunAttachment(attachment)) {
    return;
  }
  ACTIVE_EMBEDDED_RUN_SNAPSHOTS.set(attachment, snapshot);
}

export function detachActiveEmbeddedRun(
  sessionId: string,
  handle: EmbeddedAgentQueueHandle,
  sessionKey?: string,
  sessionFile?: string,
  reason = "run_completed",
  expectedAttachment?: ActiveEmbeddedRunAttachment,
) {
  const activeHandle = getActiveNativeAttempt(sessionId);
  const registration =
    expectedAttachment ?? handle[embeddedRunCleanupAttachment] ?? getEmbeddedRunAttachment(handle);
  if (!registration || registration.settled) {
    return;
  }
  const controllerOwner = resolveReplyRunForCurrentSessionId(sessionId);
  const ownsSessionProjection =
    (activeHandle === handle &&
      (registration.operation === undefined ||
        (controllerOwner.kind === "one" &&
          controllerOwner.operation === registration.operation))) ||
    (!activeHandle && registration.operation !== undefined && controllerOwner.kind === "none");
  registration.closeWatchdogWait?.();
  registration.watchdogAttempt?.close();
  const operation = registration.operation;
  const backend = registration.backend;
  clearEmbeddedRunAbortability(handle);
  detachNativeAttempt(registration);
  clearActiveEmbeddedRunFiles(registration);
  ACTIVE_EMBEDDED_RUN_SNAPSHOTS.delete(registration);
  notifyGatewayWorkMetricsChanged();
  if (operation && backend) {
    operation.detachBackend(backend.handle);
  }
  // Generation-fenced: closing cannot retire a successor's diagnostic owner.
  handle.closeDiagnostics?.();
  if (ownsSessionProjection) {
    if (!handle.diagnosticOwner) {
      markDiagnosticEmbeddedRunEnded({ sessionId, sessionKey });
    }
    logSessionStateChange({
      sessionId,
      sessionKey,
      sessionFile,
      state: "idle",
      reason,
    });
  }
  EMBEDDED_RUN_FORCED_TERMINAL_SETTLEMENTS.delete(handle);
  // Exact attachment waiters own teardown even after another run takes the session slot.
  registration.settled = true;
  registration.settlement.resolve();
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  Object.assign(globalThis, {
    [Symbol.for("openclaw.embeddedRunsTestApi")]:
      createEmbeddedRunsTestApi(detachActiveEmbeddedRun),
  });
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
