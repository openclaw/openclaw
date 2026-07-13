import type OpenAI from "openai";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { calculateCost } from "../model-utils.js";
import type { Api, AssistantMessage, Model, Usage } from "../types.js";

type ResponsesInputTokensDetails = {
  cached_tokens?: number;
  cache_write_tokens?: number;
};

// Structural subset of the Responses stream options that terminal usage recording needs.
interface ResponsesTerminalUsageOptions {
  serviceTier?: ResponseCreateParamsStreaming["service_tier"];
  resolveServiceTier?: (
    responseServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
    requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
  ) => ResponseCreateParamsStreaming["service_tier"] | undefined;
  applyServiceTierPricing?: (
    usage: Usage,
    serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
  ) => void;
}

function mapResponsesUsage(usage: NonNullable<OpenAI.Responses.Response["usage"]>): Usage {
  const inputTokenDetails = usage.input_tokens_details as
    | ResponsesInputTokensDetails
    | null
    | undefined;
  const cachedTokens = inputTokenDetails?.cached_tokens || 0;
  const cacheWriteTokens = inputTokenDetails?.cache_write_tokens || 0;
  return {
    // OpenAI includes cache reads and writes in input_tokens, so split both priced buckets.
    input: Math.max(0, (usage.input_tokens || 0) - cachedTokens - cacheWriteTokens),
    output: usage.output_tokens || 0,
    cacheRead: cachedTokens,
    cacheWrite: cacheWriteTokens,
    totalTokens: usage.total_tokens || 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

// Record usage and cost for a terminal Responses event (response.completed or
// response.incomplete). Both carry the same Response shape, and session
// accounting sums usage.cost.total, so cost must be computed for either path.
export function recordResponsesTerminalUsage<TApi extends Api>(
  output: AssistantMessage,
  response: OpenAI.Responses.Response | undefined,
  model: Model<TApi>,
  options: ResponsesTerminalUsageOptions | undefined,
): void {
  if (response?.id) {
    output.responseId = response.id;
  }
  if (response?.usage) {
    output.usage = mapResponsesUsage(response.usage);
  }
  calculateCost(model, output.usage);
  if (options?.applyServiceTierPricing) {
    const serviceTier = options.resolveServiceTier
      ? options.resolveServiceTier(response?.service_tier, options.serviceTier)
      : (response?.service_tier ?? options.serviceTier);
    options.applyServiceTierPricing(output.usage, serviceTier);
  }
}
