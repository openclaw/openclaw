import type { AssistantMessage } from "../../llm/types.js";
import { isTerminalAssistantError } from "../../llm/utils/retry.js";
import { extractErrorHttpStatus } from "../../shared/assistant-error-format.js";
import { failoverReasonFromClassification } from "../failover/classification-rules.js";
import {
  classifyFailoverSignal,
  isAuthErrorMessage,
  isBillingErrorMessage,
  isRateLimitErrorMessage,
} from "../failover/classify.js";
import type { PreparedProviderFailoverOwner } from "../failover/provider-patterns.js";
import { resolveRetryAfterMs } from "../failover/retry-evidence.js";
import { extractFailoverSignalDetails } from "../failover/signal-details.js";
import type { FailoverReason, FailoverSignal } from "../failover/signal.js";
export function buildAssistantFailoverSignal(
  msg: AssistantMessage,
  opts?: { provider?: string },
): FailoverSignal {
  const transportStatus = extractErrorHttpStatus(msg.errorMessage?.trim() ?? "")?.code;
  const provider = opts?.provider ?? msg.provider;
  const textRetryAfterMs = resolveRetryAfterMs(msg.errorMessage, Date.now(), msg.errorBody);
  const retryAfterMs =
    msg.retryAfterMs === null
      ? Infinity
      : msg.retryAfterMs === undefined
        ? textRetryAfterMs
        : Math.max(msg.retryAfterMs, textRetryAfterMs ?? 0);
  return {
    status: transportStatus,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    code: msg.errorCode,
    // The trusted producer validates this assertion before diagnostic body clipping.
    quotaScope: msg.quotaScope,
    errorType: msg.errorType,
    message: msg.errorMessage?.trim() || undefined,
    provider,
    details: extractFailoverSignalDetails(msg.errorBody),
  };
}
export function classifyAssistantFailoverReason(
  msg: AssistantMessage | undefined,
  opts?: { provider?: string; providerOwner?: PreparedProviderFailoverOwner | null },
): FailoverReason | null {
  if (!msg || msg.stopReason !== "error" || isTerminalAssistantError(msg)) {
    return null;
  }
  // Runtime preparation carries the resolved owner here so packaged runs do
  // not rediscover provider policy through a source-relative loader.
  const providerOwner = opts?.providerOwner;
  const classification = classifyFailoverSignal(
    buildAssistantFailoverSignal(msg, { provider: providerOwner?.id ?? opts?.provider }),
    { providerPlugin: providerOwner },
  );
  return failoverReasonFromClassification(classification);
}
export function isRateLimitAssistantError(msg: AssistantMessage | undefined): boolean {
  return msg?.stopReason === "error" && isRateLimitErrorMessage(msg.errorMessage ?? "");
}
export function isBillingAssistantError(msg: AssistantMessage | undefined): boolean {
  return msg?.stopReason === "error" && isBillingErrorMessage(msg.errorMessage ?? "");
}
export function isAuthAssistantError(msg: AssistantMessage | undefined): boolean {
  return msg?.stopReason === "error" && isAuthErrorMessage(msg.errorMessage ?? "");
}
export function isFailoverAssistantError(msg: AssistantMessage | undefined): boolean {
  return classifyAssistantFailoverReason(msg) !== null;
}
