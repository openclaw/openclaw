import { Type, type TSchema } from "typebox";
import type { AgentTool } from "../../runtime/index.js";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.js";

function createFallbackToolParameters(): TSchema {
  return Type.Object({});
}

function readAgentToolField(tool: AgentTool, key: keyof AgentTool): unknown {
  try {
    return tool[key];
  } catch {
    return undefined;
  }
}

function readAgentToolString(tool: AgentTool, key: keyof AgentTool): string | undefined {
  const value = readAgentToolField(tool, key);
  return typeof value === "string" && value ? value : undefined;
}

/** Wrap a ToolDefinition into an AgentTool for the core runtime. */
export function wrapToolDefinition<
  TParams extends TSchema = TSchema,
  TDetails = unknown,
  TState = unknown,
>(
  definition: ToolDefinition<TParams, TDetails, TState>,
  ctxFactory?: () => ExtensionContext,
): AgentTool<TParams, TDetails> {
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters,
    prepareArguments: definition.prepareArguments,
    executionMode: definition.executionMode,
    execute: (toolCallId, params, signal, onUpdate) =>
      definition.execute(toolCallId, params, signal, onUpdate, ctxFactory?.() as ExtensionContext),
  };
}

/** Wrap multiple ToolDefinitions into AgentTools for the core runtime. */
export function wrapToolDefinitions(
  definitions: ToolDefinition[],
  ctxFactory?: () => ExtensionContext,
): AgentTool[] {
  return definitions.map((definition) => wrapToolDefinition(definition, ctxFactory));
}

/**
 * Synthesize a minimal ToolDefinition from an AgentTool.
 *
 * This keeps AgentSession's internal registry definition-first even when a caller
 * provides plain AgentTool overrides that do not include prompt metadata or renderers.
 */
export function createToolDefinitionFromAgentTool(
  tool: AgentTool,
  fallbackName?: string,
): ToolDefinition {
  const name = readAgentToolString(tool, "name") ?? fallbackName ?? "tool";
  const label = readAgentToolString(tool, "label") ?? name;
  const description = readAgentToolString(tool, "description") ?? "";
  const parametersValue = readAgentToolField(tool, "parameters");
  const parameters =
    parametersValue && typeof parametersValue === "object"
      ? (parametersValue as TSchema)
      : createFallbackToolParameters();
  const prepareArguments = readAgentToolField(tool, "prepareArguments") as
    | AgentTool["prepareArguments"]
    | undefined;
  const executionMode = readAgentToolField(tool, "executionMode") as
    | AgentTool["executionMode"]
    | undefined;

  return {
    name,
    label,
    description,
    parameters,
    prepareArguments,
    executionMode,
    execute: async (toolCallId, params, signal, onUpdate) =>
      tool.execute(toolCallId, params, signal, onUpdate),
  };
}
