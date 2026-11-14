import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { classifyGatewayStorageFailure } from "../../infra/sqlite-error-diagnostics.js";
import {
  extractErrorHttpStatus,
  formatTransportErrorCopy,
} from "../../shared/assistant-error-format.js";
import { describeFailoverError } from "../failover-error.js";
import { AgentHarnessModelRequestPolicyError } from "../harness/errors.js";
import {
  renderAssistantRequestFailureCopy,
  renderFormatErrorCopy,
} from "./assistant-request-failure-copy.js";
import { classifyFailoverReason } from "./classify.js";
import { classifyProviderRequestFacets } from "./request-error-facets.js";
import { resolveRetryAfterMs } from "./retry-evidence.js";
import { renderRateLimitResetCopy, resolveProviderRequestFailureCopy } from "./user-copy.js";

export function resolveReplyFailoverFacts(
  error: unknown,
  message: string,
  config?: OpenClawConfig,
) {
  const described = describeFailoverError(error);
  const rawError = described.rawError ?? message;
  const status = extractErrorHttpStatus(rawError)?.code ?? described.status;
  const reason =
    described.reason ?? classifyFailoverReason(rawError, { provider: described.provider });
  const transportCopy =
    reason === "timeout" && (status === undefined || status === 408)
      ? formatTransportErrorCopy([rawError, described.code].filter(Boolean).join(" "))
      : undefined;
  const classification = reason ? ({ kind: "reason", reason } as const) : null;
  const storageCopy = renderAssistantRequestFailureCopy({
    storageFailure: classifyGatewayStorageFailure(error),
  });
  const retryAfterMs =
    reason === "rate_limit" && described.rateLimitResetAt === undefined
      ? resolveRetryAfterMs(rawError, Date.now(), error)
      : undefined;
  const rateLimitResetAt =
    described.rateLimitResetAt ??
    (retryAfterMs === undefined ? undefined : Date.now() + retryAfterMs);
  return {
    rateLimitResetAt,
    reason: reason || undefined,
    code: described.code,
    provider: described.provider,
    model: described.model,
    status,
    authMode: described.authMode,
    requestFailureText:
      storageCopy ??
      (reason === "rate_limit"
        ? renderRateLimitResetCopy({
            ...described,
            rateLimitResetAt,
            locale: config?.ui?.prefs?.locale,
            timeZone: config?.agents?.defaults?.userTimezone,
          })
        : undefined) ??
      (error instanceof AgentHarnessModelRequestPolicyError ? error.message : undefined) ??
      (reason === "format"
        ? renderFormatErrorCopy(rawError)
        : transportCopy
          ? `⚠️ ${transportCopy} Check the conversation for any completed work before trying again.`
          : undefined),
    providerRequestError: resolveProviderRequestFailureCopy({
      classification,
      facet: classifyProviderRequestFacets({
        status,
        message: rawError,
      }),
      status,
      code: described.code,
    }),
  };
}
