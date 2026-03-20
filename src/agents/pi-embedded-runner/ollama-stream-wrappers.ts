import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import { streamWithPayloadPatch } from "./stream-payload-utils.js";

export function sanitizeOllamaThinkingPayload(params: {
  payload: unknown;
  thinkingLevel?: ThinkLevel;
}): void {
  if (params.thinkingLevel !== "off") {
    return;
  }
  if (!params.payload || typeof params.payload !== "object") {
    return;
  }

  const payloadObj = params.payload as Record<string, unknown>;
  const existingOptions = payloadObj.options;
  const options =
    existingOptions && typeof existingOptions === "object" && !Array.isArray(existingOptions)
      ? (existingOptions as Record<string, unknown>)
      : {};

  if (payloadObj.options !== options) {
    payloadObj.options = options;
  }

  // Ollama emits reasoning-only responses unless thinking is explicitly disabled.
  options.think = false;
}

export function createOllamaThinkingPayloadWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingLevel?: ThinkLevel,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (model.api !== "ollama") {
      return underlying(model, context, options);
    }
    return streamWithPayloadPatch(underlying, model, context, options, (payload) => {
      sanitizeOllamaThinkingPayload({ payload, thinkingLevel });
    });
  };
}
