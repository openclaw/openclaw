import { parseApiErrorInfo } from "../../shared/assistant-error-format.js";

const REQUEST_AFFORDABILITY_USER_MESSAGE =
  "⚠️ This request exceeds the available credit or spending allowance. Reduce the maximum output tokens (`max_tokens`), or check your account balance and key spending limit before trying again.";
const KEY_SPENDING_LIMIT_USER_MESSAGE =
  "⚠️ The AI service reported that this API key has reached its spending limit. Check or increase the key spending limit, or choose another authorized key before trying again.";

/** Select safe billing remedies without changing classification or exposing provider diagnostics. */
export function renderBillingErrorDetail(raw?: string): string | undefined {
  const message = parseApiErrorInfo(raw)?.message ?? raw ?? "";
  // Prepared remedies re-enter reply normalization; keep their distinction.
  if (
    message === REQUEST_AFFORDABILITY_USER_MESSAGE ||
    message === KEY_SPENDING_LIMIT_USER_MESSAGE
  ) {
    return message;
  }
  if (/\bfewer\s+max_tokens\b|\bcan only afford\s+\d+/i.test(message)) {
    return REQUEST_AFFORDABILITY_USER_MESSAGE;
  }
  if (
    /\b(?:api[ -]?)?key (?:spending |spend |budget )?limit (?:exceeded|reached|hit)\b/i.test(
      message,
    )
  ) {
    return KEY_SPENDING_LIMIT_USER_MESSAGE;
  }
  return undefined;
}

/** Format billing copy with optional provider/model and credential context. */
export function formatBillingErrorMessage(
  provider?: string,
  model?: string,
  authMode?: string,
  raw?: string,
): string {
  const detail = renderBillingErrorDetail(raw);
  if (detail) {
    return detail;
  }
  const providerName = provider?.trim();
  const modelName = model?.trim();
  const providerLabel =
    providerName && modelName ? `${providerName} (${modelName})` : providerName || undefined;
  const isSubscriptionAuth = authMode === "oauth" || authMode === "token";
  if (isSubscriptionAuth) {
    return `⚠️ ${providerLabel ?? "API provider"} returned a billing error — check your account for subscription or usage limits, then try again.`;
  }
  return providerLabel
    ? `⚠️ ${providerLabel} returned a billing error — check your account's balance and usage limits before trying again.`
    : "⚠️ The AI service reported a billing problem. Check your account's credit balance and usage limits before trying again.";
}
