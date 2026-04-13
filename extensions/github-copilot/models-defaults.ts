import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { resolveCopilotTransportApi } from "./models.js";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8192;
export const COPILOT_AUTO_MODEL_ID = "auto";

// Copilot model ids vary by plan/org and can change.
// Keep this broad and aligned with current public Copilot docs; unavailable
// models will fail at runtime and can be removed by users.
const DEFAULT_MODEL_IDS = [
  COPILOT_AUTO_MODEL_ID,
  // OpenAI
  "gpt-4.1",
  "gpt-4o",
  "gpt-5-mini",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.3-codex",
  "gpt-5.4",
  "gpt-5.4-mini",
  // Anthropic
  "claude-haiku-4.5",
  "claude-opus-4.5",
  "claude-opus-4.6",
  "claude-sonnet-4",
  "claude-sonnet-4.5",
  "claude-sonnet-4.6",
  // Google
  "gemini-2.5-pro",
  "gemini-3-flash-preview",
  "gemini-3.1-pro-preview",
  // xAI / Copilot-tuned
  "grok-code-fast-1",
  "raptor-mini",
  "goldeneye",
] as const;

export function getDefaultCopilotModelIds(): string[] {
  return [...DEFAULT_MODEL_IDS];
}

export function buildCopilotModelDefinition(modelId: string): ModelDefinitionConfig {
  const id = modelId.trim();
  if (!id) {
    throw new Error("Model id required");
  }
  return {
    id,
    name: id === COPILOT_AUTO_MODEL_ID ? "Auto" : id,
    api: resolveCopilotTransportApi(id),
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}
