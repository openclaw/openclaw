import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export function hasConfiguredProviderModelRows(cfg: OpenClawConfig): boolean {
  const providers = cfg.models?.providers;
  if (!providers || typeof providers !== "object") {
    return false;
  }
  return Object.values(providers).some(
    (provider) => provider.type !== "decision" && Array.isArray(provider?.models),
  );
}

export function hasConfiguredProviderRowsNeedingManifestLookup(cfg: OpenClawConfig): boolean {
  const providers = cfg.models?.providers;
  if (!providers || typeof providers !== "object") {
    return false;
  }
  return Object.entries(providers).some(
    ([providerRaw, provider]) =>
      provider.type !== "decision" &&
      Array.isArray(provider?.models) &&
      normalizeProviderId(providerRaw) !== "openai",
  );
}
