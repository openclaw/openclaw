import type { StreamFn } from "@mariozechner/pi-agent-core";

/**
 * Strip `tool_choice` from the outgoing payload when the `tools` array is
 * empty or absent.  Sending `tool_choice: "auto"` without any tool
 * definitions causes 400 errors on providers that don't support it
 * (e.g. vLLM without `--enable-auto-tool-choice`).
 */
export function sanitizeToolChoicePayload(payload: Record<string, unknown>): void {
  const tools = payload.tools;
  const hasTools = Array.isArray(tools) && tools.length > 0;
  if (!hasTools && payload.tool_choice !== undefined) {
    delete payload.tool_choice;
  }
}

/**
 * Wrap a stream function to strip `tool_choice` when no tools are present.
 */
export function createEmptyToolChoiceSanitizer(baseStreamFn: StreamFn): StreamFn {
  return (model, context, options) => {
    const originalOnPayload = options?.onPayload;
    return baseStreamFn(model, context, {
      ...options,
      onPayload: (payload) => {
        if (payload && typeof payload === "object") {
          sanitizeToolChoicePayload(payload as Record<string, unknown>);
        }
        return originalOnPayload?.(payload, model);
      },
    });
  };
}

export function streamWithPayloadPatch(
  underlying: StreamFn,
  model: Parameters<StreamFn>[0],
  context: Parameters<StreamFn>[1],
  options: Parameters<StreamFn>[2],
  patchPayload: (payload: Record<string, unknown>) => void,
) {
  const originalOnPayload = options?.onPayload;
  return underlying(model, context, {
    ...options,
    onPayload: (payload) => {
      if (payload && typeof payload === "object") {
        patchPayload(payload as Record<string, unknown>);
        sanitizeToolChoicePayload(payload as Record<string, unknown>);
      }
      return originalOnPayload?.(payload, model);
    },
  });
}
