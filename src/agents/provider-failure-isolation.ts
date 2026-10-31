/**
 * Model catalog work calls one provider's plugin hooks at a time. A failing hook owns only its
 * providers: they become unavailable and the caller continues with the next provider.
 */
import { isUnresolvedSecretInputError } from "../config/types.secrets.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { ProviderCatalogOutcome } from "../plugins/provider-catalog.types.js";
import { isPreparedModelRuntimePluginLifecycleFailure } from "./prepared-model-runtime-admission-errors.js";

const log = createSubsystemLogger("models/provider-isolation");

export type ProviderFailureScope = {
  providerIds: readonly string[];
  /** Short name of the catalog step, for the warning. */
  stage: string;
  signal?: AbortSignal;
  reportCatalogOutcome?: (outcome: ProviderCatalogOutcome) => void;
};

/**
 * Request cancellation, a retired plugin generation, or an unresolved config secret invalidates
 * the whole request rather than one provider.
 */
export function isRequestWideFailure(error: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true ||
    isPreparedModelRuntimePluginLifecycleFailure(error) ||
    isUnresolvedSecretInputError(error)
  );
}

/** Rethrows request-wide failures; otherwise records the scope's providers as unavailable. */
export function skipFailedProvider(error: unknown, scope: ProviderFailureScope): void {
  if (isRequestWideFailure(error, scope.signal)) {
    throw error;
  }
  for (const provider of scope.providerIds) {
    scope.reportCatalogOutcome?.({ provider, status: "unavailable" });
  }
  log.warn(
    `${scope.stage} failed for ${scope.providerIds.join(", ")}: ${formatErrorMessage(error)}; skipping provider`,
  );
}

export function runProviderIsolatedSync<T>(
  scope: ProviderFailureScope,
  run: () => T,
): T | undefined {
  try {
    return run();
  } catch (error) {
    skipFailedProvider(error, scope);
    return undefined;
  }
}

export async function runProviderIsolated<T>(
  scope: ProviderFailureScope,
  run: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    skipFailedProvider(error, scope);
    return undefined;
  }
}
