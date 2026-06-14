/**
 * Structured logging for model fallback decisions. The log payload carries
 * sanitized error observations plus step fields that make fallback chains
 * auditable.
 */
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { buildTextObservationFields } from "./embedded-agent-error-observation.js";
import type { FailoverReason } from "./embedded-agent-helpers.js";
import type { FallbackAttempt, ModelCandidate } from "./model-fallback.types.js";

const decisionLog = createSubsystemLogger("model-fallback").child("decision");

/**
 * Throttle duplicate fallback decision logs to prevent spam when auth tokens
 * expire. Key: `${decision}:${provider}:${reason}`. Each unique key is logged
 * at most once per window; subsequent duplicates are counted and the count is
 * surfaced when the window expires.
 */
const LOG_THROTTLE_WINDOW_MS = 60_000;
const recentDecisionLogs = new Map<string, { lastLoggedAt: number; suppressed: number }>();

function buildThrottleKey(decision: string, provider: string, reason: string | null | undefined): string {
  return `${decision}:${provider}:${reason ?? "unknown"}`;
}

/** Return whether fallback decision logging is enabled for warn-level events. */
export function isModelFallbackDecisionLogEnabled(): boolean {
  return decisionLog.isEnabled("warn");
}

function buildErrorObservationFields(error?: string): {
  errorPreview?: string;
  errorHash?: string;
  errorFingerprint?: string;
  httpCode?: string;
  providerErrorType?: string;
  providerErrorMessagePreview?: string;
  requestIdHash?: string;
} {
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

type FallbackStepOutcome = "next_fallback" | "succeeded" | "chain_exhausted";

/** Structured fields that describe one fallback-chain transition. */
export type ModelFallbackStepFields = {
  fallbackStepType: "fallback_step";
  fallbackStepFromModel: string;
  fallbackStepToModel?: string;
  fallbackStepFromFailureReason?: FailoverReason;
  fallbackStepFromFailureDetail?: string;
  fallbackStepChainPosition?: number;
  fallbackStepFinalOutcome: FallbackStepOutcome;
};

/** Input payload for logging one model fallback decision. */
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
  candidate: ModelCandidate;
  attempt?: number;
  total?: number;
  reason?: FailoverReason | null;
  status?: number;
  code?: string;
  error?: string;
  nextCandidate?: ModelCandidate;
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

function buildFallbackStepFields(params: {
  decision: "skip_candidate" | "candidate_failed" | "candidate_succeeded";
  candidate: ModelCandidate;
  reason?: FailoverReason | null;
  error?: string;
  nextCandidate?: ModelCandidate;
  attempt?: number;
  previousAttempts?: FallbackAttempt[];
}): ModelFallbackStepFields | undefined {
  const lastPreviousAttempt = params.previousAttempts?.at(-1);
  if (params.decision === "candidate_succeeded") {
    // Success records the previous failed candidate as the source and the current
    // candidate as the successful fallback destination.
    if (!lastPreviousAttempt) {
      return undefined;
    }
    return {
      fallbackStepType: "fallback_step",
      fallbackStepFromModel: `${lastPreviousAttempt.provider}/${lastPreviousAttempt.model}`,
      fallbackStepToModel: formatModelRef(params.candidate),
      ...(lastPreviousAttempt.reason
        ? { fallbackStepFromFailureReason: lastPreviousAttempt.reason }
        : {}),
      ...(lastPreviousAttempt.error
        ? { fallbackStepFromFailureDetail: lastPreviousAttempt.error }
        : {}),
      ...(typeof params.attempt === "number" ? { fallbackStepChainPosition: params.attempt } : {}),
      fallbackStepFinalOutcome: "succeeded",
    };
  }

  const observed = buildErrorObservationFields(params.error);
  return {
    fallbackStepType: "fallback_step",
    fallbackStepFromModel: formatModelRef(params.candidate),
    ...(params.nextCandidate ? { fallbackStepToModel: formatModelRef(params.nextCandidate) } : {}),
    ...(params.reason ? { fallbackStepFromFailureReason: params.reason } : {}),
    ...((observed.providerErrorMessagePreview ?? observed.errorPreview)
      ? {
          fallbackStepFromFailureDetail:
            observed.providerErrorMessagePreview ?? observed.errorPreview,
        }
      : {}),
    ...(typeof params.attempt === "number" ? { fallbackStepChainPosition: params.attempt } : {}),
    fallbackStepFinalOutcome: params.nextCandidate ? "next_fallback" : "chain_exhausted",
  };
}

/** Log one model fallback decision and return structured fallback-step fields. */
export function logModelFallbackDecision(
  params: ModelFallbackDecisionParams,
): ModelFallbackStepFields | undefined {
  const nextText = params.nextCandidate
    ? `${sanitizeForLog(params.nextCandidate.provider)}/${sanitizeForLog(params.nextCandidate.model)}`
    : "none";
  const reasonText = params.reason ?? "unknown";
  const observedError = buildErrorObservationFields(params.error);
  const detailText = observedError.providerErrorMessagePreview ?? observedError.errorPreview;
  const fallbackStepFields =
    params.decision === "skip_candidate" ||
    params.decision === "candidate_failed" ||
    params.decision === "candidate_succeeded"
      ? buildFallbackStepFields({
          decision: params.decision,
          candidate: params.candidate,
          reason: params.reason,
          error: params.error,
          nextCandidate: params.nextCandidate,
          attempt: params.attempt,
          previousAttempts: params.previousAttempts,
        })
      : undefined;
  const providerErrorTypeSuffix = observedError.providerErrorType
    ? ` providerErrorType=${sanitizeForLog(observedError.providerErrorType)}`
    : "";
  const detailSuffix = detailText ? ` detail=${sanitizeForLog(detailText)}` : "";

  // Throttle duplicate decision logs to prevent spam when auth tokens expire.
  // The same (decision, provider, reason) combination is logged at most once
  // per window; subsequent duplicates are counted and surfaced on the next
  // allowed log.
  const throttleKey = buildThrottleKey(params.decision, params.candidate.provider, params.reason);
  const now = Date.now();
  const recent = recentDecisionLogs.get(throttleKey);
  if (recent && now - recent.lastLoggedAt < LOG_THROTTLE_WINDOW_MS) {
    recent.suppressed += 1;
    return fallbackStepFields;
  }
  const suppressedCount = recent?.suppressed ?? 0;
  recentDecisionLogs.set(throttleKey, { lastLoggedAt: now, suppressed: 0 });

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
    attempt: params.attempt,
    total: params.total,
    reason: params.reason,
    status: params.status,
    code: params.code,
    ...observedError,
    ...fallbackStepFields,
    nextCandidateProvider: params.nextCandidate?.provider,
    nextCandidateModel: params.nextCandidate?.model,
    isPrimary: params.isPrimary,
    requestedModelMatched: params.requestedModelMatched,
    fallbackConfigured: params.fallbackConfigured,
    allowTransientCooldownProbe: params.allowTransientCooldownProbe,
    profileCount: params.profileCount,
    suppressedDuplicateCount: suppressedCount || undefined,
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
      `candidate=${sanitizeForLog(params.candidate.provider)}/${sanitizeForLog(params.candidate.model)} reason=${reasonText}${providerErrorTypeSuffix} next=${nextText}${detailSuffix}` +
      (suppressedCount > 0 ? ` (${suppressedCount} duplicates suppressed in last ${LOG_THROTTLE_WINDOW_MS / 1000}s)` : ""),
  });
  return fallbackStepFields;
}
