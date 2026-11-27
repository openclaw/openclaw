import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-entry";
import {
  OLLAMA_CLOUD_DEFAULT_MODELS,
  OLLAMA_CLOUD_PROVIDER_ID,
  OLLAMA_DEFAULT_API_KEY,
} from "./defaults.js";

export function createOllamaCloudAuthMethod() {
  return createProviderApiKeyAuthMethod({
    providerId: OLLAMA_CLOUD_PROVIDER_ID,
    methodId: "api-key",
    label: "Ollama Cloud API key",
    hint: "Hosted models via ollama.com",
    optionKey: "ollamaCloudApiKey",
    flagName: "--ollama-cloud-api-key",
    envVar: "OLLAMA_API_KEY",
    promptMessage: "Enter Ollama Cloud API key",
    validateApiKey: (apiKey) =>
      apiKey.trim() === OLLAMA_DEFAULT_API_KEY
        ? "Ollama Cloud requires a hosted API key from https://ollama.com/settings/keys; " +
          "ollama-local is only for local Ollama hosts."
        : undefined,
    defaultModel: `${OLLAMA_CLOUD_PROVIDER_ID}/${OLLAMA_CLOUD_DEFAULT_MODELS[0].id}`,
    noteTitle: "Ollama Cloud",
    noteMessage: "Manage API keys at https://ollama.com/settings/keys",
    wizard: {
      choiceId: "ollama-cloud",
      choiceLabel: "Ollama Cloud",
      choiceHint: "Hosted models via ollama.com",
      groupId: "ollama",
      groupLabel: "Ollama",
      groupHint: "Cloud and local open models",
    },
  });
}
