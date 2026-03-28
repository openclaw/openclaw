import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";

export function createBedrockNoCacheWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) =>
    underlying(model, context, {
      ...options,
      cacheRetention: "none",
    });
}

export function isAnthropicBedrockModel(modelId: string): boolean {
  const normalized = modelId.toLowerCase();
  return normalized.includes("anthropic.claude") || normalized.includes("anthropic/claude");
}
