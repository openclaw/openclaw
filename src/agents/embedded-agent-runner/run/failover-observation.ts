/**
 * Logs redacted failover decisions for embedded-agent attempts.
 */
import { redactIdentifier } from "../../../logging/redact-identifier.js";
import type { PluginHookModelFailoverEvent } from "../../../plugins/hook-types.js";
import type { AuthProfileFailureReason } from "../../auth-profiles.js";
import { sanitizeForConsole } from "../../console-sanitize.js";
import {
  buildApiErrorObservationFields,
  shouldSuppressRawErrorConsoleSuffix,
} from "../../embedded-agent-error-observation.js";
import type { FailoverReason } from "../../embedded-agent-helpers.js";
import { shouldAllowCooldownProbeForReason } from "../../failover-policy.js";
import { log } from "../logger.js";

/** Minimal hook-runner interface needed for failover observation. */
export type FailoverHookRunner = {
  hasHooks: (hookName: "model_failover") => boolean;
  runModelFailover: (
    event: PluginHookModelFailoverEvent,
    ctx: { runId?: string; agentId?: string; sessionId?: string; sessionKey?: string },
  ) => Promise<void>;
};

/** Structured fields emitted whenever embedded run failover chooses an action. */
type FailoverDecisionLoggerInput = {
  stage: "prompt" | "assistant";
  decision: "rotate_profile" | "fallback_model" | "surface_error";
  runId?: string;
  rawError?: string;
  failoverReason: FailoverReason | null;
  profileFailureReason?: AuthProfileFailureReason | null;
  provider: string;
  model: string;
  sourceProvider?: string;
  sourceModel?: string;
  profileId?: string;
  fallbackConfigured: boolean;
  timedOut?: boolean;
  aborted?: boolean;
  status?: number;
};

export type FailoverDecisionLoggerExtra = Pick<FailoverDecisionLoggerInput, "status"> & {
  /** Selected fallback target for this decision, when it differs from the failed source. */
  targetProvider?: string;
  targetModel?: string;
};

/** Stable context captured before a concrete failover decision is known. */
export type FailoverDecisionLoggerBase = Omit<
  FailoverDecisionLoggerInput,
  "decision" | "status"
> & {
  /** Optional hook runner for emitting plugin hooks alongside logs. */
  hookRunner?: FailoverHookRunner;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
};

/**
 * Derives timeout failure reasons for logs that were built from timeout state
 * before the normal provider error classifier had a raw error to inspect.
 */
export function normalizeFailoverDecisionObservationBase(
  base: FailoverDecisionLoggerBase,
): FailoverDecisionLoggerBase {
  return {
    ...base,
    failoverReason: base.failoverReason ?? (base.timedOut ? "timeout" : null),
    profileFailureReason: base.profileFailureReason ?? (base.timedOut ? "timeout" : null),
  };
}

/**
 * Captures sanitized failover context and returns a decision logger. The closure
 * keeps prompt/assistant failover branches consistent while still allowing the
 * final decision and HTTP status to be supplied at the action point.
 */
export function createFailoverDecisionLogger(
  base: FailoverDecisionLoggerBase,
): (
  decision: FailoverDecisionLoggerInput["decision"],
  extra?: FailoverDecisionLoggerExtra,
) => void {
  const normalizedBase = normalizeFailoverDecisionObservationBase(base);
  const safeProfileId = normalizedBase.profileId
    ? redactIdentifier(normalizedBase.profileId, { len: 12 })
    : undefined;
  const safeRunId = sanitizeForConsole(normalizedBase.runId) ?? "-";
  const baseSafeProvider = sanitizeForConsole(normalizedBase.provider) ?? "-";
  const baseSafeModel = sanitizeForConsole(normalizedBase.model) ?? "-";
  const safeSourceProvider = sanitizeForConsole(normalizedBase.sourceProvider) ?? baseSafeProvider;
  const safeSourceModel = sanitizeForConsole(normalizedBase.sourceModel) ?? baseSafeModel;
  const profileText = safeProfileId ?? "-";
  const reasonText = normalizedBase.failoverReason ?? "none";
  return (decision, extra) => {
    const targetProvider = extra?.targetProvider ?? normalizedBase.provider;
    const targetModel = extra?.targetModel ?? normalizedBase.model;
    const safeProvider = sanitizeForConsole(targetProvider) ?? "-";
    const safeModel = sanitizeForConsole(targetModel) ?? "-";
    const sourceChanged = safeSourceProvider !== safeProvider || safeSourceModel !== safeModel;
    const observedError = buildApiErrorObservationFields(normalizedBase.rawError);
    const safeRawErrorPreview = sanitizeForConsole(observedError.rawErrorPreview);
    // Some provider/runtime failure kinds already have normalized detail fields.
    // Repeating the raw suffix there makes the console line noisier without
    // adding actionable failover evidence.
    const rawErrorConsoleSuffix =
      safeRawErrorPreview &&
      !shouldSuppressRawErrorConsoleSuffix(observedError.providerRuntimeFailureKind)
        ? ` rawError=${safeRawErrorPreview}`
        : "";
    log.warn("embedded run failover decision", {
      event: "embedded_run_failover_decision",
      tags: ["error_handling", "failover", normalizedBase.stage, decision],
      runId: normalizedBase.runId,
      stage: normalizedBase.stage,
      decision,
      failoverReason: normalizedBase.failoverReason,
      profileFailureReason: normalizedBase.profileFailureReason,
      provider: targetProvider,
      model: targetModel,
      sourceProvider: normalizedBase.sourceProvider ?? normalizedBase.provider,
      sourceModel: normalizedBase.sourceModel ?? normalizedBase.model,
      profileId: safeProfileId,
      fallbackConfigured: normalizedBase.fallbackConfigured,
      timedOut: normalizedBase.timedOut,
      aborted: normalizedBase.aborted,
      status: extra?.status,
      sourceRecoverable: shouldAllowCooldownProbeForReason(normalizedBase.failoverReason),
      ...observedError,
      consoleMessage:
        `embedded run failover decision: runId=${safeRunId} stage=${normalizedBase.stage} decision=${decision} ` +
        `reason=${reasonText} from=${safeSourceProvider}/${safeSourceModel}` +
        `${sourceChanged ? ` to=${safeProvider}/${safeModel}` : ""} profile=${profileText}${rawErrorConsoleSuffix}`,
    });

    // Emit plugin hook (fire-and-forget). This fires alongside the log so plugins
    // can react to failover decisions without polling gateway logs.
    const hookRunner = normalizedBase.hookRunner;
    if (hookRunner?.hasHooks("model_failover")) {
      const hookEvent: PluginHookModelFailoverEvent = {
        runId: normalizedBase.runId,
        agentId: normalizedBase.agentId,
        sessionId: normalizedBase.sessionId,
        sessionKey: normalizedBase.sessionKey,
        provider: targetProvider,
        model: targetModel,
        sourceProvider: normalizedBase.sourceProvider,
        sourceModel: normalizedBase.sourceModel,
        stage: normalizedBase.stage,
        decision,
        failoverReason: normalizedBase.failoverReason,
        profileFailureReason: normalizedBase.profileFailureReason,
        fallbackConfigured: normalizedBase.fallbackConfigured,
        timedOut: normalizedBase.timedOut,
        aborted: normalizedBase.aborted,
        status: extra?.status,
        sourceRecoverable: shouldAllowCooldownProbeForReason(normalizedBase.failoverReason),
      };
      const hookCtx = {
        runId: normalizedBase.runId,
        agentId: normalizedBase.agentId,
        sessionId: normalizedBase.sessionId,
        sessionKey: normalizedBase.sessionKey,
      };
      void hookRunner.runModelFailover(hookEvent, hookCtx);
    }
  };
}
