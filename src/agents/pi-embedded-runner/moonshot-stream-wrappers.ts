import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { StreamFn } from "../agent-core-contract.js";
import { streamSimple } from "../pi-ai-contract.js";
import { streamWithPayloadPatch } from "./stream-payload-utils.js";

export {
  createMoonshotThinkingWrapper,
  resolveMoonshotThinkingKeep,
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

export function createSiliconFlowThinkingWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) =>
    streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
      if (payloadObj.thinking === "off") {
        payloadObj.thinking = null;
      }
    });
}
