/**
 * Converts Cortex JSON Schema tool definitions into TypeBox schemas
 * that pi-agent-core expects for AgentTool.parameters.
 *
 * This bridges the gap between Cortex's REST API (JSON Schema)
 * and OpenClaw's tool system (TypeBox via @sinclair/typebox).
 */

import { Type, type TSchema } from "@sinclair/typebox";
import type { CortexTool, CortexToolCallResult } from "./client.js";
import type { CortexClient } from "./client.js";

/**
 * Convert a JSON Schema object into a TypeBox schema.
 *
 * Handles the common JSON Schema types that Cortex tools use:
 * - object (with properties and required)
 * - string (with optional enum, description, default)
 * - number / integer
 * - boolean
 * - array (with items)
 * - null
 */
export function jsonSchemaToTypebox(schema: Record<string, unknown>): TSchema {
  const type = schema.type as string | undefined;
  const description = schema.description as string | undefined;

  switch (type) {
    case "object": {
      const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
      const required = (schema.required ?? []) as string[];
      const requiredSet = new Set(required);
      const props: Record<string, TSchema> = {};

      for (const [key, propSchema] of Object.entries(properties)) {
        let converted = jsonSchemaToTypebox(propSchema);
        if (!requiredSet.has(key)) {
          converted = Type.Optional(converted);
        }
        props[key] = converted;
      }

      return Type.Object(props, description ? { description } : undefined);
    }

    case "string": {
      const enumValues = schema.enum as string[] | undefined;
      if (enumValues && enumValues.length > 0) {
        const union = Type.Union(
          enumValues.map((v) => Type.Literal(v)),
          description ? { description } : undefined,
        );
        return union;
      }
      return Type.String(buildOptions(description, schema.default as string | undefined));
    }

    case "number":
      return Type.Number(buildOptions(description, schema.default as number | undefined));

    case "integer":
      return Type.Integer(buildOptions(description, schema.default as number | undefined));

    case "boolean":
      return Type.Boolean(buildOptions(description, schema.default as boolean | undefined));

    case "array": {
      const items = (schema.items ?? { type: "string" }) as Record<string, unknown>;
      return Type.Array(jsonSchemaToTypebox(items), description ? { description } : undefined);
    }

    case "null":
      return Type.Null(description ? { description } : undefined);

    default:
      // Unknown or missing type — fall back to generic unknown
      return Type.Unknown(description ? { description } : undefined);
  }
}

function buildOptions(
  description?: string,
  defaultValue?: unknown,
): Record<string, unknown> | undefined {
  const opts: Record<string, unknown> = {};
  if (description) opts.description = description;
  if (defaultValue !== undefined) opts.default = defaultValue;
  return Object.keys(opts).length > 0 ? opts : undefined;
}

/**
 * Convert a Cortex tool definition into an OpenClaw AgentTool-shaped object.
 *
 * The returned object has:
 * - name: prefixed with "cortex_" for namespace clarity
 * - description: from the Cortex tool
 * - parameters: TypeBox schema converted from JSON Schema
 * - execute(): calls Cortex REST API via the client
 */
export function createCortexAgentTool(tool: CortexTool, client: CortexClient) {
  return {
    name: `cortex_${tool.name}`,
    label: `Cortex: ${tool.name.replace("__", " \u2192 ")}`,
    description: tool.description,
    parameters: jsonSchemaToTypebox(tool.inputSchema),

    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<{
      content: Array<{ type: string; text: string }>;
      details?: unknown;
    }> {
      try {
        const result: CortexToolCallResult = await client.callTool(tool.name, params);

        if (!result.success) {
          const errorText = result.error ?? "Cortex tool execution failed";
          const errorCode = result.error_code ? ` [${result.error_code}]` : "";
          return {
            content: [{ type: "text", text: `Error${errorCode}: ${errorText}` }],
          };
        }

        const text =
          result.data != null
            ? typeof result.data === "string"
              ? result.data
              : JSON.stringify(result.data, null, 2)
            : "OK";

        return {
          content: [{ type: "text", text }],
          details: result,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown Cortex error";
        return {
          content: [{ type: "text", text: `Cortex connection error: ${message}` }],
        };
      }
    },
  };
}
