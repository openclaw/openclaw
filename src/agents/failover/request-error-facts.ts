import { extractErrorHttpStatus } from "../../shared/assistant-error-format.js";
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
  const classification = reason ? ({ kind: "reason", reason } as const) : null;
  return {
    reason: classification?.kind === "reason" ? classification.reason : undefined,
    code: described.code,
    provider: described.provider,
    model: described.model,
    status,
    authMode: described.authMode,
    formatFailureText: reason === "format" ? renderFormatErrorCopy(rawError) : undefined,
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
