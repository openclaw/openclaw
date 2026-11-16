import type { AnyAgentTool } from "./agent-tools.types.js";

/** Data projection needs no executor, policy resolution, or tool admission. */
type ToolDefinitionSource = Pick<AnyAgentTool, "name" | "description" | "parameters"> &
  Partial<
    Pick<
      AnyAgentTool,
      | "label"
      | "hideFromChannelProgress"
      | "resultContentSource"
      | "executionMode"
      | "async"
      | "repeatable"
    >
  >;

export function projectAgentToolDefinition(tool: ToolDefinitionSource) {
  const name = tool.name || "tool";
  return {
    name,
    label: tool.label ?? name,
    ...(tool.hideFromChannelProgress === true ? { hideFromChannelProgress: true as const } : {}),
    ...(tool.resultContentSource ? { resultContentSource: tool.resultContentSource } : {}),
    description: tool.description ?? "",
    parameters: tool.parameters,
    executionMode: tool.executionMode,
    ...(tool.async === false ? { async: false as const } : {}),
    ...(tool.repeatable ? { repeatable: tool.repeatable } : {}),
  };
}
