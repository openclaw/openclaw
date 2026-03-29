import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { SGLANG_DEFAULT_BASE_URL, SGLANG_PROVIDER_LABEL } from "./defaults.js";

type ModelsConfig = NonNullable<OpenClawConfig["models"]>;
type ProviderConfig = NonNullable<ModelsConfig["providers"]>[string];

export async function buildSglangProvider(params?: {
  baseUrl?: string;
  apiKey?: string;
}): Promise<ProviderConfig> {
  // Dynamic import avoids a circular load-time dependency:
  // sglang/models.ts -> provider-setup -> sglang facade -> loadBundledPlugin(sglang/api.ts) -> sglang/models.ts
  const { discoverOpenAICompatibleLocalModels } =
    await import("openclaw/plugin-sdk/provider-setup");
  const baseUrl = (params?.baseUrl?.trim() || SGLANG_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const models = await discoverOpenAICompatibleLocalModels({
    baseUrl,
    apiKey: params?.apiKey,
    label: SGLANG_PROVIDER_LABEL,
  });
  return {
    baseUrl,
    api: "openai-completions",
    models,
  };
}
