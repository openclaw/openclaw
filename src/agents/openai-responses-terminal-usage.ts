import { mapResponsesTerminalUsage } from "@openclaw/ai/internal/openai";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import type { Model, Usage } from "../llm/types.js";
import type { MutableAssistantOutput } from "./openai-transport-shared.js";

// Record usage and cost for a terminal Responses event (response.completed or
// response.incomplete). The billing invariant — priced bucket split, calculateCost,
// and service-tier pricing — lives in the shared mapResponsesTerminalUsage so the
// two Responses processors cannot drift (#100954). This adapter only layers on the
// agent-local reasoningTokens bucket, which the normalized Usage type does not model
// but agent telemetry (usage accumulator, diagnostics) tracks.
export function recordResponsesTerminalUsage(
  output: MutableAssistantOutput,
  response: Record<string, unknown> | undefined,
  model: Model,
  options:
    | {
        serviceTier?: ResponseCreateParamsStreaming["service_tier"];
        applyServiceTierPricing?: (
          usage: Usage,
          serviceTier?: ResponseCreateParamsStreaming["service_tier"],
        ) => void;
      }
    | undefined,
): void {
  if (typeof response?.id === "string") {
    output.responseId = response.id;
  }
  const usage = mapResponsesTerminalUsage(response, model, options, output.usage);
  const reasoningTokens = (
    response?.usage as { output_tokens_details?: { reasoning_tokens?: number } } | undefined
  )?.output_tokens_details?.reasoning_tokens;
  output.usage =
    typeof reasoningTokens === "number" && Number.isFinite(reasoningTokens)
      ? { ...usage, reasoningTokens }
      : usage;
}
