import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";

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

    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        if (payload && typeof payload === "object") {
          (payload as Record<string, unknown>).tool_stream = true;
        }
        return originalOnPayload?.(payload, model);
      },
    });
  };
}

export const createZaiToolStreamWrapper = createToolStreamWrapper;
