import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildNvidiaModelDefinition,
  discoverNvidiaModels,
  NVIDIA_BASE_URL,
  NVIDIA_CATALOGED_MODELS,
} from "./models.js";

export {
  buildNvidiaModelDefinition,
  discoverNvidiaModels,
  NVIDIA_BASE_URL,
  NVIDIA_CATALOGED_MODELS,
} from "./models.js";

export async function buildNvidiaProvider(discoveryApiKey?: string): Promise<ModelProviderConfig> {
  const resolvedSecret = discoveryApiKey?.trim() ?? "";
  const models =
    resolvedSecret !== ""
      ? await discoverNvidiaModels(resolvedSecret)
      : NVIDIA_CATALOGED_MODELS.map(buildNvidiaModelDefinition);
  return {
    baseUrl: NVIDIA_BASE_URL,
    api: "openai-completions",
    models,
  };
}
