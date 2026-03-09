import { createSubsystemLogger } from "../logging/subsystem.js";
import { buildTextObservationFields } from "./pi-embedded-error-observation.js";
import type { FailoverReason } from "./pi-embedded-helpers.js";

const decisionLog = createSubsystemLogger("model-fallback").child("decision");

type ModelCandidate = {
  provider: string;
  model: string;
};

type FallbackAttempt = {
  provider: string;
  model: string;
  error: string;
  reason?: FailoverReason;
  status?: number;
  code?: string;
};

export function logModelFallbackDecision(params: {
  decision:
    | "skip_candidate"
    | "probe_cooldown_candidate"
    | "candidate_failed"
    | "candidate_succeeded";
  runId?: string;
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
}): void {
  const nextText = params.nextCandidate
    ? `${params.nextCandidate.provider}/${params.nextCandidate.model}`
    : "none";
  const reasonText = params.reason ?? "unknown";
  const observedError = buildTextObservationFields(params.error);
  decisionLog.info("model fallback decision", {
    event: "model_fallback_decision",
    tags: ["error_handling", "model_fallback", params.decision],
    runId: params.runId,
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
    errorPreview: observedError.textPreview,
    errorHash: observedError.textHash,
    errorFingerprint: observedError.textFingerprint,
    httpCode: observedError.httpCode,
    providerErrorType: observedError.providerErrorType,
    providerErrorMessagePreview: observedError.providerErrorMessagePreview,
    requestIdHash: observedError.requestIdHash,
    nextCandidateProvider: params.nextCandidate?.provider,
    nextCandidateModel: params.nextCandidate?.model,
    isPrimary: params.isPrimary,
    requestedModelMatched: params.requestedModelMatched,
    fallbackConfigured: params.fallbackConfigured,
    allowTransientCooldownProbe: params.allowTransientCooldownProbe,
    profileCount: params.profileCount,
    previousAttempts: params.previousAttempts?.map((attempt) => ({
      provider: attempt.provider,
      model: attempt.model,
      reason: attempt.reason,
      status: attempt.status,
      code: attempt.code,
      ...buildTextObservationFields(attempt.error),
    })),
    consoleMessage:
      `model fallback decision: decision=${params.decision} requested=${params.requestedProvider}/${params.requestedModel} ` +
      `candidate=${params.candidate.provider}/${params.candidate.model} reason=${reasonText} next=${nextText}`,
  });
}
