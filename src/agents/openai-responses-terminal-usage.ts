import { calculateCost } from "@openclaw/ai/internal/runtime";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import type { Model } from "../llm/types.js";
import type { MutableAssistantOutput } from "./openai-transport-shared.js";

// Record usage and cost for a terminal Responses event (response.completed or
// response.incomplete). Both carry the same Response shape, and session
// accounting sums usage.cost.total, so cost must be computed for either terminal
// path — recording usage alone leaves an early-terminated stream at zero cost (#100954).
export function recordResponsesTerminalUsage(
  output: MutableAssistantOutput,
  response: Record<string, unknown> | undefined,
  model: Model,
  options:
    | {
        serviceTier?: ResponseCreateParamsStreaming["service_tier"];
        applyServiceTierPricing?: (
          usage: MutableAssistantOutput["usage"],
          serviceTier?: ResponseCreateParamsStreaming["service_tier"],
        ) => void;
      }
    | undefined,
): void {
  if (typeof response?.id === "string") {
    output.responseId = response.id;
  }
  const usage = response?.usage as
    | {
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
        input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
        output_tokens_details?: { reasoning_tokens?: number };
      }
    | undefined;
  if (usage) {
    const cachedTokens = usage.input_tokens_details?.cached_tokens || 0;
    const cacheWriteTokens = usage.input_tokens_details?.cache_write_tokens || 0;
    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const reasoningTokens = usage.output_tokens_details?.reasoning_tokens;
    const input = Math.max(0, inputTokens - cachedTokens - cacheWriteTokens);
    output.usage = {
      input,
      output: outputTokens,
      cacheRead: cachedTokens,
      cacheWrite: cacheWriteTokens,
      ...(typeof reasoningTokens === "number" && Number.isFinite(reasoningTokens)
        ? { reasoningTokens }
        : {}),
      totalTokens: input + outputTokens + cachedTokens + cacheWriteTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
  }
  calculateCost(model as never, output.usage as never);
  if (options?.applyServiceTierPricing) {
    options.applyServiceTierPricing(
      output.usage,
      (response?.service_tier as ResponseCreateParamsStreaming["service_tier"] | undefined) ??
        options.serviceTier,
    );
  }
}
