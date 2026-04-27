import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { discoverOpenAICompatibleLocalModels } from "openclaw/plugin-sdk/provider-setup";
import {
  MLX_OPENAI_SERVER_DEFAULT_BASE_URL,
  MLX_OPENAI_SERVER_PROVIDER_LABEL,
} from "./defaults.js";

type ModelsConfig = NonNullable<OpenClawConfig["models"]>;
type ProviderConfig = NonNullable<ModelsConfig["providers"]>[string];

export async function buildMlxOpenaiServerProvider(params?: {
  baseUrl?: string;
  apiKey?: string;
}): Promise<ProviderConfig> {
  const baseUrl = (params?.baseUrl?.trim() || MLX_OPENAI_SERVER_DEFAULT_BASE_URL).replace(
    /\/+$/,
    "",
  );
  const models = await discoverOpenAICompatibleLocalModels({
    baseUrl,
    apiKey: params?.apiKey,
    label: MLX_OPENAI_SERVER_PROVIDER_LABEL,
  });
  return {
    baseUrl,
    api: "openai-completions",
    models,
  };
}
