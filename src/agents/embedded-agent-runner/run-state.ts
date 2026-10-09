import type { SessionPermissionMode } from "../../../packages/gateway-protocol/src/schema/sessions-row.js";
import type {
  SourceReplyDeliveryMode,
  TaskSuggestionDeliveryMode,
} from "../../auto-reply/get-reply-options.types.js";
import type {
  ReplyBackendQueueMessageOptions,
  ReplyToolAuthorityOverlay,
  ReplyTurnParticipants,
  ReplyBackendQueueMessageResult,
  ReplyBackendMessageInjection,
  ReplyBackendMessageInjectionV2,
} from "../../auto-reply/reply/reply-run-registry.contracts.js";
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
import type { DiagnosticEmbeddedRunOwner } from "../../logging/diagnostic-run-activity.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { OperationalRunInstanceRef } from "../admitted-run-context.js";
import type { ReplyExpectation } from "../reply-completion.js";
import {
  clearActiveRunSessionIndex,
  normalizeSessionFileRegistryKey,
} from "./runs.session-index.js";

export type EmbeddedAgentQueueHandle = {
  kind?: "embedded";
  runId?: string;
  /** Exact process-local diagnostic lifecycle shared with this handle's model wrapper. */
  readonly diagnosticOwner?: DiagnosticEmbeddedRunOwner;
  /** Synchronously closes diagnostic authority before this handle is evicted. */
  readonly closeDiagnostics?: () => void;
  /** Core run start time used by live recovery projections. */
  startedAtMs?: number;
  /** Exact authority of the concrete provider/model attempt behind this handle. */
  toolAuthorityFingerprint?: string;
  /** Shared outer-run owner survives an intentional native-turn replacement. */
  permissionChangeOwner?: object;
  /** Fences prior tools, revokes their approvals, then acknowledges installed permissions. */
  applyPermissionMode?: (
    mode: SessionPermissionMode | null,
    revokeApprovals: () => void,
  ) => Promise<boolean>;
  /** Atomically consumes one plain-text answer for this run's pending user-input request. */
  claimPendingUserInputAnswer?: (
    text: string,
    options?: EmbeddedAgentQueueMessageOptions,
  ) => Promise<boolean>;
  /** Cancels this run's pending user-input request before an image is queued as a later turn. */
  cancelPendingUserInput?: (resolvedBy: string) => Promise<boolean>;
  /** Exact heartbeat owner retained after its reply-operation registration clears. */
  readonly preemptByVisibleTurn?: () => boolean;
  queueMessage: (
    text: string,
    options?: EmbeddedAgentQueueMessageOptions,
  ) => Promise<void | EmbeddedAgentQueueMessageResult>;
  messageInjection?: ReplyBackendMessageInjection;
  messageInjectionV2?: ReplyBackendMessageInjectionV2;
  isStreaming: () => boolean;
  isStopped?: () => boolean;
  /** True after this handle has accepted an abort, even while cleanup retains it. */
  isAborted?: () => boolean;
  /** True only while this exact runtime owns a live wait, not unresolved host work or cleanup. */
  ownsLiveness?: () => boolean;
  isAbortable?: () => boolean;
  isCompacting: () => boolean;
  supportsTranscriptCommitWait?: boolean;
  /** True only when queueMessage preserves images supplied in its options. */
  supportsQueueMessageImages?: boolean;
  /** False keeps inbound steering with the turn owner's profile; omission permits other profiles. */
  readonly supportsCrossProfileSteering?: boolean;
  cancel?: (reason?: "user_abort" | "restart" | "superseded") => void;
  abort: (reason?: "restart") => void;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  terminalReplyExpectation?: ReplyExpectation;
  taskSuggestionDeliveryMode?: TaskSuggestionDeliveryMode;
};

export type EmbeddedAgentQueueMessageOutcome =
  | {
      queued: true;
      sessionId: string;
      /** Physical execution selected by queue admission, retained across the awaited receipt. */
      runId?: string;
      target: "embedded_run" | "reply_run";
      gatewayHealth: "live";
      /** Input is non-replayable, but its delivery or commitment could not be confirmed. */
      transcriptCommit?: "unconfirmed";
      errorMessage?: string;
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

export type EmbeddedAgentQueueFailureReason =
  | "input_visibility_mismatch"
  | "no_active_run"
  | "not_streaming"
  | "stale_run"
  | "compacting"
  | "tool_authority_mismatch"
  | "image_input_unsupported"
  | "source_reply_delivery_mode_mismatch"
  | "task_suggestion_delivery_mode_mismatch"
  | "reply_expectation_mismatch"
  | "transcript_commit_wait_unsupported"
  | "guarded_injection_unsupported"
  | "runtime_rejected";

export type EmbeddedAgentQueueMessageOptions = ReplyBackendQueueMessageOptions;

export type PreparedEmbeddedAgentQueueMessage =
  | {
      kind: "complete";
      outcome: EmbeddedAgentQueueMessageOutcome;
      pendingInput?: Pick<
        EmbeddedAgentQueueHandle,
        "claimPendingUserInputAnswer" | "cancelPendingUserInput"
      >;
    }
  | {
      kind: "embedded_run";
      runId?: string;
      queueMessage: EmbeddedAgentQueueHandle["queueMessage"];
      prepareQueueMessage?: () => Promise<void>;
      options: EmbeddedAgentQueueMessageOptions;
    };

export type EmbeddedAgentQueueMessageResult = ReplyBackendQueueMessageResult;

export type ActiveEmbeddedRunSnapshot = {
  transcriptLeafId: string | null;
  messages?: unknown[];
  inFlightPrompt?: string;
};

/** Host-private binding consumed before publishing one actual backend handle. */
export type EmbeddedRunToolAuthorityBinding = (registration: {
  sessionId: string;
  sessionKey?: string;
  sessionFile?: string;
  agentId?: string;
  handle: EmbeddedAgentQueueHandle;
}) => {
  source: "reply" | "attempt";
  sourceTurnId?: string;
  project: (overlay: ReplyToolAuthorityOverlay) => string | undefined;
  projectAsync: (overlay: ReplyToolAuthorityOverlay) => Promise<string | undefined>;
  assertActive: () => void;
  personalToolParticipants?: ReplyTurnParticipants;
};

export type EmbeddedRunRegistration = {
  /** Registration-owned presentation fact; retained cleanup must not reappear after context release. */
  projectSessionActive?: boolean;
  toolAuthority?: ReturnType<EmbeddedRunToolAuthorityBinding>;
  operationalRunInstance?: OperationalRunInstanceRef;
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  delegatedAuthority?: AgentRunDelegatedAuthority;
  humanInputWaits?: Set<() => boolean>;
  onHumanInputResolved?: () => void;
};

export type EmbeddedRunCompletionRegistration = {
  toolAuthority: NonNullable<EmbeddedRunRegistration["toolAuthority"]>;
};

export type EmbeddedRunCompletionClaim = {
  runId: string;
  lifecycleGeneration: string;
  operationalRunInstance?: OperationalRunInstanceRef;
  promoted: boolean;
  settleRegistration: (registration: EmbeddedRunCompletionRegistration | undefined) => void;
};

export type EmbeddedRunWaiter = {
  resolve: (ended: boolean) => void;
  handle?: EmbeddedAgentQueueHandle;
  timer?: NodeJS.Timeout;
  settleOnAbort?: boolean;
};

export type AbandonedEmbeddedRun = {
  sessionId: string;
  runId?: string;
  sessionKey?: string;
  sessionFile?: string;
  abandonedAtMs: number;
  reason: "timeout" | "recovering_timeout";
  recoveryToken?: symbol;
};

const EMBEDDED_RUN_STATE_KEY = Symbol.for("openclaw.embeddedRunState");

// Lazy imports and reloads in one Gateway process must retain the same run owners.
const embeddedRunState = resolveGlobalSingleton(EMBEDDED_RUN_STATE_KEY, () => ({
  activeRuns: new Map<string, EmbeddedAgentQueueHandle>(),
  activeRunsByRunId: new Map<string, EmbeddedAgentQueueHandle>(),
  activeRunRegistrations: new WeakMap<EmbeddedAgentQueueHandle, EmbeddedRunRegistration>(),
  // Talk prepares before registration; only the matching live run promotes this
  // one-shot final-delivery claim. Replacement or lifecycle rotation revokes it.
  completionClaims: new Map<string, EmbeddedRunCompletionClaim>(),
  activeRunLifecycleGenerations: new WeakMap<EmbeddedAgentQueueHandle, string>(),
  retainedAbortabilityRunIds: new Set<string>(),
  snapshots: new Map<string, ActiveEmbeddedRunSnapshot>(),
  sessionIdsByKey: new Map<string, string>(),
  sessionIdsByFile: new Map<string, string>(),
  abandonedRunsBySessionId: new Map<string, AbandonedEmbeddedRun>(),
  abandonedRunSessionIdsByKey: new Map<string, string>(),
  abandonedRunSessionIdsByFile: new Map<string, string>(),
  // The exact handle owns forced cleanup so a stale session id cannot release a replacement turn.
  forcedTerminalSettlements: new WeakMap<EmbeddedAgentQueueHandle, () => Promise<void>>(),
  waiters: new Map<string, Set<EmbeddedRunWaiter>>(),
}));

export const ACTIVE_EMBEDDED_RUNS = embeddedRunState.activeRuns;
export const ACTIVE_EMBEDDED_RUNS_BY_RUN_ID = embeddedRunState.activeRunsByRunId;
export const ACTIVE_EMBEDDED_RUN_REGISTRATIONS = embeddedRunState.activeRunRegistrations;
export const EMBEDDED_RUN_COMPLETION_CLAIMS = embeddedRunState.completionClaims;

/** Identity-only dispatch must resolve the same participant owner as in-process tools. */
export function captureActiveEmbeddedRunPersonalToolParticipants(
  identity: AgentRuntimeIdentity,
  options?: { allowMissingRegistry?: boolean },
) {
  const instance = identity.operationalRunInstance;
  const handle = ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(instance.runId);
  if (!handle) {
    return undefined;
  }
  const registration = ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle);
  const toolAuthority = registration?.toolAuthority;
  // Session fencing only applies to runs that admitted personal-tool participants.
  if (options?.allowMissingRegistry && !toolAuthority?.personalToolParticipants) {
    return undefined;
  }
  const delegatedAuthority = registration?.delegatedAuthority;
  const ownsRegistration = () =>
    registration !== undefined &&
    registration.operationalRunInstance?.instanceId === instance.instanceId &&
    registration.operationalRunInstance.runId === instance.runId &&
    registration.sessionKey === identity.sessionKey &&
    registration.agentId === identity.agentId &&
    handle.runId === instance.runId &&
    ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(instance.runId) === handle &&
    ACTIVE_EMBEDDED_RUNS.get(registration.sessionId) === handle &&
    ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) === registration &&
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
  const handle = ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(authority.operationalRunInstance.runId);
  const registration = handle && ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle);
  if (
    !handle ||
    !registration ||
    ACTIVE_EMBEDDED_RUNS.get(registration.sessionId) !== handle ||
    !validateAgentRunDelegatedAuthority(authority) ||
    registration.delegatedAuthority !==
      getActiveAgentRunDelegatedAuthority(authority.operationalRunInstance)
  ) {
    return undefined;
  }
  const waits = (registration.humanInputWaits ??= new Set());
  waits.add(isPending);
  return (resolved) => {
    if (
      waits.delete(isPending) &&
      resolved &&
      ACTIVE_EMBEDDED_RUNS.get(registration.sessionId) === handle &&
      validateAgentRunDelegatedAuthority(authority) &&
      !handle.isAborted?.()
    ) {
      registration.onHumanInputResolved?.();
    }
  };
}

/** Tool-side waits know only their run id; the live registration supplies its authority. */
export function registerActiveEmbeddedRunHumanInputWaitForRun(
  runId: string,
  isPending: () => boolean,
): ((resolved: boolean) => void) | undefined {
  const handle = ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(runId);
  const authority = handle && ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle)?.delegatedAuthority;
  return authority ? registerActiveEmbeddedRunHumanInputWait(authority, isPending) : undefined;
}

/** Re-read at the recovery action, including after queued/lazy recovery dispatch. */
export function resolveActiveEmbeddedRunRecoveryBlocker(
  sessionId: string,
  expectedHandle?: object,
): "human_input_wait" | "runtime_owned_wait" | "stale_session_state" | undefined {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (expectedHandle && handle !== expectedHandle) {
    return "stale_session_state";
  }
  const registration = handle && ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle);
  const authority = registration?.delegatedAuthority;
  if (!handle || !authority) {
    return undefined;
  }
  for (const isPending of registration.humanInputWaits ?? []) {
    // Question validation can synchronously close authority or replace the run.
    const pending = isPending() && !handle.isAborted?.();
    if (
      ACTIVE_EMBEDDED_RUNS.get(sessionId) !== handle ||
      !registration.humanInputWaits?.has(isPending)
    ) {
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
  if (
    ACTIVE_EMBEDDED_RUNS.get(sessionId) !== handle ||
    ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) !== registration
  ) {
    return "stale_session_state";
  }
  return ownsLiveness &&
    ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(authority.operationalRunInstance.runId) === handle &&
    getActiveAgentRunDelegatedAuthority(authority.operationalRunInstance) === authority
    ? "runtime_owned_wait"
    : undefined;
}
const ACTIVE_EMBEDDED_RUN_LIFECYCLE_GENERATIONS = embeddedRunState.activeRunLifecycleGenerations;
export const RETAINED_EMBEDDED_RUN_ABORTABILITY_RUN_IDS =
  embeddedRunState.retainedAbortabilityRunIds;
export const ACTIVE_EMBEDDED_RUN_SNAPSHOTS = embeddedRunState.snapshots;
export const ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY = embeddedRunState.sessionIdsByKey;
export const ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE = embeddedRunState.sessionIdsByFile;

export function setActiveEmbeddedRunSessionIndexes(
  sessionId: string,
  sessionKey?: string,
  sessionFile?: string,
): void {
  for (const [index, key] of [
    [ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY, sessionKey?.trim()],
    [ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE, normalizeSessionFileRegistryKey(sessionFile)],
  ] as const) {
    clearActiveRunSessionIndex(index, sessionId);
    if (key) {
      index.set(key, sessionId);
    }
  }
}
export const ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID = embeddedRunState.abandonedRunsBySessionId;
export const ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY =
  embeddedRunState.abandonedRunSessionIdsByKey;
export const ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE =
  embeddedRunState.abandonedRunSessionIdsByFile;
export const EMBEDDED_RUN_FORCED_TERMINAL_SETTLEMENTS = embeddedRunState.forcedTerminalSettlements;
export const EMBEDDED_RUN_WAITERS = embeddedRunState.waiters;

function evictPriorLifecycleEmbeddedRuns(): void {
  const staleHandles = new Set<EmbeddedAgentQueueHandle>();
  for (const [index, bySession] of [
    [ACTIVE_EMBEDDED_RUNS, true],
    [ACTIVE_EMBEDDED_RUNS_BY_RUN_ID, false],
  ] as const) {
    for (const [id, handle] of index) {
      const lifecycleGeneration = ACTIVE_EMBEDDED_RUN_LIFECYCLE_GENERATIONS.get(handle);
      if (lifecycleGeneration && isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)) {
        continue;
      }
      handle.closeDiagnostics?.();
      if (bySession) {
        ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle)?.humanInputWaits?.clear();
      }
      staleHandles.add(handle);
      if (index.get(id) === handle) {
        index.delete(id);
        if (!bySession) {
          // An absent run-ID entry leaves the separately owned chat controller abortable.
          RETAINED_EMBEDDED_RUN_ABORTABILITY_RUN_IDS.delete(id);
        }
      }
      if (bySession) {
        ACTIVE_EMBEDDED_RUN_SNAPSHOTS.delete(id);
      }
    }
  }
  for (const [sessionId, claim] of EMBEDDED_RUN_COMPLETION_CLAIMS) {
    if (!isAgentEventLifecycleGenerationCurrent(claim.lifecycleGeneration)) {
      claim.settleRegistration(undefined);
      EMBEDDED_RUN_COMPLETION_CLAIMS.delete(sessionId);
    }
  }
  for (const index of [
    ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY,
    ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE,
  ]) {
    for (const [key, sessionId] of index) {
      if (!ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
        index.delete(key);
      }
    }
  }
  for (const [sessionId, waiters] of EMBEDDED_RUN_WAITERS) {
    if (ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
      continue;
    }
    EMBEDDED_RUN_WAITERS.delete(sessionId);
    for (const waiter of waiters) {
      if (waiter.timer) {
        clearTimeout(waiter.timer);
      }
      waiter.resolve(true);
    }
  }
  const abortErrors: unknown[] = [];
  // Remove stale ownership first so synchronous abort callbacks may register a
  // replacement without the cleanup above erasing that current-generation run.
  for (const handle of staleHandles) {
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

export function setActiveEmbeddedRunLifecycleGeneration(
  handle: EmbeddedAgentQueueHandle,
  lifecycleGeneration: string,
): string {
  // A delayed re-registration must not transfer an old driver into the new
  // Gateway lifecycle and suppress orphan recovery again.
  const existingLifecycleGeneration = ACTIVE_EMBEDDED_RUN_LIFECYCLE_GENERATIONS.get(handle);
  if (existingLifecycleGeneration !== undefined) {
    return existingLifecycleGeneration;
  }
  ACTIVE_EMBEDDED_RUN_LIFECYCLE_GENERATIONS.set(handle, lifecycleGeneration);
  return lifecycleGeneration;
}
