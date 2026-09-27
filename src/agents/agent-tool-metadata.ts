import { PluginHostObject } from "../plugins/plugin-instance-owned-values.js";
import { copyPluginToolMeta, getPluginToolMeta } from "../plugins/tool-metadata.js";
import { copyAgentToolAvailability } from "./agent-tool-availability.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import {
  copyBeforeToolCallMetadata,
  type ToolExecutionWrapper,
} from "./before-tool-call-metadata.js";
import { copyChannelAgentToolMeta } from "./channel-tool-metadata.js";
import { copyCodeModeControlToolIdentity } from "./code-mode-control-tools.js";
import { copyCronScheduledToolProjection } from "./exec-tool-target-pinning.js";
import { copyInternalToolExecutionPreparer } from "./runtime/internal-hooks.js";
import { copyToolTerminalPresentation } from "./tool-terminal-presentation.js";

export type AgentToolActionDescriptor = Readonly<{
  family: "data" | "tool";
  operation: "filesystem" | "memory" | "openclaw" | "process";
}>;

// Rebuilt tools retain prepared classification without adding weak-table edges.
class ToolActionMetadata extends PluginHostObject {
  #descriptor: AgentToolActionDescriptor;

  constructor(tool: AnyAgentTool, descriptor: AgentToolActionDescriptor) {
    super(tool);
    this.#descriptor = descriptor;
  }

  static get(this: void, tool: AnyAgentTool): AgentToolActionDescriptor | undefined {
    return #descriptor in tool ? tool.#descriptor : undefined;
  }

  static set(this: void, tool: AnyAgentTool, descriptor: AgentToolActionDescriptor): void {
    if (#descriptor in tool) {
      tool.#descriptor = descriptor;
    } else {
      void new ToolActionMetadata(tool, descriptor);
    }
  }
}

const memoryAction: AgentToolActionDescriptor = Object.freeze({
  family: "data",
  operation: "memory",
});
const openclawAction: AgentToolActionDescriptor = Object.freeze({
  family: "tool",
  operation: "openclaw",
});

export const bindAgentToolActionDescriptor = ToolActionMetadata.set;
export const getAgentToolActionDescriptor = ToolActionMetadata.get;

function copyAgentToolActionDescriptor(source: AnyAgentTool, target: AnyAgentTool): void {
  const descriptor = getAgentToolActionDescriptor(source);
  if (descriptor) {
    bindAgentToolActionDescriptor(target, descriptor);
  }
}

/** Preserve only the metadata owned by a before-tool-call wrapper rebuild. */
export function copyBeforeToolCallWrapperMetadata(
  source: AnyAgentTool,
  target: AnyAgentTool,
): void {
  copyPluginToolMeta(source, target);
  // SAFETY: both metadata owners attach to the same runtime tool object shape.
  copyChannelAgentToolMeta(source as never, target as never);
  copyToolTerminalPresentation(source, target);
  copyAgentToolActionDescriptor(source, target);
  copyAgentToolAvailability(source, target);
}

/** Bind the broad family at final assembly from private, process-stable owner metadata. */
export function bindAssembledAgentToolActionDescriptor(tool: AnyAgentTool): void {
  if (getAgentToolActionDescriptor(tool)) {
    return;
  }
  const kind = getPluginToolMeta(tool)?.kind;
  const memory = kind === "memory" || (Array.isArray(kind) && kind.includes("memory"));
  bindAgentToolActionDescriptor(tool, memory ? memoryAction : openclawAction);
}

/**
 * Preserve identity-backed tool metadata that object spread cannot carry.
 * Losing it detaches policy, hooks, presentation, and control-flow ownership.
 */
export function copyAgentToolMetadata<T extends AnyAgentTool>(
  source: AnyAgentTool,
  target: T,
  wrapExecution?: ToolExecutionWrapper,
): T {
  if (source === target) {
    return target;
  }
  copyPluginToolMeta(source, target);
  copyChannelAgentToolMeta(source as never, target as never);
  copyBeforeToolCallMetadata(source, target, wrapExecution);
  copyToolTerminalPresentation(source, target);
  copyCodeModeControlToolIdentity(source, target);
  copyCronScheduledToolProjection(source, target);
  copyInternalToolExecutionPreparer(source, target);
  copyAgentToolActionDescriptor(source, target);
  copyAgentToolAvailability(source, target);
  return target;
}
