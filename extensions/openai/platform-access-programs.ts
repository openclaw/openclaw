import type { ProviderCatalogOutcome } from "openclaw/plugin-sdk/provider-catalog-shared";
import {
  OPENAI_API_BASE_URL,
  resolveOpenAICodexModelsEndpoint,
  type OpenAICodexModelsEndpointContext,
} from "./base-url.js";
import { readCodexModelRows } from "./codex-model-rows.js";
import { readOpenAIModelAccessPrograms } from "./model-service-tiers.js";

/**
 * Codex uses this same read-only endpoint with Platform API keys. Public /v1/models
 * lists models, not program grants; keep that endpoint as the inventory owner.
 */
export async function discoverOpenAIPlatformAccessPrograms(params: {
  apiKey: string;
  catalogContext?: OpenAICodexModelsEndpointContext;
}): Promise<ProviderCatalogOutcome["modelAccessPrograms"]> {
  const { getCachedLiveCatalogValue } = await import("openclaw/plugin-sdk/provider-catalog-shared");
  const { fetchLiveProviderModelRows } =
    await import("openclaw/plugin-sdk/provider-catalog-live-runtime");
  try {
    const endpoint = await resolveOpenAICodexModelsEndpoint(params.catalogContext);
    return await getCachedLiveCatalogValue({
      keyParts: ["openai", "platform-access-programs", endpoint, params.apiKey],
      ttlMs: 60_000,
      load: async (signal) => {
        const rows = await fetchLiveProviderModelRows({
          providerId: "openai",
          endpoint,
          discoveryApiKey: params.apiKey,
          signal,
          auditContext: "openai-access-program-discovery",
          readRows: readCodexModelRows,
        });
        return readOpenAIModelAccessPrograms(rows, {
          api: "openai-responses",
          baseUrl: OPENAI_API_BASE_URL,
          // Native Codex's API-key program forwarding is not supported here.
          runtimeIds: ["openclaw"],
        });
      },
    });
  } catch {
    // No stale grants after an unsuccessful refresh, and no failure of ordinary
    // model discovery just because the separate capability endpoint is unavailable.
    return undefined;
  }
}
