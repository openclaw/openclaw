import type { WorkerToolSurface } from "../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
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
import { resolveCoreToolExecutionLocation } from "./tool-catalog.js";
import { copyToolInvocationMetadata } from "./tool-invocation-metadata.js";
import { copyToolTerminalPresentation } from "./tool-terminal-presentation.js";

export type AgentToolActionDescriptor = Readonly<{
  family: "data" | "tool";
  operation: "filesystem" | "memory" | "openclaw" | "process";
}>;

export type AgentToolExecutionLocation =
  | { kind: "placement" }
  | {
      kind: "gateway";
      unavailableReason?: string;
      replay?: boolean;
      connectionScoped?: true;
      timeout?: WorkerToolSurface["tools"][number]["timeout"];
    };

type ToolActionState = {
  descriptor?: AgentToolActionDescriptor;
  executionLocation?: AgentToolExecutionLocation;
};

// Rebuilt tools retain prepared classification without adding weak-table edges.
class ToolActionMetadata extends PluginHostObject {
  #state: ToolActionState;

  constructor(tool: AnyAgentTool, state: ToolActionState) {
    super(tool);
    this.#state = { ...state };
  }

  static get(tool: AnyAgentTool): ToolActionState | undefined {
    return #state in tool ? tool.#state : undefined;
  }

  static set(tool: AnyAgentTool, state: ToolActionState): void {
    if (#state in tool) {
      Object.assign(tool.#state, state);
    } else {
      void new ToolActionMetadata(tool, state);
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

export function bindAgentToolExecutionLocation(
  tool: AnyAgentTool,
  location: AgentToolExecutionLocation,
): void {
  ToolActionMetadata.set(tool, { executionLocation: location });
}

export function getAgentToolExecutionLocation(tool: AnyAgentTool): AgentToolExecutionLocation {
  return (
    ToolActionMetadata.get(tool)?.executionLocation ?? {
      kind: resolveCoreToolExecutionLocation(tool.name),
    }
  );
}

export function bindAgentToolActionDescriptor(
  tool: AnyAgentTool,
  descriptor: AgentToolActionDescriptor,
): void {
  ToolActionMetadata.set(tool, { descriptor });
}

export function getAgentToolActionDescriptor(
  tool: AnyAgentTool,
): AgentToolActionDescriptor | undefined {
  return ToolActionMetadata.get(tool)?.descriptor;
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
  copyToolInvocationMetadata(source, target);
  const state = ToolActionMetadata.get(source);
  if (state) {
    ToolActionMetadata.set(target, state);
  }
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
  copyBeforeToolCallWrapperMetadata(source, target);
  copyBeforeToolCallMetadata(source, target, wrapExecution);
  copyCodeModeControlToolIdentity(source, target);
  copyCronScheduledToolProjection(source, target);
  copyInternalToolExecutionPreparer(source, target);
  return target;
}
