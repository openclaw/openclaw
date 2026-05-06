import type { StreamFn } from "../agent-core-contract.js";
import { streamSimple } from "../pi-ai-contract.js";
import { isAnthropicBedrockModel } from "./anthropic-family-cache-semantics.js";

export function createBedrockNoCacheWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) =>
    underlying(model, context, {
      ...options,
      cacheRetention: "none",
    });
}

export { isAnthropicBedrockModel };
