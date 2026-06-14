/**
 * Tool definition/AgentTool adapters.
 *
 * Bridges extension-style ToolDefinition objects and core runtime AgentTool objects.
 */
import type { TSchema } from "typebox";
import type { AgentTool } from "../../runtime/index.js";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.js";

export function readToolDefinitionName(definition: ToolDefinition): string | undefined {
  try {
    const name = definition.name as unknown;
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}

export function snapshotReadableToolDefinition<
  TParams extends TSchema = TSchema,
  TDetails = unknown,
  TState = unknown,
>(
  definition: ToolDefinition<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails, TState> | undefined {
  try {
    const name = definition.name as unknown;
    const label = definition.label as unknown;
    const description = definition.description as unknown;
    const parameters = definition.parameters;
    const execute = Reflect.get(definition, "execute") as unknown;

    if (
      typeof name !== "string" ||
      typeof label !== "string" ||
      typeof description !== "string" ||
      parameters === undefined ||
      typeof execute !== "function"
    ) {
      return undefined;
    }

    const executeTool = execute as ToolDefinition<TParams, TDetails, TState>["execute"];
    const promptSnippet = definition.promptSnippet;
    const promptGuidelines = definition.promptGuidelines;
    const renderShell = definition.renderShell;
    const prepareArguments = definition.prepareArguments;
    const executionMode = definition.executionMode;
    const renderCall = definition.renderCall;
    const renderResult = definition.renderResult;

    return {
      name,
      label,
      description,
      promptSnippet,
      promptGuidelines,
      parameters,
      renderShell,
      prepareArguments,
      executionMode,
      execute: (toolCallId, params, signal, onUpdate, ctx) =>
        executeTool.call(definition, toolCallId, params, signal, onUpdate, ctx),
      renderCall,
      renderResult,
    };
  } catch {
    return undefined;
  }
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
  const snapshot = snapshotReadableToolDefinition(definition);
  if (!snapshot) {
    throw new Error("Cannot wrap unreadable tool definition");
  }

  return {
    name: snapshot.name,
    label: snapshot.label,
    description: snapshot.description,
    parameters: snapshot.parameters,
    prepareArguments: snapshot.prepareArguments,
    executionMode: snapshot.executionMode,
    execute: (toolCallId, params, signal, onUpdate) =>
      snapshot.execute(toolCallId, params, signal, onUpdate, ctxFactory?.() as ExtensionContext),
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
export function createToolDefinitionFromAgentTool(tool: AgentTool): ToolDefinition {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    prepareArguments: tool.prepareArguments,
    executionMode: tool.executionMode,
    execute: async (toolCallId, params, signal, onUpdate) =>
      tool.execute(toolCallId, params, signal, onUpdate),
  };
}
