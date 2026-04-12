import { estimateTokens } from "@mariozechner/pi-coding-agent";

function estimateTextTokens(text: string): number {
  if (!text) {
    return 0;
  }
  return estimateTokens({ role: "user", content: text, timestamp: 0 } as never);
}

function collectEstimatedTokensFromValue(value: unknown): number {
  if (typeof value === "string") {
    return estimateTextTokens(value);
  }
  if (Array.isArray(value)) {
    let total = 0;
    for (const item of value) {
      total += collectEstimatedTokensFromValue(item);
    }
    return total;
  }
  if (!value || typeof value !== "object") {
    return 0;
  }

  const record = value as Record<string, unknown>;
  let total = 0;
  for (const [key, nestedValue] of Object.entries(record)) {
    switch (key) {
      case "text":
      case "refusal":
      case "arguments":
      case "content":
      case "summary":
      case "encrypted_content":
      case "output":
        total += collectEstimatedTokensFromValue(nestedValue);
        break;
      default:
        if (key === "type") {
          continue;
        }
        if (Array.isArray(nestedValue)) {
          total += collectEstimatedTokensFromValue(nestedValue);
        }
        break;
    }
  }
  return total;
}

export function estimateOpenAIResponsesInputTokens(input: unknown): number {
  return collectEstimatedTokensFromValue(input);
}
