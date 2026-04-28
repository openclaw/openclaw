import { type RetryRunner, createProviderApiRetryRunner } from "../infra/retry-policy.js";
import type { RetryConfig } from "../infra/retry.js";
import { normalizeProviderId } from "./provider-id.js";

/**
 * Module-scoped registry mapping provider IDs to retry runners.
 * Populated when provider configs are resolved; consumed by transport
 * layers to wrap LLM API calls with retry on transient failures.
 *
 * IDs are stored in canonical form (`normalizeProviderId`) so that
 * registration via a config-file key (e.g. `"OpenAI"`, `"z.ai"`,
 * `"modelstudio"`) matches lookups via `model.provider` (which the
 * runtime gives in raw form, with case and aliases preserved).
 */
const providerRetryRunners = new Map<string, RetryRunner>();

export function registerProviderRetryConfig(providerId: string, retry: RetryConfig): void {
  providerRetryRunners.set(
    normalizeProviderId(providerId),
    createProviderApiRetryRunner({ retry }),
  );
}

export function getProviderRetryRunner(providerId: string): RetryRunner | undefined {
  return providerRetryRunners.get(normalizeProviderId(providerId));
}

export function clearProviderRetryRunners(): void {
  providerRetryRunners.clear();
}
