import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import { resolveProviderRequestCapabilities } from "../provider-attribution.js";
import { normalizeProviderId } from "../provider-id.js";
import { streamWithPayloadPatch } from "./stream-payload-utils.js";

export {
  createMoonshotThinkingWrapper,
  resolveMoonshotThinkingType,
} from "./moonshot-thinking-stream-wrappers.js";

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
  return (
    resolveProviderRequestCapabilities({
      provider: normalizedProvider,
      modelId: params.modelId,
      capability: "llm",
      transport: "stream",
    }).compatibilityFamily === "moonshot"
  );
}

export function createSiliconFlowThinkingWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) =>
    streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
      if (payloadObj.thinking === "off") {
        payloadObj.thinking = null;
      }
    });
}
