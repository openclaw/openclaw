import { classifyGatewayStorageFailure } from "../../infra/sqlite-error-diagnostics.js";
import {
  extractErrorHttpStatus,
  formatTransportErrorCopy,
} from "../../shared/assistant-error-format.js";
import { modelKey } from "../../shared/model-key.js";
import { describeFailoverError } from "../failover-error.js";
import {
  renderAssistantRequestFailureCopy,
  renderFormatErrorCopy,
} from "./assistant-request-failure-copy.js";
import { classifyFailoverReason } from "./classify.js";
import { isFailoverError } from "./error.js";
import { classifyProviderRequestFacets } from "./request-error-facets.js";
import { resolveProviderRequestFailureCopy } from "./user-copy.js";

// With fallbacks or several providers configured, the connection copy alone does not say which
// service is down. A fallback summary carries the last attempt's model while its message joins
// every attempt's error, so name only the models whose own attempt failed to connect.
function resolveConnectionFailureModels(
  error: unknown,
  described: { provider?: string; model?: string },
): string {
  const attempts = isFailoverError(error) ? error.attempts : undefined;
  if (!attempts?.length) {
    return modelKey(described.provider ?? "", described.model ?? "");
  }
  const refs = attempts
    .filter((attempt) =>
      formatTransportErrorCopy([attempt.error, attempt.code].filter(Boolean).join(" ")),
    )
    .map((attempt) => modelKey(attempt.provider, attempt.model))
    .filter(Boolean);
  return [...new Set(refs)].join(", ");
}

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
  const failedModels = transportCopy ? resolveConnectionFailureModels(error, described) : "";
  const classification = reason ? ({ kind: "reason", reason } as const) : null;
  const storageCopy = renderAssistantRequestFailureCopy({
    storageFailure: classifyGatewayStorageFailure(error),
  });
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
          ? `⚠️ ${failedModels ? `${failedModels} request failed: ` : ""}${transportCopy} Check the conversation for any completed work before trying again.`
          : undefined),
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
