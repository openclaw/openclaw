import type OpenAI from "openai";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { calculateCost } from "../model-utils.js";
import type { Api, AssistantMessage, Model, Usage } from "../types.js";

// Structural view of the terminal Response.usage carried by response.completed
// and response.incomplete. Kept loose so both the strongly typed package caller
// (OpenAI.Responses.Response) and the agent transport (an untyped Record) reach
// this one billing path without competing implementations.
type ResponsesTerminalUsageShape = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } | null;
};

// Minimal structural view of a terminal Response. Fields are typed `unknown` so
// both OpenAI.Responses.Response (package caller) and Record<string, unknown>
// (agent transport) satisfy it without a cast at the boundary.
type ResponsesTerminalResponse = {
  usage?: unknown;
  service_tier?: unknown;
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

function readResponsesUsage(
  response: ResponsesTerminalResponse | undefined,
): ResponsesTerminalUsageShape | undefined {
  const usage = response?.usage;
  return usage && typeof usage === "object" ? (usage as ResponsesTerminalUsageShape) : undefined;
}

function mapResponsesUsage(usage: ResponsesTerminalUsageShape): Usage {
  const cachedTokens = usage.input_tokens_details?.cached_tokens || 0;
  const cacheWriteTokens = usage.input_tokens_details?.cache_write_tokens || 0;
  // OpenAI includes cache reads and writes in input_tokens, so split both priced buckets.
  const input = Math.max(0, (usage.input_tokens || 0) - cachedTokens - cacheWriteTokens);
  const output = usage.output_tokens || 0;
  return {
    input,
    output,
    cacheRead: cachedTokens,
    cacheWrite: cacheWriteTokens,
    totalTokens: input + output + cachedTokens + cacheWriteTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

// Single source of truth for terminal Responses billing: split usage into priced
// buckets, run calculateCost, and apply service-tier pricing. Returns the priced
// Usage — the mapped buckets when the terminal event carried usage, otherwise the
// caller's current usage re-priced so its cost is never left stale. Both Responses
// processors (packages/ai and src/agents) route response.completed and
// response.incomplete through here so the billing invariant cannot drift (#100954).
export function mapResponsesTerminalUsage<TApi extends Api>(
  response: ResponsesTerminalResponse | undefined,
  model: Model<TApi>,
  options: ResponsesTerminalUsageOptions | undefined,
  currentUsage: Usage,
): Usage {
  const rawUsage = readResponsesUsage(response);
  const usage = rawUsage ? mapResponsesUsage(rawUsage) : currentUsage;
  calculateCost(model, usage);
  if (options?.applyServiceTierPricing) {
    const responseServiceTier = response?.service_tier as
      | ResponseCreateParamsStreaming["service_tier"]
      | undefined;
    const serviceTier = options.resolveServiceTier
      ? options.resolveServiceTier(responseServiceTier, options.serviceTier)
      : (responseServiceTier ?? options.serviceTier);
    options.applyServiceTierPricing(usage, serviceTier);
  }
  return usage;
}

// Record usage and cost for a terminal Responses event (response.completed or
// response.incomplete) on the package assistant message. Session accounting sums
// usage.cost.total, so cost must be computed for either terminal path — recording
// usage alone leaves an early-terminated stream at zero cost (#100954).
export function recordResponsesTerminalUsage<TApi extends Api>(
  output: AssistantMessage,
  response: OpenAI.Responses.Response | undefined,
  model: Model<TApi>,
  options: ResponsesTerminalUsageOptions | undefined,
): void {
  if (response?.id) {
    output.responseId = response.id;
  }
  output.usage = mapResponsesTerminalUsage(response, model, options, output.usage);
}
