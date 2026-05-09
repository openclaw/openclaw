import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { ProviderAuthMethodNonInteractiveContext } from "openclaw/plugin-sdk/plugin-entry";
import { LEMONADE_DEFAULT_BASE_URL, LEMONADE_DEFAULT_MODEL } from "./defaults.js";
import { LEMONADE_PROVIDER_ID } from "./discovery-shared.js";

export async function configureLemonadeNonInteractive(params: {
  nextConfig: OpenClawConfig;
  opts: {
    customBaseUrl?: string;
    customModelId?: string;
  };
  runtime: ProviderAuthMethodNonInteractiveContext["runtime"];
  agentDir: string;
}): Promise<OpenClawConfig> {
  const baseUrl = params.opts.customBaseUrl ?? LEMONADE_DEFAULT_BASE_URL;
  const modelId = params.opts.customModelId ?? LEMONADE_DEFAULT_MODEL;

  return {
    ...params.nextConfig,
    models: {
      ...params.nextConfig.models,
      providers: {
        ...params.nextConfig.models?.providers,
        [LEMONADE_PROVIDER_ID]: {
          baseUrl,
          models: [],
        },
      },
      modelId: `${LEMONADE_PROVIDER_ID}/${modelId}`,
    },
  };
}
