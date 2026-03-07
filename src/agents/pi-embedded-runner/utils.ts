import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ReasoningLevel, ThinkLevel } from "../../auto-reply/thinking.js";

export function mapThinkingLevel(level?: ThinkLevel): ThinkingLevel {
  // pi-agent-core supports "xhigh"; OpenClaw enables it for specific models.
  if (!level) {
    return "off";
  }
  // "adaptive" maps to "medium" at the pi-agent-core layer.  The Pi SDK
  // provider then translates this to `thinking.type: "adaptive"` with
  // `output_config.effort: "medium"` for models that support it (Opus 4.6,
  // Sonnet 4.6).
  if (level === "adaptive") {
    return "medium";
  }
  return level;
}

export function describeUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    // Check if this looks like a provider error object
    const obj = error as Record<string, unknown>;
    if (obj && typeof obj === "object") {
      // Extract request ID if present for debugging
      const requestId =
        typeof obj.requestId === "string"
          ? obj.requestId
          : typeof obj.error === "object" && obj.error !== null
            ? (obj.error as Record<string, unknown>).requestId
            : undefined;
      
      // If it's a provider error object, extract just the message
      if (obj.type === "error" || (obj.error && typeof obj.error === "object")) {
        const errorObj = obj.error as Record<string, unknown> | undefined;
        const message = errorObj?.message as string | undefined;
        if (message) {
          const result = `Provider error: ${message}`;
          return requestId ? `${result} (Request ID: ${requestId})` : result;
        }
      }
    }
    
    const serialized = JSON.stringify(error);
    return serialized ?? "Unknown error";
  } catch {
    return "Unknown error";
  }
}

export type { ReasoningLevel, ThinkLevel };
