/**
 * Tool definition/AgentTool adapters.
 *
 * Bridges extension-style ToolDefinition objects and core runtime AgentTool objects.
 */
import type { TSchema } from "typebox";
import { logError } from "../../../logger.js";
import { isPlainObject } from "../../../utils.js";
import type { AgentTool } from "../../runtime/index.js";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.js";

const SESSION_TOOL_SCHEMA_MAX_DEPTH = 24;
const SESSION_TOOL_SCHEMA_MAX_NODES = 1_000;

class InvalidSessionToolSchemaError extends Error {
  constructor() {
    super("parameters schema is not JSON-document-compatible");
    this.name = "InvalidSessionToolSchemaError";
  }
}

type SessionToolSchemaCloneState = {
  seen: WeakSet<object>;
  nodes: number;
};

function describeSessionToolSnapshotError(err: unknown): string {
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return String(err);
}

function readStringField(value: unknown, fieldName: string, fallback?: string): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (value == null || value === "") {
    if (fallback !== undefined) {
      return fallback;
    }
    throw new Error(`${fieldName} is required`);
  }
  throw new Error(`${fieldName} must be a string`);
}

function cloneSessionToolSchema<TParams extends TSchema>(schema: TParams): TParams {
  if (schema === undefined) {
    return undefined as unknown as TParams;
  }
  return cloneSessionToolSchemaValue(
    schema,
    {
      seen: new WeakSet<object>(),
      nodes: 0,
    },
    0,
  ) as TParams;
}

function cloneSessionToolSchemaValue(
  value: unknown,
  state: SessionToolSchemaCloneState,
  depth: number,
): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new InvalidSessionToolSchemaError();
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new InvalidSessionToolSchemaError();
  }
  if (depth > SESSION_TOOL_SCHEMA_MAX_DEPTH || state.seen.has(value)) {
    throw new InvalidSessionToolSchemaError();
  }
  state.nodes += 1;
  if (state.nodes > SESSION_TOOL_SCHEMA_MAX_NODES) {
    throw new InvalidSessionToolSchemaError();
  }
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => cloneSessionToolSchemaValue(entry, state, depth + 1));
    }
    if (!isPlainObject(value)) {
      throw new InvalidSessionToolSchemaError();
    }
    const cloned: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) {
        continue;
      }
      const rawValue = "value" in descriptor ? descriptor.value : Reflect.get(value, key);
      const clonedValue = cloneSessionToolSchemaValue(rawValue, state, depth + 1);
      Object.defineProperty(cloned, key, {
        value: clonedValue,
        enumerable: descriptor.enumerable,
        configurable: true,
        writable: true,
      });
    }
    return cloned;
  } finally {
    state.seen.delete(value);
  }
}

/** Snapshot a session ToolDefinition before it crosses runtime boundaries. */
export function snapshotSessionToolDefinition<
  TParams extends TSchema = TSchema,
  TDetails = unknown,
  TState = unknown,
>(
  definition: ToolDefinition<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails, TState> | undefined {
  let name = "tool";
  try {
    name = readStringField(definition.name, "tool name");
    const label = readStringField(definition.label, "tool label", name);
    const description = typeof definition.description === "string" ? definition.description : "";
    const parameters = cloneSessionToolSchema(definition.parameters);
    const executeValue = Reflect.get(definition, "execute");
    if (typeof executeValue !== "function") {
      throw new Error("tool execute must be a function");
    }
    const execute = executeValue.bind(definition);
    const promptSnippet =
      typeof definition.promptSnippet === "string" ? definition.promptSnippet : undefined;
    const promptGuidelines = Array.isArray(definition.promptGuidelines)
      ? definition.promptGuidelines.filter((entry): entry is string => typeof entry === "string")
      : undefined;
    const renderShell =
      definition.renderShell === "default" || definition.renderShell === "self"
        ? definition.renderShell
        : undefined;
    const prepareArgumentsValue = Reflect.get(definition, "prepareArguments");
    const prepareArguments =
      typeof prepareArgumentsValue === "function"
        ? (prepareArgumentsValue.bind(definition) as ToolDefinition<
            TParams,
            TDetails,
            TState
          >["prepareArguments"])
        : undefined;
    const executionMode =
      definition.executionMode === "parallel" || definition.executionMode === "sequential"
        ? definition.executionMode
        : undefined;
    const renderCallValue = Reflect.get(definition, "renderCall");
    const renderCall =
      typeof renderCallValue === "function"
        ? (renderCallValue.bind(definition) as ToolDefinition<
            TParams,
            TDetails,
            TState
          >["renderCall"])
        : undefined;
    const renderResultValue = Reflect.get(definition, "renderResult");
    const renderResult =
      typeof renderResultValue === "function"
        ? (renderResultValue.bind(definition) as ToolDefinition<
            TParams,
            TDetails,
            TState
          >["renderResult"])
        : undefined;

    return {
      name,
      label,
      description,
      ...(promptSnippet !== undefined ? { promptSnippet } : {}),
      ...(promptGuidelines && promptGuidelines.length > 0 ? { promptGuidelines } : {}),
      parameters,
      ...(renderShell ? { renderShell } : {}),
      ...(prepareArguments ? { prepareArguments } : {}),
      ...(executionMode ? { executionMode } : {}),
      execute: (toolCallId, params, signal, onUpdate, ctx) =>
        execute(toolCallId, params, signal, onUpdate, ctx),
      ...(renderCall ? { renderCall } : {}),
      ...(renderResult ? { renderResult } : {}),
    } satisfies ToolDefinition<TParams, TDetails, TState>;
  } catch (err) {
    logError(
      `[tools] skipped invalid session tool definition "${name}": ${describeSessionToolSnapshotError(err)}`,
    );
    return undefined;
  }
}

/** Snapshot a batch of session ToolDefinitions, dropping only malformed tools. */
export function snapshotSessionToolDefinitions(
  definitions: readonly ToolDefinition[],
): ToolDefinition[] {
  const snapshots: ToolDefinition[] = [];
  for (const definition of definitions) {
    const snapshot = snapshotSessionToolDefinition(definition);
    if (snapshot) {
      snapshots.push(snapshot);
    }
  }
  return snapshots;
}

function wrapSessionToolDefinitionSnapshot<TParams extends TSchema = TSchema, TDetails = unknown>(
  definition: ToolDefinition<TParams, TDetails>,
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

/** Wrap a ToolDefinition into an AgentTool for the core runtime. */
export function wrapToolDefinition<
  TParams extends TSchema = TSchema,
  TDetails = unknown,
  TState = unknown,
>(
  definition: ToolDefinition<TParams, TDetails, TState>,
  ctxFactory?: () => ExtensionContext,
): AgentTool<TParams, TDetails> {
  const snapshot = snapshotSessionToolDefinition(definition);
  if (!snapshot) {
    throw new Error("invalid session tool definition");
  }
  return wrapSessionToolDefinitionSnapshot(snapshot, ctxFactory);
}

/** Wrap multiple ToolDefinitions into AgentTools for the core runtime. */
export function wrapToolDefinitions(
  definitions: ToolDefinition[],
  ctxFactory?: () => ExtensionContext,
): AgentTool[] {
  return snapshotSessionToolDefinitions(definitions).map((definition) =>
    wrapSessionToolDefinitionSnapshot(definition, ctxFactory),
  );
}

function snapshotAgentToolAsDefinition(tool: AgentTool): ToolDefinition | undefined {
  let name = "tool";
  try {
    name = readStringField(tool.name, "tool name");
    const label = readStringField(tool.label, "tool label", name);
    const description = typeof tool.description === "string" ? tool.description : "";
    const parameters = cloneSessionToolSchema(tool.parameters);
    const executeValue = Reflect.get(tool, "execute");
    if (typeof executeValue !== "function") {
      throw new Error("tool execute must be a function");
    }
    const execute = executeValue.bind(tool);
    const prepareArgumentsValue = Reflect.get(tool, "prepareArguments");
    const prepareArguments =
      typeof prepareArgumentsValue === "function"
        ? (prepareArgumentsValue.bind(tool) as AgentTool["prepareArguments"])
        : undefined;
    return {
      name,
      label,
      description,
      parameters,
      ...(prepareArguments ? { prepareArguments } : {}),
      ...(tool.executionMode === "parallel" || tool.executionMode === "sequential"
        ? { executionMode: tool.executionMode }
        : {}),
      execute: async (toolCallId, params, signal, onUpdate) =>
        execute(toolCallId, params, signal, onUpdate),
    } satisfies ToolDefinition;
  } catch (err) {
    logError(
      `[tools] skipped invalid agent tool definition "${name}": ${describeSessionToolSnapshotError(err)}`,
    );
    return undefined;
  }
}

/**
 * Synthesize a minimal ToolDefinition from an AgentTool.
 *
 * This keeps AgentSession's internal registry definition-first even when a caller
 * provides plain AgentTool overrides that do not include prompt metadata or renderers.
 */
export function createToolDefinitionFromAgentTool(tool: AgentTool): ToolDefinition {
  const snapshot = snapshotAgentToolAsDefinition(tool);
  if (!snapshot) {
    throw new Error("invalid agent tool definition");
  }
  return snapshot;
}

/** Convert a base-tool override record while quarantining malformed entries. */
export function createToolDefinitionsFromAgentTools(
  tools: Record<string, AgentTool>,
): Record<string, ToolDefinition> {
  const definitions: Record<string, ToolDefinition> = {};
  for (const tool of Object.values(tools)) {
    const definition = snapshotAgentToolAsDefinition(tool);
    if (definition) {
      definitions[definition.name] = definition;
    }
  }
  return definitions;
}
