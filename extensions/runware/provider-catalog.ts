// Runware plugin module implements provider catalog behavior.
import { getCachedLiveProviderModelRows } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { ssrfPolicyFromHttpBaseUrlAllowedHostname } from "openclaw/plugin-sdk/ssrf-runtime";
import { parseRunwareModelRow, RUNWARE_BASE_URL, RUNWARE_FALLBACK_MODELS } from "./models.js";

const log = createSubsystemLogger("runware-models");
const RUNWARE_DISCOVERY_TIMEOUT_MS = 10_000;
const RUNWARE_DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000;

// Runware returns { object: "list", data: [...] }; the default row reader
// (readDefaultLiveModelCatalogRows) already unwraps that shape.
async function fetchRunwareModelRows(apiKey: string): Promise<readonly unknown[]> {
  return await getCachedLiveProviderModelRows({
    providerId: "runware",
    endpoint: `${RUNWARE_BASE_URL}/models`,
    discoveryApiKey: apiKey,
    timeoutMs: RUNWARE_DISCOVERY_TIMEOUT_MS,
    ttlMs: RUNWARE_DISCOVERY_CACHE_TTL_MS,
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(RUNWARE_BASE_URL),
    auditContext: "runware-model-discovery",
  });
}

export async function discoverRunwareModels(apiKey: string) {
  try {
    const rows = await fetchRunwareModelRows(apiKey);
    const models = rows.flatMap((row) => parseRunwareModelRow(row) ?? []);
    if (models.length === 0) {
      log.warn("No models in Runware /v1/models response, using illustrative fallback");
      return RUNWARE_FALLBACK_MODELS;
    }
    return models;
  } catch (error) {
    log.warn(`Runware model discovery failed: ${String(error)}, using illustrative fallback`);
    return RUNWARE_FALLBACK_MODELS;
  }
}

export async function buildRunwareProvider(apiKey: string): Promise<ModelProviderConfig> {
  return {
    baseUrl: RUNWARE_BASE_URL,
    api: "openai-completions",
    models: await discoverRunwareModels(apiKey),
  };
}

export function buildStaticRunwareProvider(): ModelProviderConfig {
  return {
    baseUrl: RUNWARE_BASE_URL,
    api: "openai-completions",
    models: RUNWARE_FALLBACK_MODELS,
  };
}
