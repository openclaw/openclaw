import {
  buildManifestModelProviderConfig,
  applyProviderNativeStreamingUsageCompat,
  supportsNativeStreamingUsageCompat,
} from "openclaw/plugin-sdk/provider-catalog-shared";
import type {
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  normalizeModelCompat,
  type ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

export const MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1";
export const MOONSHOT_CN_BASE_URL = "https://api.moonshot.cn/v1";
export const MOONSHOT_DEFAULT_MODEL_ID = "kimi-k2.6";

export function isNativeMoonshotBaseUrl(baseUrl: string | undefined): boolean {
  return supportsNativeStreamingUsageCompat({
    providerId: "moonshot",
    baseUrl,
  });
}

export function applyMoonshotNativeStreamingUsageCompat(
  provider: ModelProviderConfig,
): ModelProviderConfig {
  return applyProviderNativeStreamingUsageCompat({
    providerId: "moonshot",
    providerConfig: provider,
  });
}

export function buildMoonshotProvider(): ModelProviderConfig {
  return buildManifestModelProviderConfig({
    providerId: "moonshot",
    catalog: manifest.modelCatalog.providers.moonshot,
  });
}

export function resolveMoonshotDynamicModel(ctx: ProviderResolveDynamicModelContext) {
  const providerConfig = ctx.providerConfig;
  const provider = buildMoonshotProvider();
  const model = provider.models.find((candidate) => candidate.id === ctx.modelId);
  if (!model) {
    return undefined;
  }

  return normalizeModelCompat({
    ...model,
    provider: ctx.provider,
    api: providerConfig?.api ?? provider.api,
    baseUrl: providerConfig?.baseUrl ?? provider.baseUrl,
  } as ProviderRuntimeModel);
}
