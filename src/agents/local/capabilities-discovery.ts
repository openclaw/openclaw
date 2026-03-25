export type LocalToolFormat = "openai" | "anthropic-xml" | "ollama-dsl" | "none";

export interface CapabilitiesDiscoveryResult {
  toolFormat: LocalToolFormat;
  isReasoningModel: boolean;
}

export interface DiscoveryOptions {
  modelId: string;
  providerType: "ollama" | "openai-compatible" | "llama.cpp" | "lmstudio" | (string & {});
}

/**
 * Heuristics-based discovery of a local model's capabilities.
 * Determines if a model natively supports tools and if it's a reasoning model (which requires <think> block stripping).
 */
export function discoverLocalCapabilities(options: DiscoveryOptions): CapabilitiesDiscoveryResult {
  const model = options.modelId.toLowerCase();

  // 1. Determine if it's a reasoning model
  // DeepSeek-R1, QwQ, and explicit reasoning variants often emit <think> blocks.
  const isReasoningModel =
    model.includes("deepseek-r1") ||
    model.includes("deepseek-r2") ||
    model.includes("qwq") ||
    /\b(r[1-2])\b/.test(model) ||
    model.endsWith("-thinking") ||
    model.includes("-reasoning");

  // 2. Determine native tool format
  let toolFormat: LocalToolFormat = "none";

  // Force Fallback for known problematic patterns if needed, but let's assume popular ones work
  // if they are standard sizes (unless user overrides later).
  const isKnownToolCapable =
    model.includes("qwen") ||
    model.includes("llama3") ||
    model.includes("llama-3") ||
    model.includes("mistral") ||
    model.includes("mixtral") ||
    model.includes("tool-use") ||
    model.includes("coder") ||
    model.includes("function");

  if (isKnownToolCapable) {
    if (options.providerType === "ollama") {
      toolFormat = "ollama-dsl";
    } else {
      // LMStudio / llama.cpp typically expose OpenAI-compatible tool calling
      toolFormat = "openai";
    }
  }

  // Very small models (<7B) without specific tool fine-tuning usually fail miserably at native JSON tools.
  // We can loosely detect them. If it's something like "phi-2" or "gemma:2b", fallback to ReAct.
  const isTooSmall =
    model.includes("phi-2") || model.includes("gemma:2b") || model.includes("tinyllama");
  if (isTooSmall && !model.includes("tool")) {
    toolFormat = "none";
  }

  return {
    toolFormat,
    isReasoningModel,
  };
}

/**
 * Determines if a provider type is considered "local" or self-hosted.
 */
export function isLocalProvider(providerType: string): boolean {
  const type = providerType.toLowerCase();
  return (
    type === "ollama" ||
    type === "llama.cpp" ||
    type === "lmstudio" ||
    type === "local" ||
    type.includes("openai-compatible") ||
    type.includes("openai-responses") ||
    type.includes("openai-completions") ||
    type.includes("self-hosted")
  );
}
