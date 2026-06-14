const MAX_GOOGLE_EXTENSION_TOOL_SCHEMA_NODES = 1_000;

type GoogleExtensionToolSchemaReadState = {
  stack: WeakSet<object>;
  nodes: number;
};

export type GoogleExtensionToolDeclarationInput = {
  name: string;
  description?: string;
  parameters?: unknown;
};

export type GoogleExtensionFunctionDeclaration = {
  name: string;
  description?: string;
  parametersJsonSchema?: unknown;
};

export function buildGoogleExtensionFunctionDeclarations<
  TTool extends GoogleExtensionToolDeclarationInput,
  TExtra extends Record<string, unknown> = Record<string, never>,
>(
  tools: readonly TTool[] | undefined,
  decorate?: (tool: TTool, name: string) => TExtra,
): Array<GoogleExtensionFunctionDeclaration & Partial<TExtra>> {
  return (tools ?? []).flatMap((tool) => {
    try {
      const name = tool.name.trim();
      if (!name) {
        return [];
      }
      const parametersJsonSchema = snapshotGoogleExtensionToolSchema(tool.parameters);
      return [
        {
          name,
          ...(typeof tool.description === "string" ? { description: tool.description } : {}),
          parametersJsonSchema,
          ...decorate?.(tool, name),
        },
      ];
    } catch {
      return [];
    }
  });
}

function snapshotGoogleExtensionToolSchema(
  schema: unknown,
  state: GoogleExtensionToolSchemaReadState = { stack: new WeakSet(), nodes: 0 },
): unknown {
  state.nodes += 1;
  if (state.nodes > MAX_GOOGLE_EXTENSION_TOOL_SCHEMA_NODES) {
    throw new Error("Google extension tool schema exceeds traversal budget");
  }
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (state.stack.has(schema)) {
    throw new Error("Google extension tool schema contains cyclic object references");
  }
  state.stack.add(schema);

  try {
    if (Array.isArray(schema)) {
      try {
        return Array.from(schema, (value) => snapshotGoogleExtensionToolSchema(value, state));
      } catch {
        throw new Error("Google extension tool schema array is unreadable");
      }
    }
    const snapshot: Record<string, unknown> = {};
    try {
      for (const key of Object.keys(schema)) {
        snapshot[key] = snapshotGoogleExtensionToolSchema(
          (schema as Record<string, unknown>)[key],
          state,
        );
      }
    } catch {
      throw new Error("Google extension tool schema object is unreadable");
    }
    return snapshot;
  } finally {
    state.stack.delete(schema);
  }
}
