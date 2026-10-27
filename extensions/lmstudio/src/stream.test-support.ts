import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
type StreamModel = Parameters<StreamFn>[0];

export function listedModel(
  key: string,
  max_context_length: number,
  loaded_instances = [{ id: key, config: { context_length: 4096 } }],
) {
  return { models: [{ type: "llm", key, max_context_length, loaded_instances }] };
}

export function streamModel(baseUrl: string, overrides: Partial<StreamModel> = {}): StreamModel {
  return {
    id: "qwen3.5-0.8b",
    name: "Test model",
    provider: "lmstudio",
    api: "openai-completions",
    baseUrl,
    contextWindow: 262144,
    contextTokens: 16384,
    maxTokens: 8192,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  };
}
