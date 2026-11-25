import { findNormalizedProviderValue } from "@openclaw/model-catalog-core/provider-id";
import type { AuthProfileStore } from "./types.js";

/** Shares stored-over-config order precedence with CLI runtime selection. */
export function resolveExplicitAuthOrderSelection(params: {
  storeOrder: AuthProfileStore["order"] | undefined;
  configuredOrder: Record<string, string[]> | undefined;
  providerKey: string;
  providerAuthKey: string;
}): {
  order: string[] | undefined;
  fromStore: boolean;
} {
  const { storeOrder, configuredOrder, providerKey, providerAuthKey } = params;
  const stored =
    findNormalizedProviderValue(storeOrder, providerAuthKey) ??
    findNormalizedProviderValue(storeOrder, providerKey);
  return {
    order:
      stored ??
      findNormalizedProviderValue(configuredOrder, providerAuthKey) ??
      findNormalizedProviderValue(configuredOrder, providerKey),
    fromStore: stored !== undefined,
  };
}
