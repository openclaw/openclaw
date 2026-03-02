import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ReasoningLevel, ThinkLevel } from "../../auto-reply/thinking.js";
import type { ModelCompatConfig } from "../../config/types.models.js";

export function mapThinkingLevel(
  level?: ThinkLevel,
  modelCompat?: ModelCompatConfig,
): ThinkingLevel | undefined {
  // When the model explicitly declares it does not support the reasoning_effort
  // parameter, return undefined so pi-agent-core omits it entirely from the
  // API payload. This prevents 400 errors on providers like xAI/Grok that
  // reject unknown parameters.
  if (modelCompat?.supportsReasoningEffort === false) {
    return undefined;
  }
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
    const serialized = JSON.stringify(error);
    return serialized ?? "Unknown error";
  } catch {
    return "Unknown error";
  }
}

export type { ReasoningLevel, ThinkLevel };
