import type { CompletionEvent } from "@mistralai/mistralai/models/components";
import { calculateCost } from "../model-utils.js";
import type { Model, Usage } from "../types.js";

export function applyMistralUsage(
  output: Usage,
  usage: NonNullable<CompletionEvent["data"]["usage"]>,
  model: Model<"mistral-conversations">,
  terminal: boolean,
): void {
  const promptTokens = usage.promptTokens || 0;
  // SAFETY: SDK usage permits extra cache fields; only finite numeric counts are accepted below.
  const record = usage as {
    promptTokensDetails?: { cachedTokens?: unknown } | null;
    prompt_tokens_details?: { cached_tokens?: unknown } | null;
    cachedTokens?: unknown;
    cached_tokens?: unknown;
  };
  const rawCachedTokens =
    record.promptTokensDetails?.cachedTokens ??
    record.prompt_tokens_details?.cached_tokens ??
    record.cachedTokens ??
    record.cached_tokens;
  const cachedTokens =
    typeof rawCachedTokens === "number" && Number.isFinite(rawCachedTokens) ? rawCachedTokens : 0;
  const cacheRead = Math.min(promptTokens, Math.max(0, cachedTokens));
  output.input = Math.max(0, promptTokens - cacheRead);
  output.output = usage.completionTokens || 0;
  output.cacheRead = cacheRead;
  output.cacheWrite = 0;
  output.totalTokens = usage.totalTokens || output.input + output.output + cacheRead;
  output.usageReport = { state: terminal ? "available" : "unavailable" };
  calculateCost(model, output);
}
