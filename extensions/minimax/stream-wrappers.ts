// MiniMax fast-mode stream wrapper: /fast opts M2.x into the highspeed model and M3 into the priority tier.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { streamSimple } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { resolveBooleanFastMode } from "openclaw/plugin-sdk/provider-stream-family";
import { resolveMinimaxApiCost } from "./model-definitions.js";

const MINIMAX_FAST_MODEL_IDS = new Map<string, string>([["MiniMax-M2.7", "MiniMax-M2.7-highspeed"]]);
// MiniMax bills the M3 priority tier at 1.5x standard (platform.minimax.io/docs/guides/pricing-paygo).
const MINIMAX_PRIORITY_COST_MULTIPLIER = 1.5;

function isMinimaxM3(modelId: string): boolean {
  return /^MiniMax-M3(\b|[-.])/i.test(modelId);
}

/** Provider `wrapStreamFn`: routes MiniMax `/fast` requests to the faster paid lane and records its cost. */
export function wrapMinimaxFastModeStream(ctx: ProviderWrapStreamFnContext): StreamFn {
  const underlying = ctx.streamFn ?? streamSimple;
  return (model, context, options) => {
    if (
      resolveBooleanFastMode(ctx.extraParams) !== true ||
      model.api !== "anthropic-messages" ||
      (model.provider !== "minimax" && model.provider !== "minimax-portal")
    ) {
      return underlying(model, context, options);
    }
    const modelId = typeof model.id === "string" ? model.id.trim() : "";
    const highspeedId = MINIMAX_FAST_MODEL_IDS.get(modelId);
    if (highspeedId) {
      // Highspeed is its own catalog model: swap id and cost together.
      return underlying(
        { ...model, id: highspeedId, cost: resolveMinimaxApiCost(highspeedId) },
        context,
        options,
      );
    }
    if (!isMinimaxM3(modelId)) {
      return underlying(model, context, options);
    }
    // M3 has no highspeed model: use the priority service_tier (billed 1.5x),
    // keeping any service_tier already set upstream.
    const c = model.cost;
    const priorityModel = c
      ? {
          ...model,
          cost: {
            input: c.input * MINIMAX_PRIORITY_COST_MULTIPLIER,
            output: c.output * MINIMAX_PRIORITY_COST_MULTIPLIER,
            cacheRead: c.cacheRead * MINIMAX_PRIORITY_COST_MULTIPLIER,
            cacheWrite: c.cacheWrite * MINIMAX_PRIORITY_COST_MULTIPLIER,
          },
        }
      : model;
    const originalOnPayload = options?.onPayload;
    return underlying(priorityModel, context, {
      ...options,
      onPayload: (payload) => {
        if (payload && typeof payload === "object") {
          const payloadObj = payload as Record<string, unknown>;
          if (payloadObj.service_tier === undefined) {
            payloadObj.service_tier = "priority";
          }
        }
        return originalOnPayload?.(payload, model);
      },
    });
  };
}
