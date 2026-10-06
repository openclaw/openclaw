import type { TSchema } from "typebox";
import { copyCodeModeControlToolIdentity } from "../../code-mode-control-tools.js";
import type { AgentTool } from "../../runtime/index.js";
import { copyInternalToolExecutionPreparer } from "../../runtime/internal-hooks.js";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.js";

export function wrapToolDefinition<
  TParams extends TSchema = TSchema,
  TDetails = unknown,
  TState = unknown,
>(
  definition: ToolDefinition<TParams, TDetails, TState>,
  ctxFactory?: () => ExtensionContext,
): AgentTool<TParams, TDetails> {
  const tool: AgentTool<TParams, TDetails> = {
    name: definition.name,
    label: definition.label,
    ...(definition.hideFromChannelProgress === true ? { hideFromChannelProgress: true } : {}),
    ...(definition.resultContentSource
      ? { resultContentSource: definition.resultContentSource }
      : {}),
    description: definition.description,
    parameters: definition.parameters,
    ...(definition.outputSchema ? { outputSchema: definition.outputSchema } : {}),
    prepareArguments: definition.prepareArguments,
    executionMode: definition.executionMode,
    execute: (toolCallId, params, signal, onUpdate) =>
      definition.execute(toolCallId, params, signal, onUpdate, ctxFactory?.() as ExtensionContext),
  };
  copyCodeModeControlToolIdentity(definition, tool);
  return copyInternalToolExecutionPreparer(definition, tool);
}

/**
 * Synthesize a minimal ToolDefinition from an AgentTool.
 *
 * This keeps AgentSession's internal registry definition-first even when a caller
 * provides plain AgentTool overrides that do not include prompt metadata or renderers.
 */
export function createToolDefinitionFromAgentTool(tool: AgentTool): ToolDefinition {
  const definition: ToolDefinition = {
    name: tool.name,
    label: tool.label,
    ...(tool.hideFromChannelProgress === true ? { hideFromChannelProgress: true } : {}),
    ...(tool.resultContentSource ? { resultContentSource: tool.resultContentSource } : {}),
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    prepareArguments: tool.prepareArguments,
    executionMode: tool.executionMode,
    execute: async (toolCallId, params, signal, onUpdate) =>
      tool.execute(toolCallId, params, signal, onUpdate),
  };
  copyCodeModeControlToolIdentity(tool, definition);
  return copyInternalToolExecutionPreparer(tool, definition);
}
