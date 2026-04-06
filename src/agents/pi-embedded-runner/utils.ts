import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ReasoningLevel, ThinkLevel } from "../../auto-reply/thinking.js";
import { formatErrorMessage } from "../../infra/errors.js";

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
  // Delegate to formatErrorMessage which applies redactSensitiveText,
  // preventing stack traces, file paths, and credentials from leaking
  // into user-facing error messages and gateway error handling.
  // Guard: JSON.stringify(undefined) returns undefined at runtime despite
  // the string type signature, so preserve a fallback for callers that
  // chain string methods on the result.
  return formatErrorMessage(error) || "Unknown error";
}

export type { ReasoningLevel, ThinkLevel };
