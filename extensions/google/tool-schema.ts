const MAX_GOOGLE_TOOL_SCHEMA_DEPTH = 64;
const MAX_GOOGLE_TOOL_SCHEMA_NODES = 10_000;

export function materializeGoogleToolSchema(schema: unknown): unknown {
  const state = { nodes: 0 };
  return materializeGoogleToolSchemaValue(schema, state, 0, new Set<object>());
}

function materializeGoogleToolSchemaValue(
  schema: unknown,
  state: { nodes: number },
  depth: number,
  stack: Set<object>,
): unknown {
  if (depth > MAX_GOOGLE_TOOL_SCHEMA_DEPTH) {
    throw new Error("Google tool schema exceeds maximum supported depth");
  }
  if (++state.nodes > MAX_GOOGLE_TOOL_SCHEMA_NODES) {
    throw new Error("Google tool schema exceeds maximum supported size");
  }
  if (typeof schema !== "object" || schema === null) {
    return schema;
  }
  if (stack.has(schema)) {
    throw new Error("Google tool schema contains a cycle");
  }
  stack.add(schema);
  try {
    if (Array.isArray(schema)) {
      return schema.map((item) => materializeGoogleToolSchemaValue(item, state, depth + 1, stack));
    }
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema)) {
      Object.defineProperty(result, key, {
        value: materializeGoogleToolSchemaValue(value, state, depth + 1, stack),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  } finally {
    stack.delete(schema);
  }
}
