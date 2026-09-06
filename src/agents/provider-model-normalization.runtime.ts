/** Reads prepared provider hooks without activating plugins during model-reference parsing. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { findProviderRuntimePluginInRegistry } from "../plugins/provider-registry-shared.js";
import { getPluginRegistryForContext } from "../plugins/runtime-state.js";
import { getPluginRuntimeGenerationRegistry } from "../plugins/runtime/generation-state.js";
import type { ProviderNormalizeModelIdContext } from "../plugins/types.js";

/** Refines an already statically normalized model id through its provider hook. */
export function normalizeProviderModelIdWithRuntime(params: {
  provider: string;
  context: ProviderNormalizeModelIdContext;
}): string | undefined {
  // An exact generation, including an empty one, cannot borrow ambient hooks.
  const registry = getPluginRuntimeGenerationRegistry() ?? getPluginRegistryForContext();
  if (!registry) {
    return undefined;
  }
  const plugin = findProviderRuntimePluginInRegistry({
    registry,
    provider: params.provider,
    ownerRefs: [],
  });
  return normalizeOptionalString(plugin?.normalizeModelId?.(params.context));
}
