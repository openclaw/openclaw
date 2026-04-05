import type { RetryConfig } from "../infra/retry.js";
import {
  type RetryRunner,
  createProviderApiRetryRunner,
} from "../infra/retry-policy.js";

/**
 * Module-scoped registry mapping provider IDs to retry runners.
 * Populated when provider configs are resolved; consumed by transport
 * layers to wrap LLM API calls with retry on transient failures.
 */
const providerRetryRunners = new Map<string, RetryRunner>();

export function registerProviderRetryConfig(providerId: string, retry: RetryConfig): void {
  providerRetryRunners.set(
    providerId,
    createProviderApiRetryRunner({ retry }),
  );
}

export function getProviderRetryRunner(providerId: string): RetryRunner | undefined {
  return providerRetryRunners.get(providerId);
}

export function clearProviderRetryRunners(): void {
  providerRetryRunners.clear();
}
