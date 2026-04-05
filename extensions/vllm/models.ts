import type { MullusiConfig } from "mullusi/plugin-sdk/config-runtime";
import { discoverOpenAICompatibleLocalModels } from "mullusi/plugin-sdk/provider-setup";
import { VLLM_DEFAULT_BASE_URL, VLLM_PROVIDER_LABEL } from "./defaults.js";

type ModelsConfig = NonNullable<MullusiConfig["models"]>;
type ProviderConfig = NonNullable<ModelsConfig["providers"]>[string];

export async function buildVllmProvider(params?: {
  baseUrl?: string;
  apiKey?: string;
}): Promise<ProviderConfig> {
  const baseUrl = (params?.baseUrl?.trim() || VLLM_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const models = await discoverOpenAICompatibleLocalModels({
    baseUrl,
    apiKey: params?.apiKey,
    label: VLLM_PROVIDER_LABEL,
  });
  return {
    baseUrl,
    api: "openai-completions",
    models,
  };
}
