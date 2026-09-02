import type { ToolResultObject } from "@github/copilot-sdk";
import type {
  AnyAgentTool,
  EmbeddedRunAttemptParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveEmbeddedAttemptToolConstructionPlan } from "openclaw/plugin-sdk/agent-harness-runtime";
import { toStringifiedError as toCopilotToolError } from "openclaw/plugin-sdk/error-runtime";

const BASE_COPILOT_CODING_TOOL_NAMES = new Set(["edit", "read", "write"]);
const SHELL_COPILOT_CODING_TOOL_NAMES = new Set(["apply_patch", "exec", "process"]);

export type CopilotToolAttemptParams = Partial<
  Omit<EmbeddedRunAttemptParamsV2, "hostCapabilities">
> &
  Pick<EmbeddedRunAttemptParamsV2, "hostCapabilities">;

export function toToolStartArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>) // SAFETY: the guards exclude null, arrays, and primitives.
    : { value: args };
}

export function createFailureResult(message: string, error: unknown): ToolResultObject {
  return {
    error: toCopilotToolError(error).message,
    resultType: "failure",
    textResultForLlm: message,
  };
}

export function createError(message: string, cause: unknown): Error {
  return new Error(message, { cause });
}

export function shouldForceCopilotMessageTool(params: CopilotToolAttemptParams): boolean {
  if (params.disableMessageTool === true) {
    return false;
  }
  return params.forceMessageTool === true || params.sourceReplyDeliveryMode === "message_tool_only";
}

export function filterCopilotToolsForConstructionPlan<T extends { name: string }>(
  tools: T[],
  plan: ReturnType<typeof resolveEmbeddedAttemptToolConstructionPlan>["codingToolConstructionPlan"],
  options: { preserveToolNames?: readonly string[] } = {},
): T[] {
  if (plan.includeBaseCodingTools && plan.includeShellTools) {
    return tools;
  }
  const preserveToolNames = new Set(options.preserveToolNames);
  return tools.filter((tool) => {
    if (preserveToolNames.has(tool.name)) {
      return true;
    }
    if (!plan.includeBaseCodingTools && BASE_COPILOT_CODING_TOOL_NAMES.has(tool.name)) {
      return false;
    }
    if (!plan.includeShellTools && SHELL_COPILOT_CODING_TOOL_NAMES.has(tool.name)) {
      return false;
    }
    return true;
  });
}

export function readInlinePluginToolMeta(tool: { name: string }): { pluginId: string } | undefined {
  const pluginId = Reflect.get(tool, "pluginId");
  return typeof pluginId === "string" && pluginId.trim() ? { pluginId } : undefined;
}

export function findDuplicateToolNames(sourceTools: AnyAgentTool[]): string[] {
  const counts = new Map<string, number>();
  for (const sourceTool of sourceTools) {
    if (typeof sourceTool.name !== "string" || sourceTool.name.length === 0) {
      continue;
    }
    counts.set(sourceTool.name, (counts.get(sourceTool.name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([name]) => name)
    .toSorted();
}
