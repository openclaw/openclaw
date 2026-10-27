import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const DEEPSEEK_API_ORIGIN = new URL(manifest.modelCatalog.providers.deepseek.baseUrl).origin;

function isDeepSeekApiUrl(value: string | undefined): boolean {
  // Bundled provider overlays omit baseUrl or keep an empty sentinel for the catalog default.
  const baseUrl = value?.trim();
  if (!baseUrl) {
    return true;
  }
  const url = URL.parse(baseUrl);
  if (!url || url.protocol !== "https:" || url.username || url.password) {
    return false;
  }
  // A fully qualified trailing dot names the same host.
  url.hostname = url.hostname.replace(/\.$/, "");
  return url.origin === DEEPSEEK_API_ORIGIN;
}

/** Raw model-provider key (SecretRefs intact) when DeepSeek search may reuse it. */
export function resolveDeepSeekModelKeyFallback(config?: OpenClawConfig) {
  const value = config?.models?.providers?.deepseek?.apiKey;
  if (value === undefined) {
    return undefined;
  }
  // Chat may send the provider key over any variant entry's or model's route, so check them all.
  const usesDeepSeekApi = Object.entries(config?.models?.providers ?? {})
    .filter(([id]) => normalizeProviderId(id) === "deepseek")
    .every(
      ([, entry]) =>
        isDeepSeekApiUrl(entry.baseUrl) &&
        (entry.models ?? []).every((model) => isDeepSeekApiUrl(model.baseUrl)),
    );
  return usesDeepSeekApi ? { path: "models.providers.deepseek.apiKey", value } : undefined;
}
