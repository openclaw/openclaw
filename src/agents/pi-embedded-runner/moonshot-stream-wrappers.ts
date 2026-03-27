import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import { usesMoonshotThinkingPayloadCompat } from "../provider-capabilities.js";
import { normalizeProviderId } from "../provider-id.js";

export { createMoonshotThinkingWrapper, resolveMoonshotThinkingType } from "./moonshot-thinking-stream-wrappers.js";

export function shouldApplySiliconFlowThinkingOffCompat(params: {
  provider: string;
  modelId: string;
  thinkingLevel?: ThinkLevel;
}): boolean {
  return (
    params.provider === "siliconflow" &&
    params.thinkingLevel === "off" &&
    params.modelId.startsWith("Pro/")
  );
}

export function shouldApplyMoonshotPayloadCompat(params: {
  provider: string;
  modelId: string;
}): boolean {
  const normalizedProvider = normalizeProviderId(params.provider);
  const normalizedModelId = params.modelId.trim().toLowerCase();

  if (usesMoonshotThinkingPayloadCompat(normalizedProvider)) {
    return true;
  }

  return (
    normalizedProvider === "ollama" &&
    normalizedModelId.startsWith("kimi-k") &&
    normalizedModelId.includes(":cloud")
  );
}

export function createSiliconFlowThinkingWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        if (payload && typeof payload === "object") {
          const payloadObj = payload as Record<string, unknown>;
          if (payloadObj.thinking === "off") {
            payloadObj.thinking = null;
          }
        }
        return originalOnPayload?.(payload, model);
      },
    });
  };
}
