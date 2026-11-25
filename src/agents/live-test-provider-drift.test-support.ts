import { shouldSkipLiveProviderDrift } from "./live-test-provider-drift.js";

export function isLiveAuthDrift(error: unknown): boolean {
  return shouldSkipLiveProviderDrift({ allowAuth: true, error })?.reason === "auth";
}

export function isLiveBillingDrift(error: unknown): boolean {
  return shouldSkipLiveProviderDrift({ allowBilling: true, error })?.reason === "billing";
}

export function isLiveRateLimitDrift(error: unknown): boolean {
  return shouldSkipLiveProviderDrift({ allowRateLimit: true, error })?.reason === "rate-limit";
}

export function isLiveProviderUnavailableDrift(error: unknown): boolean {
  return (
    shouldSkipLiveProviderDrift({ allowProviderUnavailable: true, error })?.reason ===
    "provider-unavailable"
  );
}

export function isChatGPTUsageLimitErrorMessage(raw: string): boolean {
  const msg = raw.toLowerCase();
  return msg.includes("hit your chatgpt usage limit") && msg.includes("try again in");
}

export function isOllamaUnavailableErrorMessage(raw: string): boolean {
  const msg = raw.toLowerCase();
  return (
    msg.includes("ollama could not be reached") ||
    (msg.includes("127.0.0.1:11434") && msg.includes("econnrefused")) ||
    (msg.includes("localhost:11434") && msg.includes("econnrefused"))
  );
}

export function isAudioOnlyModelErrorMessage(raw: string): boolean {
  return /requires that either input content or output modality contain audio/i.test(raw);
}

export function isUnsupportedThinkingToggleErrorMessage(raw: string): boolean {
  return /does not support parameter [`"]?enable_thinking[`"]?/i.test(raw);
}
