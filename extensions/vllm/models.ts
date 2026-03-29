import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { VLLM_DEFAULT_BASE_URL, VLLM_PROVIDER_LABEL } from "./defaults.js";

type ModelsConfig = NonNullable<OpenClawConfig["models"]>;
type ProviderConfig = NonNullable<ModelsConfig["providers"]>[string];

export async function buildVllmProvider(params?: {
  baseUrl?: string;
  apiKey?: string;
}): Promise<ProviderConfig> {
  // Dynamic import avoids a circular load-time dependency:
  // vllm/models.ts -> provider-setup -> vllm facade -> loadBundledPlugin(vllm/api.ts) -> vllm/models.ts
  const { discoverOpenAICompatibleLocalModels } =
    await import("openclaw/plugin-sdk/provider-setup");
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
