/**
 * Adjusts exec/process tool descriptions for long-running follow-up behavior.
 * Cron-aware runs can point models at scheduled follow-ups; cronless runs keep
 * guidance constrained to process polling and wake handling.
 */
import type { AnyAgentTool } from "./agent-tools.types.js";
import { describeExecTool, describeProcessTool } from "./bash-tools.descriptions.js";

/** Return tools with exec/process descriptions adjusted for cron availability. */
export function applyDeferredFollowupToolDescriptions(
  tools: AnyAgentTool[],
  params?: { agentId?: string },
): AnyAgentTool[] {
  const toolNames = tools.map(readToolName);
  const hasCronTool = toolNames.some((name) => name === "cron");
  return tools.map((tool, index) => {
    const name = toolNames[index];
    if (name === "exec") {
      return withToolDescription(tool, describeExecTool({ agentId: params?.agentId, hasCronTool }));
    }
    if (name === "process") {
      return withToolDescription(tool, describeProcessTool({ hasCronTool }));
    }
    return tool;
  });
}

function readToolName(tool: AnyAgentTool): string | undefined {
  try {
    return typeof tool.name === "string" ? tool.name : undefined;
  } catch {
    return undefined;
  }
}

function withToolDescription(tool: AnyAgentTool, description: string): AnyAgentTool {
  const clone = Object.create(Object.getPrototypeOf(tool)) as AnyAgentTool;
  Object.defineProperties(clone, Object.getOwnPropertyDescriptors(tool));
  Object.defineProperty(clone, "description", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: description,
  });
  return clone;
}
