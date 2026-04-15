import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { QINIU_BASE_URL, discoverQiniuModels } from "./models.js";

export async function buildQiniuProvider(apiKey?: string): Promise<ModelProviderConfig> {
  return {
    baseUrl: QINIU_BASE_URL,
    api: "openai-completions",
    models: await discoverQiniuModels(apiKey),
  };
}
