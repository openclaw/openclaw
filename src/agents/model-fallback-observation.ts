import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { buildTextObservationFields } from "./embedded-agent-error-observation.js";
import type { FailoverReason } from "./embedded-agent-helpers.js";
import type {
  FallbackAttempt,
  ModelCandidate,
  ModelFallbackRouteOrigin,
  ModelFallbackRouteResolution,
} from "./model-fallback.types.js";

const decisionLog = createSubsystemLogger("model-fallback").child("decision");
const AUTH_DECISION_LOG_COALESCE_WINDOW_MS = 30_000;
const AUTH_DECISION_LOG_COALESCE_MAX_ENTRIES = 100;

/** Return whether fallback decision logging is enabled for warn-level events. */
export function isModelFallbackDecisionLogEnabled(): boolean {
  return decisionLog.isEnabled("warn");
}

function buildErrorObservationFields(error?: string) {
  const observed = buildTextObservationFields(error);
  return {
    errorPreview: observed.textPreview,
    errorHash: observed.textHash,
    errorFingerprint: observed.textFingerprint,
    httpCode: observed.httpCode,
    providerErrorType: observed.providerErrorType,
    providerErrorMessagePreview: observed.providerErrorMessagePreview,
    requestIdHash: observed.requestIdHash,
  };
}

type ErrorObservationFields = ReturnType<typeof buildErrorObservationFields>;
type AuthDecisionLogCoalesceEntry = {
  lastLoggedAt: number;
  suppressed: number;
};

const authDecisionLogCoalesceEntries = new Map<string, AuthDecisionLogCoalesceEntry>();

type FallbackStepOutcome = "next_fallback" | "succeeded" | "chain_exhausted";
type ObservedModelCandidate = ModelCandidate & {
  routeOrigin?: ModelFallbackRouteOrigin;
  routeResolution?: ModelFallbackRouteResolution;
};

export type ModelFallbackStepFields = {
  fallbackStepType: "fallback_step";
  fallbackStepFromModel: string;
  fallbackStepToModel?: string;
  fallbackStepFromFailureReason?: FailoverReason;
  fallbackStepFromFailureDetail?: string;
  fallbackStepChainPosition?: number;
  fallbackStepFinalOutcome: FallbackStepOutcome;
};

export type ModelFallbackDecisionParams = {
  decision:
    | "skip_candidate"
    | "probe_cooldown_candidate"
    | "candidate_failed"
    | "candidate_succeeded";
  runId?: string;
  sessionId?: string;
  lane?: string;
  requestedProvider: string;
  requestedModel: string;
  candidate: ObservedModelCandidate;
  attempt?: number;
  total?: number;
  reason?: FailoverReason | null;
  status?: number;
  code?: string;
  error?: string;
  nextCandidate?: ObservedModelCandidate;
  isPrimary?: boolean;
  requestedModelMatched?: boolean;
  fallbackConfigured?: boolean;
  allowTransientCooldownProbe?: boolean;
  profileCount?: number;
  previousAttempts?: FallbackAttempt[];
};

function formatModelRef(candidate: ModelCandidate): string {
  return `${candidate.provider}/${candidate.model}`;
}

function isAuthDecisionLogCoalescingEligible(params: ModelFallbackDecisionParams): boolean {
  return (
    (params.decision === "candidate_failed" || params.decision === "skip_candidate") &&
    (params.reason === "auth" || params.reason === "auth_permanent")
  );
}

function buildAuthDecisionLogCoalesceKey(
  params: ModelFallbackDecisionParams,
  observedError: ErrorObservationFields,
): string {
  return JSON.stringify([
    params.sessionId ?? params.runId,
    params.lane,
    params.requestedProvider,
    params.requestedModel,
    params.decision,
    params.candidate.provider,
    params.candidate.model,
    params.candidate.routeOrigin,
    params.candidate.routeResolution,
    params.attempt,
    params.total,
    params.reason,
    params.status,
    params.code,
    observedError.httpCode,
    observedError.providerErrorType,
    observedError.errorFingerprint ?? observedError.errorHash,
    params.nextCandidate ? formatModelRef(params.nextCandidate) : null,
    params.nextCandidate ? params.nextCandidate.routeOrigin : null,
    params.nextCandidate ? params.nextCandidate.routeResolution : null,
    params.isPrimary,
    params.requestedModelMatched,
    params.fallbackConfigured,
  ]);
}

function pruneAuthDecisionLogCoalesceEntries(now: number): void {
  const staleBefore = now - AUTH_DECISION_LOG_COALESCE_WINDOW_MS * 2;
  for (const [key, entry] of authDecisionLogCoalesceEntries) {
    if (entry.lastLoggedAt < staleBefore) {
      authDecisionLogCoalesceEntries.delete(key);
    }
  }
}

function evictOldestAuthDecisionLogCoalesceEntry(): void {
  let oldestKey: string | undefined;
  let oldestLoggedAt = Infinity;
  for (const [key, entry] of authDecisionLogCoalesceEntries) {
    if (entry.lastLoggedAt < oldestLoggedAt) {
      oldestLoggedAt = entry.lastLoggedAt;
      oldestKey = key;
    }
  }
  if (oldestKey !== undefined) {
    authDecisionLogCoalesceEntries.delete(oldestKey);
  }
}

function rememberAuthDecisionLogCoalesceEntry(key: string, now: number): void {
  if (!authDecisionLogCoalesceEntries.has(key)) {
    pruneAuthDecisionLogCoalesceEntries(now);
    if (authDecisionLogCoalesceEntries.size >= AUTH_DECISION_LOG_COALESCE_MAX_ENTRIES) {
      evictOldestAuthDecisionLogCoalesceEntry();
    }
  }
  authDecisionLogCoalesceEntries.set(key, { lastLoggedAt: now, suppressed: 0 });
}

function resolveAuthDecisionLogCoalescing(
  params: ModelFallbackDecisionParams,
  observedError: ErrorObservationFields,
): { shouldLog: boolean; suppressedDuplicateCount?: number } {
  if (!isAuthDecisionLogCoalescingEligible(params)) {
    return { shouldLog: true };
  }

  const now = Date.now();
  const key = buildAuthDecisionLogCoalesceKey(params, observedError);
  const recent = authDecisionLogCoalesceEntries.get(key);
  const recentAgeMs = recent ? now - recent.lastLoggedAt : undefined;
  if (
    recent &&
    recentAgeMs !== undefined &&
    recentAgeMs >= AUTH_DECISION_LOG_COALESCE_WINDOW_MS * 2
  ) {
    authDecisionLogCoalesceEntries.delete(key);
    rememberAuthDecisionLogCoalesceEntry(key, now);
    return { shouldLog: true };
  }
  if (recent && recentAgeMs !== undefined && recentAgeMs < AUTH_DECISION_LOG_COALESCE_WINDOW_MS) {
    recent.suppressed += 1;
    return { shouldLog: false };
  }

  const suppressedDuplicateCount = recent?.suppressed;
  rememberAuthDecisionLogCoalesceEntry(key, now);
  return { shouldLog: true, suppressedDuplicateCount };
}

function buildFallbackStepFields(
  params: ModelFallbackDecisionParams,
  detailText: string | undefined,
): ModelFallbackStepFields | undefined {
  if (params.decision === "probe_cooldown_candidate") {
    return undefined;
  }
  // Success links the previous failed attempt to the winning candidate.
  const succeeded = params.decision === "candidate_succeeded";
  const previous = succeeded ? params.previousAttempts?.at(-1) : undefined;
  if (succeeded && !previous) {
    return undefined;
  }
  const from = previous ?? params.candidate;
  const to = succeeded ? params.candidate : params.nextCandidate;
  const reason = succeeded ? previous?.reason : params.reason;
  const detail = succeeded ? previous?.error : detailText;
  return {
    fallbackStepType: "fallback_step",
    fallbackStepFromModel: formatModelRef(from),
    ...(to ? { fallbackStepToModel: formatModelRef(to) } : {}),
    ...(reason ? { fallbackStepFromFailureReason: reason } : {}),
    ...(detail ? { fallbackStepFromFailureDetail: detail } : {}),
    ...(typeof params.attempt === "number" ? { fallbackStepChainPosition: params.attempt } : {}),
    fallbackStepFinalOutcome: succeeded
      ? "succeeded"
      : params.nextCandidate
        ? "next_fallback"
        : "chain_exhausted",
  };
}

export function logModelFallbackDecision(
  params: ModelFallbackDecisionParams,
): ModelFallbackStepFields | undefined {
  const nextText = params.nextCandidate
    ? `${sanitizeForLog(params.nextCandidate.provider)}/${sanitizeForLog(params.nextCandidate.model)}`
    : "none";
  const reasonText = params.reason ?? "unknown";
  const observedError = buildErrorObservationFields(params.error);
  const detailText = observedError.providerErrorMessagePreview ?? observedError.errorPreview;
  const fallbackStepFields = buildFallbackStepFields(params, detailText);
  const providerErrorTypeSuffix = observedError.providerErrorType
    ? ` providerErrorType=${sanitizeForLog(observedError.providerErrorType)}`
    : "";
  const detailSuffix = detailText ? ` detail=${sanitizeForLog(detailText)}` : "";
  const logCoalescing = resolveAuthDecisionLogCoalescing(params, observedError);
  if (!logCoalescing.shouldLog) {
    return fallbackStepFields;
  }
  const suppressedDuplicateCount = logCoalescing.suppressedDuplicateCount ?? 0;
  const suppressedSuffix =
    suppressedDuplicateCount > 0
      ? ` (${suppressedDuplicateCount} duplicates suppressed in last ${
          AUTH_DECISION_LOG_COALESCE_WINDOW_MS / 1000
        }s)`
      : "";
  decisionLog.warn("model fallback decision", {
    event: "model_fallback_decision",
    tags: ["error_handling", "model_fallback", params.decision],
    runId: params.runId,
    sessionId: params.sessionId,
    lane: params.lane,
    decision: params.decision,
    requestedProvider: params.requestedProvider,
    requestedModel: params.requestedModel,
    candidateProvider: params.candidate.provider,
    candidateModel: params.candidate.model,
    candidateRouteOrigin: params.candidate.routeOrigin,
    candidateRouteResolution: params.candidate.routeResolution,
    attempt: params.attempt,
    total: params.total,
    reason: params.reason,
    status: params.status,
    code: params.code,
    ...observedError,
    ...fallbackStepFields,
    nextCandidateProvider: params.nextCandidate?.provider,
    nextCandidateModel: params.nextCandidate?.model,
    nextCandidateRouteOrigin: params.nextCandidate?.routeOrigin,
    nextCandidateRouteResolution: params.nextCandidate?.routeResolution,
    isPrimary: params.isPrimary,
    requestedModelMatched: params.requestedModelMatched,
    fallbackConfigured: params.fallbackConfigured,
    allowTransientCooldownProbe: params.allowTransientCooldownProbe,
    profileCount: params.profileCount,
    ...(suppressedDuplicateCount > 0 ? { suppressedDuplicateCount } : {}),
    previousAttempts: params.previousAttempts?.map((attempt) => ({
      provider: attempt.provider,
      model: attempt.model,
      reason: attempt.reason,
      status: attempt.status,
      code: attempt.code,
      ...buildErrorObservationFields(attempt.error),
    })),
    consoleMessage:
      `model fallback decision: decision=${params.decision} requested=${sanitizeForLog(params.requestedProvider)}/${sanitizeForLog(params.requestedModel)} ` +
      `candidate=${sanitizeForLog(params.candidate.provider)}/${sanitizeForLog(params.candidate.model)} reason=${reasonText}${providerErrorTypeSuffix} next=${nextText}${detailSuffix}${suppressedSuffix}`,
  });
  return fallbackStepFields;
}

export type ModelFallbackChainStopReason =
  | "agent_run_terminal_timeout"
  | "idle_timeout_circuit_breaker"
  | "command_lane_task_timeout"
  | "agent_harness_preflight"
  | "sandbox_provisioning"
  | "caller_signal_aborted"
  | "agent_run_direct_abort"
  | "agent_run_restart_abort"
  | "agent_run_superseded_abort"
  | "session_placement_settlement_closed"
  | "terminal_abort_wrapper";

/** Record a local or terminal stop separately from provider-failure decisions. */
export function logModelFallbackChainStopped(params: {
  reason: ModelFallbackChainStopReason;
  provider: string;
  model: string;
  sessionId?: string;
  lane?: string;
  error?: unknown;
}): void {
  if (!decisionLog.isEnabled("warn")) {
    return;
  }
  let errorName: string | undefined;
  try {
    const name: unknown = params.error instanceof Error ? params.error.name : undefined;
    errorName = typeof name === "string" && name ? name : undefined;
  } catch {
    // Optional diagnostic metadata must not replace the original stop error.
  }
  decisionLog.warn("model fallback chain stopped", {
    event: "model_fallback_chain_stopped",
    tags: ["error_handling", "model_fallback", "chain_stopped"],
    sessionId: params.sessionId,
    lane: params.lane,
    reason: params.reason,
    candidateProvider: params.provider,
    candidateModel: params.model,
    errorName,
    consoleMessage:
      `model fallback chain stopped: reason=${params.reason} ` +
      `candidate=${sanitizeForLog(params.provider)}/${sanitizeForLog(params.model)}` +
      (errorName ? ` errorName=${sanitizeForLog(errorName)}` : ""),
  });
}
