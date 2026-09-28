import type { Model, Usage } from "../../llm.js";
import type { AgentMessage } from "../../types.js";
import type { SessionTreeEntry } from "../types.js";

export function createCompactionModel({
  id = "summary-model",
  name = "Summary Model",
  reasoning = false,
  contextWindow = 100_000,
  maxTokens = 8_000,
}: Partial<
  Pick<Model, "id" | "name" | "reasoning" | "contextWindow" | "maxTokens">
> = {}): Model & { contextWindow: number } {
  return {
    id,
    name,
    api: "test-api",
    provider: "test-provider",
    baseUrl: "https://example.test",
    reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
}

export function createContextUsage(totalTokens: number): Usage {
  return {
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    contextUsage: { state: "available", promptTokens: totalTokens, totalTokens },
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function createMessageEntry(message: AgentMessage, index: number): SessionTreeEntry {
  return {
    type: "message",
    id: `entry-${index}`,
    parentId: index === 0 ? null : `entry-${index - 1}`,
    timestamp: new Date(message.timestamp).toISOString(),
    message,
  };
}
