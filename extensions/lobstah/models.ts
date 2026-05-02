import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { discoverOpenAICompatibleLocalModels } from "openclaw/plugin-sdk/provider-setup";
import { LOBSTAH_DEFAULT_BASE_URL, LOBSTAH_PROVIDER_LABEL } from "./defaults.js";

type ModelsConfig = NonNullable<OpenClawConfig["models"]>;
type ProviderConfig = NonNullable<ModelsConfig["providers"]>[string];

export async function buildLobstahProvider(params?: {
  baseUrl?: string;
  apiKey?: string;
}): Promise<ProviderConfig> {
  const baseUrl = (params?.baseUrl?.trim() || LOBSTAH_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const models = await discoverOpenAICompatibleLocalModels({
    baseUrl,
    apiKey: params?.apiKey,
    label: LOBSTAH_PROVIDER_LABEL,
  });
  return {
    baseUrl,
    api: "openai-completions",
    models,
  };
}
