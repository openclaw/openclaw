import { redactIdentifier } from "../../../logging/redact-identifier.js";
import type { AuthProfileFailureReason } from "../../auth-profiles.js";
import { buildApiErrorObservationFields } from "../../pi-embedded-error-observation.js";
import type { FailoverReason } from "../../pi-embedded-helpers.js";
import { log } from "../logger.js";

export type FailoverDecisionObservation = {
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

export type FailoverDecisionBase = Omit<FailoverDecisionObservation, "decision" | "status">;

export function createFailoverDecisionLogger(
  base: FailoverDecisionBase,
): (
  decision: FailoverDecisionObservation["decision"],
  extra?: Pick<FailoverDecisionObservation, "status">,
) => void {
  const safeProfileId = base.profileId ? redactIdentifier(base.profileId, { len: 12 }) : undefined;
  const profileText = safeProfileId ?? "-";
  const reasonText = base.failoverReason ?? "none";
  return (decision, extra) => {
    const observedError = buildApiErrorObservationFields(base.rawError);
    log.warn("embedded run failover decision", {
      event: "embedded_run_failover_decision",
      tags: ["error_handling", "failover", base.stage, decision],
      runId: base.runId,
      stage: base.stage,
      decision,
      failoverReason: base.failoverReason,
      profileFailureReason: base.profileFailureReason,
      provider: base.provider,
      model: base.model,
      profileId: safeProfileId,
      fallbackConfigured: base.fallbackConfigured,
      timedOut: base.timedOut,
      aborted: base.aborted,
      status: extra?.status,
      ...observedError,
      consoleMessage:
        `embedded run failover decision: runId=${base.runId ?? "-"} stage=${base.stage} decision=${decision} ` +
        `reason=${reasonText} provider=${base.provider}/${base.model} profile=${profileText}`,
    });
  };
}
