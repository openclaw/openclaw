/**
 * Map Copilot /models API response to OpenClaw model definitions.
 *
 * This module converts the raw Copilot API model capabilities into
 * OpenClaw's ModelDefinitionConfig format, replacing the hardcoded
 * MODEL_LIMITS table with live API data.
 */

import type { ModelApi } from "openclaw/plugin-sdk/provider-model-shared";
import type { CopilotApiModel } from "./models-api.js";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;

/**
 * Resolve OpenClaw transport API from Copilot supported_endpoints.
 *
 * Priority:
 * 1. `/v1/messages` → anthropic-messages (Claude native)
 * 2. `/responses` → openai-responses (GPT native)
 * 3. `/chat/completions` → openai-completions (fallback)
 * 4. Heuristic by model name
 */
export function resolveTransportApiFromEndpoints(
  modelId: string,
  endpoints?: string[],
): ModelApi {
  if (endpoints && endpoints.length > 0) {
    // Prefer native transports
    if (endpoints.includes("/v1/messages")) {
      return "anthropic-messages";
    }
    if (endpoints.includes("/responses")) {
      return "openai-responses";
    }
    if (endpoints.includes("/chat/completions")) {
      return "openai-completions";
    }
  }
  // Heuristic fallback
  const lower = modelId.toLowerCase();
  if (lower.includes("claude")) {
    return "anthropic-messages";
  }
  return "openai-responses";
}

/**
 * Determine the `reasoning` flag from API capabilities.
 *
 * A model is considered a "reasoning model" if it has reasoning_effort
 * entries beyond just "medium" (the default). Models with xhigh or
 * codex-style models are clearly reasoning models.
 */
export function isReasoningModel(model: CopilotApiModel): boolean {
  const id = model.id.toLowerCase();
  // Codex models are reasoning models
  if (/(?:^|[-_.])codex(?:$|[-_.])/.test(id)) {
    return true;
  }
  // o-series models (o1, o3, etc) are reasoning models
  if (/^o\d/.test(id)) {
    return true;
  }
  const effort = model.capabilities?.supports?.reasoning_effort;
  if (effort && effort.includes("xhigh")) {
    return true;
  }
  return false;
}

/**
 * Determine input modalities from API capabilities.
 */
export function resolveInputModalities(
  model: CopilotApiModel,
): Array<"text" | "image"> {
  if (model.capabilities?.supports?.vision) {
    return ["text", "image"];
  }
  // Also check if vision limits exist (some models may not set supports.vision but have vision limits)
  if (model.capabilities?.limits?.vision) {
    return ["text", "image"];
  }
  return ["text"];
}

/**
 * Filter out internal/router models that aren't useful for end users.
 */
export function isUserFacingModel(model: CopilotApiModel): boolean {
  const id = model.id;
  // Skip router-based models (internal Microsoft routing)
  if (id.startsWith("accounts/")) {
    return false;
  }
  // Skip embedding models
  if (model.capabilities?.type === "embeddings" || model.type === "embeddings") {
    return false;
  }
  return true;
}

/**
 * Deduplicate models by ID, preferring the entry with more capabilities.
 *
 * The Copilot API sometimes returns duplicate entries for the same model
 * (e.g. multiple gpt-4o with different versions). Keep the one with the
 * most useful capabilities.
 */
export function deduplicateModels(models: CopilotApiModel[]): CopilotApiModel[] {
  const seen = new Map<string, CopilotApiModel>();
  for (const model of models) {
    const existing = seen.get(model.id);
    if (!existing) {
      seen.set(model.id, model);
      continue;
    }
    // Prefer the entry with more capabilities
    const existingScore = modelCapabilityScore(existing);
    const newScore = modelCapabilityScore(model);
    if (newScore > existingScore) {
      seen.set(model.id, model);
    }
  }
  return [...seen.values()];
}

function modelCapabilityScore(model: CopilotApiModel): number {
  let score = 0;
  const supports = model.capabilities?.supports;
  if (supports?.vision) score += 1;
  if (supports?.tool_calls) score += 1;
  if (supports?.streaming) score += 1;
  if (supports?.adaptive_thinking) score += 1;
  if (supports?.reasoning_effort?.length) score += supports.reasoning_effort.length;
  const limits = model.capabilities?.limits;
  if (limits?.max_context_window_tokens) score += 1;
  if (limits?.max_output_tokens) score += 1;
  if (model.supported_endpoints?.length) score += model.supported_endpoints.length;
  return score;
}

export interface CopilotModelCapabilities {
  adaptiveThinking?: boolean;
  maxThinkingBudget?: number;
  minThinkingBudget?: number;
  reasoningEffort?: string[];
  toolCalls?: boolean;
  streaming?: boolean;
  parallelToolCalls?: boolean;
  structuredOutputs?: boolean;
}

export interface MappedCopilotModel {
  id: string;
  name: string;
  api: ModelApi;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: { input: 0; output: 0; cacheRead: 0; cacheWrite: 0 };
  compat?: {
    supportsTools?: boolean;
    supportedReasoningEfforts?: string[];
  };
}

/** Extended result with capability metadata for thinking profile resolution. */
export interface MappedCopilotModelWithCapabilities extends MappedCopilotModel {
  _copilotCapabilities?: CopilotModelCapabilities;
}

/**
 * Map a single Copilot API model to an OpenClaw model definition.
 */
export function mapCopilotApiModel(model: CopilotApiModel): MappedCopilotModelWithCapabilities {
  const api = resolveTransportApiFromEndpoints(model.id, model.supported_endpoints);
  const limits = model.capabilities?.limits;
  const supports = model.capabilities?.supports;

  // Build compat config from API capabilities
  const compat: MappedCopilotModel["compat"] = {};
  if (supports?.tool_calls === false) {
    compat.supportsTools = false;
  }
  if (supports?.reasoning_effort && supports.reasoning_effort.length > 0) {
    compat.supportedReasoningEfforts = supports.reasoning_effort;
  }

  return {
    id: model.id,
    name: model.name || model.id,
    api,
    contextWindow: limits?.max_context_window_tokens ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: limits?.max_output_tokens ?? DEFAULT_MAX_TOKENS,
    reasoning: isReasoningModel(model),
    input: resolveInputModalities(model),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(Object.keys(compat).length > 0 ? { compat } : {}),
    _copilotCapabilities: {
      adaptiveThinking: supports?.adaptive_thinking,
      maxThinkingBudget: supports?.max_thinking_budget,
      minThinkingBudget: supports?.min_thinking_budget,
      reasoningEffort: supports?.reasoning_effort,
      toolCalls: supports?.tool_calls,
      streaming: supports?.streaming,
      parallelToolCalls: supports?.parallel_tool_calls,
      structuredOutputs: supports?.structured_outputs,
    },
  };
}

/**
 * Process the full Copilot API model list into OpenClaw model definitions.
 *
 * Filters out internal/embedding models, deduplicates, and maps capabilities.
 */
export function mapCopilotModels(apiModels: CopilotApiModel[]): MappedCopilotModelWithCapabilities[] {
  const userFacing = apiModels.filter(isUserFacingModel);
  const deduped = deduplicateModels(userFacing);
  return deduped.map(mapCopilotApiModel);
}
