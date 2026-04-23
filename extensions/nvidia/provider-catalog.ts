import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";

const NIM_BASE_URL = "https://integrate.api.nvidia.com/v1";
const NIM_DEFAULT_MAX_TOKENS = 4096;
const NIM_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export function buildNimProvider(): ModelProviderConfig {
  return {
    baseUrl: NIM_BASE_URL,
    api: "openai-completions",
    models: [
      {
        id: "nvidia/llama-3.1-nemotron-70b-instruct",
        name: "Llama 3.1 Nemotron 70B",
        reasoning: false,
        input: ["text"],
        cost: NIM_DEFAULT_COST,
        contextWindow: 131072,
        maxTokens: NIM_DEFAULT_MAX_TOKENS,
      },
      {
        id: "meta/llama-3.1-405b-instruct",
        name: "Meta Llama 3.1 405B Instruct",
        reasoning: false,
        input: ["text"],
        cost: NIM_DEFAULT_COST,
        contextWindow: 131072,
        maxTokens: NIM_DEFAULT_MAX_TOKENS,
      },
      {
        id: "meta/llama-3.1-70b-instruct",
        name: "Meta Llama 3.1 70B Instruct",
        reasoning: false,
        input: ["text"],
        cost: NIM_DEFAULT_COST,
        contextWindow: 131072,
        maxTokens: NIM_DEFAULT_MAX_TOKENS,
      },
      {
        id: "mistralai/mixtral-8x22b-instruct-v0.1",
        name: "Mistral Mixtral 8x22B",
        reasoning: false,
        input: ["text"],
        cost: NIM_DEFAULT_COST,
        contextWindow: 65536,
        maxTokens: NIM_DEFAULT_MAX_TOKENS,
      },
    ],
  };
}
