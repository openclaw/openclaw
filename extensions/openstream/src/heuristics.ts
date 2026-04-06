import type { ResolvedOpenStreamPluginConfig, StreamingMode } from "./config.js";

export const OLLAMA_DEFAULT_CONTEXT_WINDOW = 128000;
export const OLLAMA_EXTENDED_CONTEXT_WINDOW = 262144;
export const OLLAMA_MEGA_CONTEXT_WINDOW = 2097152;
export const OLLAMA_DEFAULT_MAX_TOKENS = 8192;
export const OLLAMA_EXTENDED_MAX_TOKENS = 32768;

export type OpenStreamModelHint = {
  modelId: string;
  reasoning: boolean;
  estimatedContextWindow?: number;
  recommendedMaxTokens: number;
  recommendedStreamingMode: StreamingMode;
  notes: string[];
};

export function isReasoningModelHeuristic(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return /r1|reasoning|think|reason|qwen3|qwq|glm-?5|kimi-?k2|marco-o|skywork-o|llama.*reason|yi.*1\.5/i.test(
    id,
  );
}

export function estimateContextWindow(modelId: string): number | undefined {
  const name = modelId.toLowerCase();
  if (name.includes("qwen3") || name.includes("qwen-3")) {
    if (name.includes("2m")) return OLLAMA_MEGA_CONTEXT_WINDOW;
    if (name.includes("1m")) return 1048576;
    if (name.includes("256k")) return OLLAMA_EXTENDED_CONTEXT_WINDOW;
    if (name.includes("128k")) return 131072;
    return OLLAMA_EXTENDED_CONTEXT_WINDOW;
  }
  if (name.includes("glm") && (name.includes("5") || name.includes("4"))) {
    return name.includes("128k") ? 131072 : OLLAMA_EXTENDED_CONTEXT_WINDOW;
  }
  if (name.includes("deepseek") && name.includes("v3")) {
    if (name.includes("2m")) return OLLAMA_MEGA_CONTEXT_WINDOW;
    if (name.includes("1m")) return 1048576;
    if (name.includes("256k")) return OLLAMA_EXTENDED_CONTEXT_WINDOW;
    if (name.includes("128k")) return 131072;
    return 131072;
  }
  if (name.includes("kimi") && (name.includes("k2") || name.includes("2.5"))) {
    return OLLAMA_MEGA_CONTEXT_WINDOW;
  }
  if ((name.includes("llama3") || name.includes("llama-3")) && name.includes("405b")) {
    return OLLAMA_MEGA_CONTEXT_WINDOW;
  }
  if ((name.includes("llama3") || name.includes("llama-3")) && name.includes("70b")) {
    return OLLAMA_EXTENDED_CONTEXT_WINDOW;
  }
  if ((name.includes("code") || name.includes("coder")) && name.includes("34b")) {
    return OLLAMA_EXTENDED_CONTEXT_WINDOW;
  }
  if (name.includes("128k")) return 131072;
  if (name.includes("256k")) return OLLAMA_EXTENDED_CONTEXT_WINDOW;
  return undefined;
}

export function recommendMaxTokens(contextWindow?: number): number {
  if (!contextWindow) {
    return OLLAMA_DEFAULT_MAX_TOKENS;
  }
  if (contextWindow >= OLLAMA_MEGA_CONTEXT_WINDOW) {
    return OLLAMA_EXTENDED_MAX_TOKENS;
  }
  if (contextWindow >= OLLAMA_EXTENDED_CONTEXT_WINDOW) {
    return Math.min(OLLAMA_EXTENDED_MAX_TOKENS, Math.floor(contextWindow * 0.25));
  }
  return OLLAMA_DEFAULT_MAX_TOKENS;
}

export function recommendStreamingMode(params: {
  modelId: string;
  pluginConfig: ResolvedOpenStreamPluginConfig;
  contextWindow?: number;
  reasoning?: boolean;
}): StreamingMode {
  if (params.pluginConfig.streamingMode === "ultra") {
    return "ultra";
  }
  if (params.reasoning || (params.contextWindow ?? 0) >= OLLAMA_EXTENDED_CONTEXT_WINDOW) {
    return "enhanced";
  }
  const id = params.modelId.toLowerCase();
  if (id.includes("qwen3") || id.includes("kimi") || id.includes("deepseek")) {
    return "enhanced";
  }
  return params.pluginConfig.streamingMode;
}

export function buildModelHint(
  modelId: string,
  pluginConfig: ResolvedOpenStreamPluginConfig,
): OpenStreamModelHint {
  const reasoning = isReasoningModelHeuristic(modelId);
  const estimatedContextWindow = estimateContextWindow(modelId);
  const recommendedStreamingMode = recommendStreamingMode({
    modelId,
    pluginConfig,
    contextWindow: estimatedContextWindow,
    reasoning,
  });
  const notes: string[] = [];
  if (reasoning) {
    notes.push("Model name matches OpenStream reasoning-model heuristic.");
  }
  if (estimatedContextWindow && estimatedContextWindow >= OLLAMA_EXTENDED_CONTEXT_WINDOW) {
    notes.push("Long-context family detected; keep summaries and checkpoints stable during long runs.");
  }
  if (estimatedContextWindow === OLLAMA_MEGA_CONTEXT_WINDOW && pluginConfig.enableMegaContext) {
    notes.push("Mega-context recommendation is enabled for this plugin configuration.");
  }
  if (notes.length === 0) {
    notes.push("No strong heuristic match found; keep OpenClaw defaults unless runtime evidence shows otherwise.");
  }
  return {
    modelId,
    reasoning,
    estimatedContextWindow,
    recommendedMaxTokens: recommendMaxTokens(estimatedContextWindow),
    recommendedStreamingMode,
    notes,
  };
}
