import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";

const XAI_FAST_MODEL_IDS = new Map<string, string>([
  ["grok-4", "grok-4-fast"],
  ["grok-4-0709", "grok-4-fast"],
]);

function resolveXaiFastModelId(modelId: unknown): string | undefined {
  if (typeof modelId !== "string") {
    return undefined;
  }
  return XAI_FAST_MODEL_IDS.get(modelId.trim());
}

export function createXaiFastModeWrapper(
  baseStreamFn: StreamFn | undefined,
  fastMode: boolean,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (!fastMode || model.api !== "openai-completions" || model.provider !== "xai") {
      return underlying(model, context, options);
    }

    const fastModelId = resolveXaiFastModelId(model.id);
    if (!fastModelId) {
      return underlying(model, context, options);
    }

    return underlying({ ...model, id: fastModelId }, context, options);
  };
}
