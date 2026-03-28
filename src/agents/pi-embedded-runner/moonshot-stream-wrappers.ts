import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import { usesMoonshotThinkingPayloadCompatStatic } from "../moonshot-provider-compat.js";
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
  const normalizedModelId = params.modelId.trim().toLowerCase();

  if (usesMoonshotThinkingPayloadCompatStatic(normalizedProvider)) {
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
  return (model, context, options) =>
    streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
      if (payloadObj.thinking === "off") {
        payloadObj.thinking = null;
      }
    });
}
