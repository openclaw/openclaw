import type { TSchema } from "typebox";
import type { AgentTool } from "../../runtime/index.js";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.js";

/** Snapshot caller-owned tool definitions before registry code reads their fields. */
export function snapshotToolDefinitions(
  definitions: readonly ToolDefinition[] | undefined,
): ToolDefinition[] {
  const snapshots: ToolDefinition[] = [];
  for (const definition of definitions ?? []) {
    const snapshot = snapshotToolDefinition(definition);
    if (snapshot) {
      snapshots.push(snapshot);
    }
  }
  return snapshots;
}

function snapshotToolDefinition(definition: ToolDefinition): ToolDefinition | undefined {
  try {
    if (!definition || typeof definition !== "object") {
      return undefined;
    }
    const name = Reflect.get(definition, "name");
    const execute = Reflect.get(definition, "execute");
    if (typeof name !== "string" || name.length === 0 || typeof execute !== "function") {
      return undefined;
    }
    const promptGuidelines = Reflect.get(definition, "promptGuidelines");
    const prepareArguments = Reflect.get(definition, "prepareArguments");
    const renderCall = Reflect.get(definition, "renderCall");
    const renderResult = Reflect.get(definition, "renderResult");
    const executeWithReceiver = ((...args: Parameters<ToolDefinition["execute"]>) =>
      Reflect.apply(execute, definition, args)) as ToolDefinition["execute"];
    return {
      name,
      label: Reflect.get(definition, "label"),
      description: Reflect.get(definition, "description"),
      promptSnippet: Reflect.get(definition, "promptSnippet"),
      promptGuidelines: Array.isArray(promptGuidelines) ? [...promptGuidelines] : promptGuidelines,
      parameters: Reflect.get(definition, "parameters"),
      renderShell: Reflect.get(definition, "renderShell"),
      prepareArguments:
        typeof prepareArguments === "function"
          ? (((...args: Parameters<NonNullable<ToolDefinition["prepareArguments"]>>) =>
              Reflect.apply(
                prepareArguments,
                definition,
                args,
              )) as ToolDefinition["prepareArguments"])
          : prepareArguments,
      executionMode: Reflect.get(definition, "executionMode"),
      execute: executeWithReceiver,
      renderCall:
        typeof renderCall === "function"
          ? (((...args: Parameters<NonNullable<ToolDefinition["renderCall"]>>) =>
              Reflect.apply(renderCall, definition, args)) as ToolDefinition["renderCall"])
          : renderCall,
      renderResult:
        typeof renderResult === "function"
          ? (((...args: Parameters<NonNullable<ToolDefinition["renderResult"]>>) =>
              Reflect.apply(renderResult, definition, args)) as ToolDefinition["renderResult"])
          : renderResult,
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
