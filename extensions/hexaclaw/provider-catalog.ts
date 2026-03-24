import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-models";

const HEXACLAW_BASE_URL = "https://api.hexaclaw.com/v1";

export { HEXACLAW_BASE_URL };

export function buildHexaclawProvider(): ModelProviderConfig {
  return {
    baseUrl: HEXACLAW_BASE_URL,
    api: "openai-completions",
    models: [
      // Anthropic via HexaClaw
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 3.3, output: 16.5, cacheRead: 0.33, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 16384,
      },
      {
        id: "claude-haiku-4-5",
        name: "Claude Haiku 4.5",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 1.2, output: 6.0, cacheRead: 0.12, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      },
      // Google via HexaClaw
      {
        id: "gemini-2.5-flash",
        name: "Gemini 2.5 Flash",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0.36, output: 3.0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1048576,
        maxTokens: 65536,
      },
      {
        id: "gemini-2.5-pro",
        name: "Gemini 2.5 Pro",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 1.38, output: 11.0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1048576,
        maxTokens: 65536,
      },
      // OpenAI via HexaClaw
      {
        id: "gpt-4.1",
        name: "GPT-4.1",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 2.2, output: 8.8, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1047576,
        maxTokens: 32768,
      },
      {
        id: "gpt-4.1-mini",
        name: "GPT-4.1 Mini",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0.48, output: 1.92, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1047576,
        maxTokens: 16384,
      },
      {
        id: "o3",
        name: "o3",
        reasoning: true,
        input: ["text", "image"],
        // HexaClaw gateway pricing; upstream OpenAI cost may differ
        cost: { input: 2.2, output: 8.8, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 100000,
      },
      {
        id: "o4-mini",
        name: "o4-mini",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 1.21, output: 4.84, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 100000,
      },
      // DeepSeek via HexaClaw
      {
        id: "deepseek-chat",
        name: "DeepSeek V3",
        reasoning: false,
        input: ["text"],
        cost: { input: 0.34, output: 0.51, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      },
      {
        id: "deepseek-reasoner",
        name: "DeepSeek R1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0.61, output: 2.41, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      },
      // Mistral via HexaClaw
      {
        id: "mistral-large-latest",
        name: "Mistral Large",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 2.2, output: 6.6, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 32768,
      },
      // Groq via HexaClaw
      {
        id: "llama-3.3-70b-versatile",
        name: "Llama 3.3 70B (Groq)",
        reasoning: false,
        input: ["text"],
        cost: { input: 0.71, output: 0.95, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 32768,
      },
    ],
  };
}
