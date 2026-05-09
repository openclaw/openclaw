import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import type { ProviderDiscoveryContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildOllamaProvider,
  type OllamaModelWithContext,
} from "../../ollama/api.js";
import { LEMONADE_DEFAULT_BASE_URL } from "./defaults.js";

export const LEMONADE_PROVIDER_ID = "lemonade";
export const LEMONADE_DEFAULT_API_KEY = "lemonade-local";

export interface LemonadePluginConfig {
  discovery?: {
    enabled?: boolean;
  };
}

export function shouldUseSyntheticLemonadeAuth(
  providerConfig: ModelProviderConfig | undefined,
): boolean {
  if (providerConfig?.apiKey) {
    return false;
  }
  const baseUrl = providerConfig?.baseUrl?.trim();
  if (!baseUrl) {
    return true;
  }
  const normalizedUrl = baseUrl.toLowerCase();
  return (
    normalizedUrl.startsWith("http://127.0.0.1:13305") ||
    normalizedUrl.startsWith("http://localhost:13305") ||
    normalizedUrl.startsWith("http://host.docker.internal:13305")
  );
}

export async function resolveLemonadeDiscoveryResult(params: {
  ctx: ProviderDiscoveryContext;
  pluginConfig: LemonadePluginConfig;
  buildProvider: (
    baseUrl: string | undefined,
    opts?: { quiet?: boolean },
  ) => Promise<ModelProviderConfig & { models: OllamaModelWithContext[] }>;
}) {
  const { ctx, pluginConfig } = params;
  if (pluginConfig.discovery?.enabled === false) {
    return undefined;
  }
  const envKey = process.env.LEMONADE_API_KEY?.trim();
  const existingProviderConfig = ctx.config.models?.providers?.[LEMONADE_PROVIDER_ID];

  // For pure local Lemonade, always attempt discovery at default URL
  try {
    const baseUrl = existingProviderConfig?.baseUrl ?? LEMONADE_DEFAULT_BASE_URL;
    const provider = await buildOllamaProvider(baseUrl, { quiet: true });

    // Only return if we found models, otherwise skip
    if (!provider.models || provider.models.length === 0) {
      return undefined;
    }

    // Prefix model IDs with "lemonade/" so they're recognized as Lemonade models
    const lemonadeModels = provider.models.map((model) => ({
      ...model,
      id: `${LEMONADE_PROVIDER_ID}/${model.id}`,
    }));

    return {
      provider: {
        ...provider,
        models: lemonadeModels,
        apiKey: envKey || existingProviderConfig?.apiKey || LEMONADE_DEFAULT_API_KEY,
      },
    };
  } catch {
    return undefined;
  }
}
