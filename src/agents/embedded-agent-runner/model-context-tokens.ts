import type { Model } from "openclaw/plugin-sdk/llm";

type AgentModelWithOptionalContextTokens = Model & {
  contextTokens?: number;
};

export function readAgentModelContextTokens(model: Model | null | undefined): number | undefined {
  const value = (model as AgentModelWithOptionalContextTokens | null | undefined)?.contextTokens;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
