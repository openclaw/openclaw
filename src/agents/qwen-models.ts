import type { ModelDefinitionConfig } from "../config/types.js";

export const QWEN_DASHSCOPE_MODEL_CATALOG = [
  {
    id: "qwen-plus",
    name: "Qwen Plus",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
  {
    id: "qwen-turbo",
    name: "Qwen Turbo",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
  {
    id: "qwen-max",
    name: "Qwen Max",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
  {
    id: "qwen-coder-plus",
    name: "Qwen Coder Plus",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
  {
    id: "qwen3-coder-plus",
    name: "Qwen3 Coder Plus",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
  {
    id: "qwen3-coder-flash",
    name: "Qwen3 Coder Flash",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
  {
    id: "qwen3-max",
    name: "Qwen3 Max",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
  {
    id: "qwen3.5-plus",
    name: "Qwen3.5 Plus",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
  {
    id: "qwen-vl-plus",
    name: "Qwen Vision Plus",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
  {
    id: "qwen3-vl-plus",
    name: "Qwen3 Vision Plus",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
] as const;

export type QwenDashscopeCatalogEntry = (typeof QWEN_DASHSCOPE_MODEL_CATALOG)[number];

export function buildQwenDashscopeModelDefinition(
  entry: QwenDashscopeCatalogEntry,
): ModelDefinitionConfig {
  return {
    id: entry.id,
    name: entry.name,
    reasoning: entry.reasoning,
    input: [...entry.input],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
  };
}
