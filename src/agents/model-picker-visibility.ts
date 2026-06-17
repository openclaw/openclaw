/**
 * Filters provider/model refs for model picker visibility.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listCliRuntimeProviderIds } from "./cli-backends.js";

// Retired provider ids and CLI runtime aliases are implementation surfaces, not
// model picker choices. Hide them while keeping real provider/model refs visible.
const RETIRED_MODEL_PICKER_PROVIDERS = new Set(["codex", "codex-cli"]);

/** True for retired provider ids that should stay out of model selection surfaces. */
export function isRetiredModelPickerProvider(provider: string): boolean {
  return RETIRED_MODEL_PICKER_PROVIDERS.has(normalizeProviderId(provider));
}

/** Creates a provider visibility predicate for model picker rendering. */
export function createModelPickerVisibleProviderPredicate(
  params: { config?: OpenClawConfig; env?: NodeJS.ProcessEnv; includeSetupRegistry?: boolean } = {},
): (provider: string) => boolean {
  const cliRuntimeProviders = new Set(
    listCliRuntimeProviderIds({
      config: params.config,
      env: params.env,
      includeSetupRegistry: params.includeSetupRegistry ?? false,
    }),
  );
  return (provider: string): boolean => {
    const normalized = normalizeProviderId(provider);
    return !isRetiredModelPickerProvider(normalized) && !cliRuntimeProviders.has(normalized);
  };
}
