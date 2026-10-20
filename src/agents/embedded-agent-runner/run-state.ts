import type { AgentRuntimeIdentity } from "../../gateway/agent-runtime-identity-token.js";
import {
  isAgentEventLifecycleGenerationCurrent,
  registerAgentEventLifecycleRotationHandler,
} from "../../infra/agent-events.js";
import {
  getActiveAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import type {
  ReplyOperation,
  SessionControllerEntry,
  EmbeddedAgentQueueHandle,
  EmbeddedRunRegistration,
  EmbeddedRunAttachment,
  ActiveEmbeddedRunAttachment,
  DetachedEmbeddedRunAttachment,
  ActiveEmbeddedRunSnapshot,
} from "../../sessions/session-controller.contracts.js";
import {
  attachControllerNativeAttempt,
  detachControllerNativeAttempt,
  hasSessionControllerIdentity,
  resolveControllerNativeAttempt,
  activeSessionOperations,
  resolveReplyRunForCurrentSessionId,
  getSessionControllerEntryForOperation,
  getAttachedBackend,
} from "../../sessions/session-controller.state.js";
import type { SessionTarget } from "../../sessions/session-controller.target.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { OperationalRunInstanceRef } from "../admitted-run-context.js";
export {
  embeddedRunCleanupAttachment,
  type EmbeddedAgentQueueHandle,
  type EmbeddedAgentQueueMessageOptions,
  type EmbeddedAgentQueueMessageResult,
  type ActiveEmbeddedRunSnapshot,
  type EmbeddedRunToolAuthorityBinding,
  type EmbeddedRunRegistration,
  type EmbeddedRunAttachment,
  type ActiveEmbeddedRunAttachment,
} from "../../sessions/session-controller.contracts.js";

export type EmbeddedRunCompletionRegistration = {
  toolAuthority: NonNullable<EmbeddedRunRegistration["toolAuthority"]>;
};

export type EmbeddedRunCompletionClaim = {
  sessionId: string;
  target?: SessionTarget;
  attachment?: ActiveEmbeddedRunAttachment;
  runId: string;
  operation?: ReplyOperation;
  lifecycleGeneration: string;
  operationalRunInstance?: OperationalRunInstanceRef;
  promoted: boolean;
  settleRegistration: (registration: EmbeddedRunCompletionRegistration | undefined) => void;
};

export type AbandonedEmbeddedRun = {
  sessionId: string;
  runId?: string;
  sessionKey?: string;
  sessionFile?: string;
  abandonedAtMs: number;
  reason: "timeout" | "recovering_timeout";
};

const EMBEDDED_RUN_STATE_KEY = Symbol.for("openclaw.embeddedRunState");

// Lazy imports and reloads in one Gateway process must retain the same run owners.
const embeddedRunState = resolveGlobalSingleton(EMBEDDED_RUN_STATE_KEY, () => ({
  detachedAttempts: new Set<DetachedEmbeddedRunAttachment>(),
  activeRunsByRunId: new Map<string, ActiveEmbeddedRunAttachment>(),
  // Talk prepares before registration; only the matching live run promotes this
  // one-shot final-delivery claim. Replacement or lifecycle rotation revokes it.
  completionClaims: new Set<EmbeddedRunCompletionClaim>(),
  snapshots: new Map<ActiveEmbeddedRunAttachment, ActiveEmbeddedRunSnapshot>(),
  runsByFile: new Map<string, ActiveEmbeddedRunAttachment>(),
  abandonedRuns: new Map<SessionControllerEntry | string, AbandonedEmbeddedRun>(),
  // The exact handle owns forced cleanup so a stale session id cannot release a replacement turn.
  forcedTerminalSettlements: new WeakMap<EmbeddedAgentQueueHandle, () => Promise<void>>(),
}));

// Sessionless attempts only; scoped attempts live on their exact controller turn.
const detachedAttempts = embeddedRunState.detachedAttempts;

export function getControllerEmbeddedAttachment(
  operation: ReplyOperation,
): EmbeddedRunAttachment | undefined {
  const attachment = getSessionControllerEntryForOperation(operation).attachment;
  return attachment && "handle" in attachment && attachment.operation === operation
    ? attachment
    : undefined;
}

export function getEmbeddedRunAttachment(
  handle: EmbeddedAgentQueueHandle,
): ActiveEmbeddedRunAttachment | undefined {
  const indexed = handle.runId ? ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(handle.runId) : undefined;
  if (indexed?.handle === handle) {
    return indexed;
  }
  for (const operation of activeSessionOperations()) {
    const attachment = getControllerEmbeddedAttachment(operation);
    if (attachment?.handle === handle) {
      return attachment;
    }
  }
  for (const attachment of detachedAttempts) {
    if (attachment.handle === handle) {
      return attachment;
    }
  }
  return undefined;
}

export function getDetachedNativeAttachment(
  sessionId: string,
): DetachedEmbeddedRunAttachment | undefined {
  for (const attachment of detachedAttempts) {
    if (attachment.sessionId === sessionId) {
      return attachment;
    }
  }
  return undefined;
}

export function getActiveNativeAttempt(sessionId: string): EmbeddedAgentQueueHandle | undefined {
  const scoped = resolveControllerNativeAttempt(sessionId);
  if (
    scoped ||
    resolveReplyRunForCurrentSessionId(sessionId).kind !== "none" ||
    hasSessionControllerIdentity(sessionId)
  ) {
    return scoped;
  }
  return getDetachedNativeAttachment(sessionId)?.handle;
}

/** Captured owners do not depend on an unambiguous session-ID projection. */
export function isCurrentEmbeddedRunAttachment(attachment: ActiveEmbeddedRunAttachment): boolean {
  return (
    getEmbeddedRunAttachment(attachment.handle) === attachment &&
    (attachment.operation
      ? getControllerEmbeddedAttachment(attachment.operation) === attachment
      : getActiveNativeAttempt(attachment.sessionId) === attachment.handle)
  );
}

export function* nativeAttemptAttachments(): IterableIterator<ActiveEmbeddedRunAttachment> {
  for (const operation of activeSessionOperations()) {
    const attachment = getControllerEmbeddedAttachment(operation);
    if (attachment) {
      yield attachment;
    }
  }
  yield* detachedAttempts;
}

/** @internal Exposed for unit tests only. */
export function* activeNativeAttempts(): IterableIterator<[string, EmbeddedAgentQueueHandle]> {
  for (const attachment of nativeAttemptAttachments()) {
    if (attachment.operation || !hasSessionControllerIdentity(attachment.sessionId)) {
      yield [attachment.sessionId, attachment.handle];
    }
  }
}
export function attachNativeAttempt(attachment: ActiveEmbeddedRunAttachment): void {
  if (attachment.operation) {
    attachControllerNativeAttempt(attachment.operation, attachment);
  } else {
    detachedAttempts.add(attachment);
  }
}
export function detachNativeAttempt(attachment: ActiveEmbeddedRunAttachment): void {
  if (attachment.operation) {
    detachControllerNativeAttempt(attachment.operation, attachment);
  } else {
    detachedAttempts.delete(attachment);
  }
}

/** Joins the exact native attachment, generation cleanup, and controller owner. */
export async function waitForEmbeddedRunOwnerSettlement(
  attachment: ActiveEmbeddedRunAttachment,
): Promise<void> {
  await Promise.all([
    attachment.settlement.promise,
    attachment.runCleanupSettlement,
    attachment.operation?.ownerSettlement,
  ]);
}

export const ACTIVE_EMBEDDED_RUNS_BY_RUN_ID = embeddedRunState.activeRunsByRunId;
export const EMBEDDED_RUN_COMPLETION_CLAIMS = embeddedRunState.completionClaims;

/** Identity-only dispatch must resolve the same participant owner as in-process tools. */
export function captureActiveEmbeddedRunPersonalToolParticipants(
  identity: AgentRuntimeIdentity,
  options?: { allowMissingRegistry?: boolean },
) {
  const instance = identity.operationalRunInstance;
  const registration = ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(instance.runId);
  if (!registration) {
    return undefined;
  }
  const handle = registration.handle;
  const toolAuthority = registration.toolAuthority;
  // Session fencing only applies to runs that admitted personal-tool participants.
  if (options?.allowMissingRegistry && !toolAuthority?.personalToolParticipants) {
    return undefined;
  }
  const delegatedAuthority = registration.delegatedAuthority;
  // Message identities use the policy session; their source owns the executing run.
  const executionSessionKey =
    identity.messageActionContext?.sourceReplySessionKey ?? identity.sessionKey;
  const ownsRegistration = () =>
    registration.operationalRunInstance?.instanceId === instance.instanceId &&
    registration.operationalRunInstance.runId === instance.runId &&
    registration.sessionKey === executionSessionKey &&
    registration.agentId === identity.agentId &&
    handle.runId === instance.runId &&
    ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(instance.runId) === registration &&
    isCurrentEmbeddedRunAttachment(registration) &&
    registration.delegatedAuthority === delegatedAuthority &&
    registration.toolAuthority === toolAuthority;
  const assertCurrent = () => {
    toolAuthority?.assertActive();
    if (
      !ownsRegistration() ||
      !toolAuthority ||
      !delegatedAuthority ||
      getActiveAgentRunDelegatedAuthority(instance) !== delegatedAuthority ||
      !validateAgentRunDelegatedAuthority(identity.delegatedAuthority, delegatedAuthority) ||
      handle.isAborted?.() ||
      handle.isStopped?.() ||
      !ownsRegistration()
    ) {
      throw new Error("Personal-tool turn authority is no longer active; ask again in a new turn.");
    }
  };
  assertCurrent();
  return { participants: toolAuthority?.personalToolParticipants, assertCurrent };
}

/** Only an accepted question's exact admitted owner may suppress stale-work recovery. */
export function registerActiveEmbeddedRunHumanInputWait(
  authority: AgentRunDelegatedAuthority,
  isPending: () => boolean,
): ((resolved: boolean) => void) | undefined {
  const registration = ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(authority.operationalRunInstance.runId);
  const handle = registration?.handle;
  const isRegistered = () =>
    registration?.operation
      ? getControllerEmbeddedAttachment(registration.operation) === registration
      : ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(authority.operationalRunInstance.runId) === registration;
  if (
    !handle ||
    !registration ||
    !isRegistered() ||
    !validateAgentRunDelegatedAuthority(authority) ||
    registration.delegatedAuthority !==
      getActiveAgentRunDelegatedAuthority(authority.operationalRunInstance)
  ) {
    return undefined;
  }
  const waits = (registration.humanInputWaits ??= new Set());
  waits.add(isPending);
  const wait = registration.watchdogAttempt?.beginWait({
    kind: "human_question",
    isCurrent: () =>
      waits.has(isPending) &&
      isPending() &&
      isRegistered() &&
      validateAgentRunDelegatedAuthority(authority) &&
      !handle.isAborted?.(),
  });
  return (resolved) => {
    wait?.close();
    if (
      waits.delete(isPending) &&
      resolved &&
      isRegistered() &&
      validateAgentRunDelegatedAuthority(authority) &&
      !handle.isAborted?.()
    ) {
      registration.watchdogAttempt?.progress("semantic", "human_input:resolved");
      registration.onHumanInputResolved?.();
    }
  };
}

/** Tool-side waits know only their run id; the live registration supplies its authority. */
export function registerActiveEmbeddedRunHumanInputWaitForRun(
  runId: string,
  isPending: () => boolean,
): ((resolved: boolean) => void) | undefined {
  const authority = ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(runId)?.delegatedAuthority;
  return authority ? registerActiveEmbeddedRunHumanInputWait(authority, isPending) : undefined;
}

type EmbeddedRunRecoveryBlocker =
  | "human_input_wait"
  | "runtime_owned_wait"
  | "stale_session_state"
  | undefined;

/** Re-read at the recovery action, including after queued/lazy recovery dispatch. */
export function resolveActiveEmbeddedRunRecoveryBlocker(
  sessionId: string,
  expectedHandle?: object,
): EmbeddedRunRecoveryBlocker {
  const handle = getActiveNativeAttempt(sessionId);
  if (expectedHandle && handle !== expectedHandle) {
    return "stale_session_state";
  }
  const registration = handle && getEmbeddedRunAttachment(handle);
  return registration
    ? resolveRegisteredEmbeddedRunRecoveryBlocker(
        registration,
        () =>
          getActiveNativeAttempt(sessionId) === registration.handle &&
          getEmbeddedRunAttachment(registration.handle) === registration,
      )
    : undefined;
}

/** The native owner decides wait protection using its exact current registration. */
export function resolveRegisteredEmbeddedRunRecoveryBlocker(
  registration: ActiveEmbeddedRunAttachment,
  isCurrent: () => boolean,
): EmbeddedRunRecoveryBlocker {
  if (!isCurrent()) {
    return "stale_session_state";
  }
  const { handle, delegatedAuthority: authority } = registration;
  if (!authority) {
    return undefined;
  }
  for (const isPending of registration.humanInputWaits ?? []) {
    // Question validation can synchronously close authority or replace the run.
    const pending = isPending() && !handle.isAborted?.();
    if (!isCurrent() || !registration.humanInputWaits?.has(isPending)) {
      return "stale_session_state";
    }
    if (pending && validateAgentRunDelegatedAuthority(authority)) {
      return "human_input_wait";
    }
  }
  let ownsLiveness = false;
  try {
    ownsLiveness =
      handle.ownsLiveness?.() === true && !handle.isAborted?.() && !handle.isStopped?.();
  } catch {
    // A failed runtime probe cannot exempt work from recovery.
  }
  // Runtime probes may synchronously replace a handle or close its admission.
  if (!isCurrent()) {
    return "stale_session_state";
  }
  return ownsLiveness &&
    ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(authority.operationalRunInstance.runId) === registration &&
    getActiveAgentRunDelegatedAuthority(authority.operationalRunInstance) === authority
    ? "runtime_owned_wait"
    : undefined;
}

export const ACTIVE_EMBEDDED_RUN_SNAPSHOTS = embeddedRunState.snapshots;
export const ACTIVE_EMBEDDED_RUNS_BY_FILE = embeddedRunState.runsByFile;

export const ABANDONED_EMBEDDED_RUNS = embeddedRunState.abandonedRuns;
export const EMBEDDED_RUN_FORCED_TERMINAL_SETTLEMENTS = embeddedRunState.forcedTerminalSettlements;

function evictPriorLifecycleEmbeddedRuns(): void {
  const staleHandles = new Set<EmbeddedAgentQueueHandle>();
  const controllerOwnedHandles = new Set<EmbeddedAgentQueueHandle>();
  for (const attachment of nativeAttemptAttachments()) {
    const { handle, lifecycleGeneration } = attachment;
    if (lifecycleGeneration && isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)) {
      continue;
    }
    handle.closeDiagnostics?.();
    attachment?.humanInputWaits?.clear();
    staleHandles.add(handle);
    if (
      attachment?.operation &&
      attachment.backend &&
      getSessionControllerEntryForOperation(attachment.operation).active === attachment.operation &&
      getAttachedBackend(attachment.operation) === attachment.backend.handle
    ) {
      controllerOwnedHandles.add(handle);
    }
    detachNativeAttempt(attachment);
    ACTIVE_EMBEDDED_RUN_SNAPSHOTS.delete(attachment);
  }
  for (const [runId, attachment] of ACTIVE_EMBEDDED_RUNS_BY_RUN_ID) {
    const { handle, lifecycleGeneration } = attachment;
    if (lifecycleGeneration && isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)) {
      continue;
    }
    handle.closeDiagnostics?.();
    staleHandles.add(handle);
    // This index only gates the separately owned chat abort controller; absence
    // is abortable. Keeping it would let stale ownership influence new work.
    if (ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(runId) === attachment) {
      ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.delete(runId);
    }
  }
  for (const claim of EMBEDDED_RUN_COMPLETION_CLAIMS) {
    if (!isAgentEventLifecycleGenerationCurrent(claim.lifecycleGeneration)) {
      claim.settleRegistration(undefined);
      EMBEDDED_RUN_COMPLETION_CLAIMS.delete(claim);
    }
  }
  for (const [key, attachment] of ACTIVE_EMBEDDED_RUNS_BY_FILE) {
    if (!isAgentEventLifecycleGenerationCurrent(attachment.lifecycleGeneration)) {
      ACTIVE_EMBEDDED_RUNS_BY_FILE.delete(key);
    }
  }
  const abortErrors: unknown[] = [];
  // Remove stale ownership first so synchronous abort callbacks may register a
  // replacement without the cleanup above erasing that current-generation run.
  for (const handle of staleHandles) {
    if (controllerOwnedHandles.has(handle)) {
      // The controller cancels its attached backend; only detached/superseded abort here.
      continue;
    }
    try {
      handle.abort("restart");
    } catch (error) {
      abortErrors.push(error);
    }
  }
  if (abortErrors.length > 0) {
    throw new AggregateError(abortErrors, "Failed to abort stale embedded agent runs");
  }
}

registerAgentEventLifecycleRotationHandler("embedded-agent-runs", evictPriorLifecycleEmbeddedRuns);
