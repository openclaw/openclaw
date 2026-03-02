import { Type, type TSchema } from "@sinclair/typebox";

/**
 * Convert an MCP tool's JSON Schema `inputSchema` into a TypeBox TSchema
 * that OpenClaw's tool registration accepts.
 *
 * TypeBox's `Type.Unsafe()` wraps an arbitrary JSON Schema object so it
 * passes through validation while keeping the original schema intact for
 * the LLM tool-call layer.
 */
export function jsonSchemaToTypeBox(jsonSchema: Record<string, unknown> | undefined): TSchema {
  if (!jsonSchema || Object.keys(jsonSchema).length === 0) {
    return Type.Object({});
  }
  return Type.Unsafe(jsonSchema);
}
