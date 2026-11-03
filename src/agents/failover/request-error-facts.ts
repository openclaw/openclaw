import { classifyGatewayStorageFailure } from "../../infra/sqlite-error-diagnostics.js";
import {
  extractErrorHttpStatus,
  formatTransportErrorCopy,
} from "../../shared/assistant-error-format.js";
import { describeFailoverError } from "../failover-error.js";
import {
  renderAssistantRequestFailureCopy,
  renderFormatErrorCopy,
} from "./assistant-request-failure-copy.js";
import { classifyFailoverReason } from "./classify.js";
import { isPeriodicUsageLimitErrorMessage } from "./message-patterns.js";
import { classifyProviderRequestFacets } from "./request-error-facets.js";
import { renderRateLimitReplyCopy, resolveProviderRequestFailureCopy } from "./user-copy.js";

export function resolveReplyFailoverFacts(error: unknown, message: string) {
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
  // A usage window that names its reset time is actionable; the generic rate-limit copy
  // ("try again in a few minutes") is wrong by hours or days. The quota renderer already
  // sanitizes and bounds the provider line, so reuse it instead of echoing raw text here.
  const quotaCopy =
    reason === "rate_limit" && isPeriodicUsageLimitErrorMessage(rawError)
      ? renderRateLimitReplyCopy({ message: rawError, reason, attempts: [] })
      : undefined;
  return {
    reason: reason || undefined,
    code: described.code,
    provider: described.provider,
    model: described.model,
    status,
    authMode: described.authMode,
    requestFailureText:
      storageCopy ??
      (reason === "format"
        ? renderFormatErrorCopy(rawError)
        : transportCopy
          ? `⚠️ ${transportCopy} Check the conversation for any completed work before trying again.`
          : quotaCopy),
    providerRequestError: resolveProviderRequestFailureCopy({
      classification,
      facet: classifyProviderRequestFacets({
        status,
        message: rawError,
      }),
      status,
    }),
  };
}
