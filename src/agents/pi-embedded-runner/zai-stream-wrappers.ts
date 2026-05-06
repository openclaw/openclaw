import type { StreamFn } from "../agent-core-contract.js";
import { streamSimple } from "../pi-ai-contract.js";
import { streamWithPayloadPatch } from "./stream-payload-utils.js";

/**
 * Inject `tool_stream=true` so tool-call deltas stream in real time.
 * Providers can disable this by setting `params.tool_stream=false`.
 */
export function createToolStreamWrapper(
  baseStreamFn: StreamFn | undefined,
  enabled: boolean,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (!enabled) {
      return underlying(model, context, options);
    }

    return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
      payloadObj.tool_stream = true;
    });
  };
}

export const createZaiToolStreamWrapper = createToolStreamWrapper;
