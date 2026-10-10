import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { streamSimple } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { buildProviderStreamFamilyHooks } from "openclaw/plugin-sdk/provider-stream-family";
import { streamWithPayloadPatch } from "openclaw/plugin-sdk/provider-stream-shared";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { buildMinimaxApiModelDefinition } from "./model-definitions.js";
import {
  isMinimaxM31ModelId,
  MINIMAX_M31_MODEL_ID,
  MINIMAX_M31_THINKING_LEVELS,
} from "./thinking.js";

const FAST_MODE_HOOKS = buildProviderStreamFamilyHooks("minimax-fast-mode");
const M31_MAX_TOKENS = buildMinimaxApiModelDefinition(MINIMAX_M31_MODEL_ID).maxTokens;

export function wrapMinimaxProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn {
  const underlying = FAST_MODE_HOOKS.wrapStreamFn?.(ctx) ?? ctx.streamFn ?? streamSimple;
  return (model, context, options) => {
    if ((ctx.sourceApi ?? model.api) !== "anthropic-messages" || !isMinimaxM31ModelId(model.id)) {
      return underlying(model, context, options);
    }
    const thinkingLevel = options?.reasoning ?? ctx.thinkingLevel;
    const effort = MINIMAX_M31_THINKING_LEVELS.find((level) => level === thinkingLevel) ?? "max";
    const modelMaxTokens = model.maxTokens ?? M31_MAX_TOKENS;
    // The Anthropic client uses a manual budget for non-Claude models. Give that
    // calculation room to retain signed history; the payload keeps the real cap below.
    const resolvedModel =
      model.maxTokens === undefined || modelMaxTokens < M31_MAX_TOKENS
        ? { ...model, maxTokens: M31_MAX_TOKENS }
        : model;
    // Resolve mandatory thinking before the client converts prior assistant messages.
    return streamWithPayloadPatch(
      underlying,
      resolvedModel,
      context,
      { ...options, reasoning: effort, thinkingBudgets: undefined },
      (payload) => {
        // M3.1 requires adaptive thinking and uses effort instead of a token budget.
        payload.thinking = { type: "adaptive" };
        payload.output_config = {
          ...(isRecord(payload.output_config) ? payload.output_config : {}),
          effort,
        };
        const maxTokens = options?.maxTokens ?? payload.max_tokens;
        if (typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0) {
          payload.max_tokens = Math.min(Math.floor(maxTokens), modelMaxTokens);
        }
      },
    );
  };
}
