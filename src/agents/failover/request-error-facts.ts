import {
  extractErrorHttpStatus,
  formatTransportErrorCopy,
} from "../../shared/assistant-error-format.js";
import { describeFailoverError } from "../failover-error.js";
import { renderFormatErrorCopy } from "./assistant-request-failure-copy.js";
import { classifyFailoverReason } from "./classify.js";
import { classifyProviderRequestFacets } from "./request-error-facets.js";
import { resolveProviderRequestFailureCopy } from "./user-copy.js";

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
  return {
    reason: reason || undefined,
    code: described.code,
    provider: described.provider,
    model: described.model,
    status,
    authMode: described.authMode,
    requestFailureText:
      reason === "format"
        ? renderFormatErrorCopy(rawError)
        : transportCopy
          ? `⚠️ ${transportCopy} Check the conversation for any completed work before trying again.`
          : undefined,
    providerRequestError: resolveProviderRequestFailureCopy({
      classification,
      facet: classifyProviderRequestFacets({
        status,
        message: rawError,
      }),
      status,
      technicalMessage: message,
    }),
  };
}
