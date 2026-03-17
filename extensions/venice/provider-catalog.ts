import { discoverVeniceModels, VENICE_BASE_URL } from "../../src/agents/venice-models.js";
import type { ModelProviderConfig } from "../../src/config/types.models.js";

export async function buildVeniceProvider(): Promise<ModelProviderConfig> {
  const models = await discoverVeniceModels();
  return {
    baseUrl: VENICE_BASE_URL,
    api: "openai-completions",
    models,
  };
}
