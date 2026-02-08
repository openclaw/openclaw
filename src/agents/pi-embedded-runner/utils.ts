import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ReasoningLevel, ThinkLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { ModelCompatConfig } from "../../config/types.models.js";
import type { ExecToolDefaults } from "../bash-tools.js";

export function mapThinkingLevel(
  level: ThinkLevel | undefined,
  modelCompat?: ModelCompatConfig,
): ThinkingLevel | undefined {
  // If model doesn't support reasoning_effort parameter, return undefined
  // so the SDK doesn't pass it to the API
  if (modelCompat?.supportsReasoningEffort === false) {
    return undefined;
  }

  // pi-agent-core supports "xhigh"; OpenClaw enables it for specific models.
  if (!level) {
    return "off";
  }
  return level;
}

export function resolveExecToolDefaults(config?: OpenClawConfig): ExecToolDefaults | undefined {
  const tools = config?.tools;
  if (!tools?.exec) {
    return undefined;
  }
  return tools.exec;
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
