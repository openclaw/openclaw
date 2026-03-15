import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { AnyAgentTool } from "../pi-tools.types.js";

/**
 * Creates a streamFn wrapper that filters the tools context to only include
 * tools whose names are in the override set. This reduces token usage by
 * sending fewer tool schemas to the model while keeping all executors available.
 */
export function wrapStreamFnWithToolsOverride(
  underlying: StreamFn,
  toolsOverride: AnyAgentTool[],
): StreamFn {
  const allowedNames = new Set(toolsOverride.map((tool) => tool.name));
  return (model, context, options) => {
    const ctx = context as { tools?: unknown[] };
    if (!Array.isArray(ctx.tools)) {
      return underlying(model, context, options);
    }
    const filteredTools = ctx.tools.filter((tool) => {
      const name = (tool as { name?: string })?.name;
      return typeof name === "string" && allowedNames.has(name);
    });
    return underlying(model, { ...context, tools: filteredTools }, options);
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
      }
      return originalOnPayload?.(payload, model);
    },
  });
}
