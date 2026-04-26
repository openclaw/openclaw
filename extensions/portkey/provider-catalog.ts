import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { buildPortkeyModelDefinition, PORTKEY_BASE_URL } from "./onboard.js";

export function buildPortkeyProvider(): ModelProviderConfig {
  return {
    baseUrl: PORTKEY_BASE_URL,
    api: "openai-completions",
    models: [buildPortkeyModelDefinition()],
  };
}
