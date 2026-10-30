import type { StopReason } from "../types.js";

export type OpenAIStopReasonResult = {
  stopReason: StopReason;
  errorMessage?: string;
};

export function mapOpenAIStopReason(
  reason: string | null,
  options?: { allowSingularToolCall?: boolean },
): OpenAIStopReasonResult {
  switch (reason) {
    case null:
    case "stop":
    case "end":
      return { stopReason: "stop" };
    case "length":
      return { stopReason: "length" };
    case "function_call":
    case "tool_calls":
      return { stopReason: "toolUse" };
    case "tool_call":
      if (options?.allowSingularToolCall) {
        return { stopReason: "toolUse" };
      }
      break;
  }

  return {
    stopReason: "error",
    errorMessage: `Provider finish_reason: ${reason}`,
  };
}
