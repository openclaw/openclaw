/**
 * Terminal-outcome recording for the agent-side Responses stream.
 *
 * `response.completed` and `response.incomplete` are both terminal and both carry usage, so
 * they finalize through one path here — mirroring `finalizeResponse` in the package-side
 * processor (`packages/ai/src/providers/openai-responses-shared.ts`). Splitting them is how
 * incomplete turns silently recorded zero usage.
 */
import { calculateCost } from "@openclaw/ai/internal/runtime";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import type { Model } from "../llm/types.js";
import type { MutableAssistantOutput } from "./openai-transport-shared.js";

type ResponsesTerminalUsage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
};

function mapResponsesStopReason(status: string | undefined): string {
  if (!status) {
    return "stop";
  }
  switch (status) {
    case "completed":
      return "stop";
    case "incomplete":
      return "length";
    case "failed":
    case "cancelled":
      return "error";
    case "in_progress":
    case "queued":
      return "stop";
    default:
      throw new Error(`Unhandled stop reason: ${status}`);
  }
}

function readIncompleteReason(response: Record<string, unknown> | undefined): string | undefined {
  const details = response?.incomplete_details;
  if (!isRecord(details)) {
    return undefined;
  }
  return typeof details.reason === "string" ? details.reason : undefined;
}

/** Record usage, cost and stop reason from a terminal Responses event onto the output. */
export function recordResponsesTerminalOutcome(params: {
  response: Record<string, unknown> | undefined;
  output: MutableAssistantOutput;
  model: Model;
  serviceTier?: ResponseCreateParamsStreaming["service_tier"];
  applyServiceTierPricing?: (
    usage: MutableAssistantOutput["usage"],
    serviceTier?: ResponseCreateParamsStreaming["service_tier"],
  ) => void;
}): void {
  const { response, output, model } = params;
  const usage = response?.usage as ResponsesTerminalUsage | undefined;
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
  if (params.applyServiceTierPricing) {
    params.applyServiceTierPricing(
      output.usage,
      (response?.service_tier as ResponseCreateParamsStreaming["service_tier"] | undefined) ??
        params.serviceTier,
    );
  }
  const status = response?.status as string | undefined;
  if (status === "incomplete" && readIncompleteReason(response) === "content_filter") {
    // Parity with the package-side processor: a content-filtered turn is a provider error,
    // not a normal length stop, so callers do not replay it as a truncated answer.
    output.stopReason = "error";
    output.errorMessage = "Provider incomplete_reason: content_filter";
  } else {
    output.stopReason = mapResponsesStopReason(status);
  }
  if (output.content.some((block) => block.type === "toolCall") && output.stopReason === "stop") {
    output.stopReason = "toolUse";
  }
}
