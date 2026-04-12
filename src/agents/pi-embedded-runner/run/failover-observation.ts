import { redactIdentifier } from "../../../logging/redact-identifier.js";
import type { AuthProfileFailureReason } from "../../auth-profiles.js";
import { resolveFailoverStatus } from "../../failover-error.js";
import {
  buildApiErrorObservationFields,
  sanitizeForConsole,
} from "../../pi-embedded-error-observation.js";
import type { FailoverReason } from "../../pi-embedded-helpers.js";
import { log } from "../logger.js";

export type FailoverDecisionLoggerInput = {
  stage: "prompt" | "assistant";
  decision: "rotate_profile" | "fallback_model" | "surface_error";
  runId?: string;
  rawError?: string;
  failoverReason: FailoverReason | null;
  profileFailureReason?: AuthProfileFailureReason | null;
  provider: string;
  model: string;
  profileId?: string;
  fallbackConfigured: boolean;
  timedOut?: boolean;
  aborted?: boolean;
  status?: number;
};

export type FailoverDecisionLoggerBase = Omit<FailoverDecisionLoggerInput, "decision" | "status">;

export function normalizeFailoverDecisionObservationBase(
  base: FailoverDecisionLoggerBase,
): FailoverDecisionLoggerBase {
  return {
    ...base,
    failoverReason: base.failoverReason ?? (base.timedOut ? "timeout" : null),
    profileFailureReason: base.profileFailureReason ?? (base.timedOut ? "timeout" : null),
  };
}

function isTimeoutObservation(base: FailoverDecisionLoggerBase): boolean {
  return (
    base.timedOut === true ||
    base.failoverReason === "timeout" ||
    base.profileFailureReason === "timeout"
  );
}

function describeTimeoutOutcome(decision: FailoverDecisionLoggerInput["decision"]): string {
  switch (decision) {
    case "fallback_model":
      return "escalating_to_model_fallback";
    case "rotate_profile":
      return "rotating_auth_profile";
    case "surface_error":
      return "surfacing_timeout";
    default:
      return "timeout_observed";
  }
}

export function createFailoverDecisionLogger(
  base: FailoverDecisionLoggerBase,
): (
  decision: FailoverDecisionLoggerInput["decision"],
  extra?: Pick<FailoverDecisionLoggerInput, "status">,
) => void {
  const normalizedBase = normalizeFailoverDecisionObservationBase(base);
  const safeProfileId = normalizedBase.profileId
    ? redactIdentifier(normalizedBase.profileId, { len: 12 })
    : undefined;
  const safeRunId = sanitizeForConsole(normalizedBase.runId) ?? "-";
  const safeProvider = sanitizeForConsole(normalizedBase.provider) ?? "-";
  const safeModel = sanitizeForConsole(normalizedBase.model) ?? "-";
  const profileText = safeProfileId ?? "-";
  const reasonText = normalizedBase.failoverReason ?? "none";
  const timeoutObserved = isTimeoutObservation(normalizedBase);
  return (decision, extra) => {
    const observedError = buildApiErrorObservationFields(normalizedBase.rawError);
    const status = extra?.status ?? (timeoutObserved ? resolveFailoverStatus("timeout") : undefined);
    const detailText = observedError.providerErrorMessagePreview ?? observedError.rawErrorPreview;
    const detailSuffix = detailText ? ` detail=${sanitizeForConsole(detailText)}` : "";
    log.warn("embedded run failover decision", {
      event: "embedded_run_failover_decision",
      tags: ["error_handling", "failover", normalizedBase.stage, decision],
      runId: normalizedBase.runId,
      stage: normalizedBase.stage,
      decision,
      failoverReason: normalizedBase.failoverReason,
      profileFailureReason: normalizedBase.profileFailureReason,
      provider: normalizedBase.provider,
      model: normalizedBase.model,
      profileId: safeProfileId,
      fallbackConfigured: normalizedBase.fallbackConfigured,
      timedOut: normalizedBase.timedOut,
      aborted: normalizedBase.aborted,
      status,
      ...observedError,
      consoleMessage:
        `embedded run failover decision: runId=${safeRunId} stage=${normalizedBase.stage} decision=${decision} ` +
        `reason=${reasonText} provider=${safeProvider}/${safeModel} profile=${profileText}`,
    });
    if (!timeoutObserved) {
      return;
    }
    const timeoutOutcome = describeTimeoutOutcome(decision);
    log.error("embedded run timeout loud", {
      event: "embedded_run_timeout_loud",
      tags: ["error_handling", "timeout", "failover", normalizedBase.stage, decision],
      runId: normalizedBase.runId,
      stage: normalizedBase.stage,
      decision,
      timeoutOutcome,
      failoverReason: normalizedBase.failoverReason,
      profileFailureReason: normalizedBase.profileFailureReason,
      provider: normalizedBase.provider,
      model: normalizedBase.model,
      profileId: safeProfileId,
      fallbackConfigured: normalizedBase.fallbackConfigured,
      timedOut: normalizedBase.timedOut,
      aborted: normalizedBase.aborted,
      status,
      ...observedError,
      consoleMessage:
        `[TIMEOUT LOUD] embedded run timeout: runId=${safeRunId} stage=${normalizedBase.stage} ` +
        `decision=${decision} outcome=${timeoutOutcome} provider=${safeProvider}/${safeModel} ` +
        `profile=${profileText} fallbackConfigured=${normalizedBase.fallbackConfigured ? "yes" : "no"} ` +
        `status=${status ?? "-"}${detailSuffix}`,
    });
  };
}
