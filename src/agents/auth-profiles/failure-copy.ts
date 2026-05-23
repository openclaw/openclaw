import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { FailoverReason } from "../embedded-agent-helpers/types.js";
import { buildProviderAuthRecoveryHint } from "../provider-auth-recovery-hint.js";

export type AuthProfileFailureCopyParams = {
  reason: FailoverReason;
  provider: string;
  /**
   * True when the failure was reached because every configured profile is in
   * cooldown / blocked. False when an attempt to use a specific profile threw
   * (e.g. credential lookup failed). The two paths produce different copy
   * because only the cooldown case implies "wait or rotate"; the other case
   * implies "the credential itself is broken".
   */
  allInCooldown: boolean;
  /**
   * Underlying error that triggered the failover, if any. Used to append a
   * short diagnostic suffix and to fall back to the original message when no
   * structured recovery copy applies.
   */
  cause?: unknown;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
};

function describeReason(
  reason: FailoverReason,
  provider: string,
  allInCooldown: boolean,
): string | null {
  if (allInCooldown) {
    switch (reason) {
      case "auth":
      case "session_expired":
        return `Every auth profile for ${provider} is currently failing authentication; sessions look expired or credentials were rejected.`;
      case "auth_permanent":
        return `Every auth profile for ${provider} has been permanently denied by the provider.`;
      case "billing":
        return `Every auth profile for ${provider} is blocked for billing on the provider account.`;
      case "rate_limit":
        return `Every auth profile for ${provider} is cooling down after recent rate-limit responses.`;
      case "overloaded":
        return `Every auth profile for ${provider} is cooling down while the provider is reporting overload.`;
      case "timeout":
        return `Every auth profile for ${provider} is cooling down after recent requests timed out.`;
      case "model_not_found":
        return `Every auth profile for ${provider} was rejected with a model-not-found error.`;
      case "server_error":
        return `Every auth profile for ${provider} is cooling down after recent provider server errors.`;
      default:
        return `No ${provider} auth profile is currently available; all are in cooldown or blocked.`;
    }
  }
  switch (reason) {
    case "auth":
    case "session_expired":
      return `Authentication with ${provider} did not succeed.`;
    case "auth_permanent":
      return `Authentication with ${provider} was permanently denied.`;
    case "billing":
      return `Provider ${provider} reported a billing problem on this account.`;
    default:
      return null;
  }
}

function shouldIncludeRecoveryHint(reason: FailoverReason): boolean {
  switch (reason) {
    case "auth":
    case "auth_permanent":
    case "session_expired":
    case "billing":
      return true;
    case "rate_limit":
    case "overloaded":
    case "timeout":
    case "server_error":
    case "model_not_found":
      return false;
    default:
      return true;
  }
}

function diagnosticSuffix(cause: unknown, primary: string): string | null {
  if (cause === undefined || cause === null) {
    return null;
  }
  const text = formatErrorMessage(cause).trim();
  if (!text || primary.includes(text)) {
    return null;
  }
  return ` (${text})`;
}

/**
 * Single source of truth for user-facing copy when an auth-profile rotation
 * fails. Composes a reason-specific sentence with an actionable next-step
 * derived from the provider's plugin manifest (`buildProviderAuthRecoveryHint`).
 *
 * Falls back to the underlying error's text when the reason maps to nothing
 * actionable, so we never produce worse copy than the raw error.
 */
export function formatAuthProfileFailureMessage(params: AuthProfileFailureCopyParams): string {
  const description = describeReason(params.reason, params.provider, params.allInCooldown);
  if (!description) {
    const causeText = params.cause ? formatErrorMessage(params.cause).trim() : "";
    if (causeText) {
      return causeText;
    }
    return `No ${params.provider} auth profile is currently available; all are in cooldown or blocked.`;
  }
  const hint = shouldIncludeRecoveryHint(params.reason)
    ? buildProviderAuthRecoveryHint({
        provider: params.provider,
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
      })
    : null;
  const suffix = diagnosticSuffix(params.cause, description);
  const parts = [description];
  if (hint) {
    parts.push(hint);
  }
  const message = parts.join(" ");
  return suffix ? `${message}${suffix}` : message;
}
