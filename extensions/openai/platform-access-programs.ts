import type { ProviderCatalogOutcome } from "openclaw/plugin-sdk/provider-catalog-shared";
import { OPENAI_API_BASE_URL, resolveOpenAICodexModelsEndpoint } from "./base-url.js";
import { readCodexModelRows } from "./codex-model-rows.js";
import {
  readOpenAIModelAccessPrograms,
  readOpenAIModelServiceTiers,
} from "./model-service-tiers.js";

/**
 * Codex uses this same read-only endpoint with Platform API keys. Public /v1/models
 * lists models, not program grants or service tiers; keep that endpoint as the inventory owner.
 */
export async function discoverOpenAIPlatformModelCapabilities(params: {
  apiKey: string;
}): Promise<Pick<ProviderCatalogOutcome, "modelAccessPrograms" | "modelServiceTiers"> | undefined> {
  const { getCachedLiveCatalogValue } = await import("openclaw/plugin-sdk/provider-catalog-shared");
  const { fetchLiveProviderModelRows } =
    await import("openclaw/plugin-sdk/provider-catalog-live-runtime");
  try {
    const endpoint = await resolveOpenAICodexModelsEndpoint();
    return await getCachedLiveCatalogValue({
      keyParts: ["openai", "platform-model-capabilities", endpoint, params.apiKey],
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
        const route = { api: "openai-responses", baseUrl: OPENAI_API_BASE_URL };
        return {
          modelAccessPrograms: readOpenAIModelAccessPrograms(rows, {
            ...route,
            runtimeIds: ["openclaw", "codex"],
          }),
          // Codex sends only the tiers a row advertises; the embedded runtime's picker follows.
          modelServiceTiers: readOpenAIModelServiceTiers(rows, {
            ...route,
            runtimeIds: ["openclaw"],
          }),
        };
      },
    });
  } catch {
    // No stale grants after an unsuccessful refresh, and no failure of ordinary
    // model discovery just because the separate capability endpoint is unavailable.
    return undefined;
  }
}
