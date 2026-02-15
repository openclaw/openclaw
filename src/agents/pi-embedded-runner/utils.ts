import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ReasoningLevel, ThinkLevel } from "../../auto-reply/thinking.js";
import { resolveMaxThinkLevel } from "../../auto-reply/thinking.js";

export function mapThinkingLevel(
  level?: ThinkLevel,
  provider?: string | null,
  model?: string | null,
): ThinkingLevel {
  // pi-agent-core supports "xhigh"; OpenClaw enables it for specific models.
  if (!level) {
    return "off";
  }
  const resolved = resolveMaxThinkLevel(level, provider, model) ?? level;
  return resolved === "max" ? "high" : resolved;
}

export function describeUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    const serialized = JSON.stringify(error);
    return serialized ?? "Unknown error";
  } catch {
    return "Unknown error";
  }
}

export type { ReasoningLevel, ThinkLevel };
