/**
 * Tool schema simplification for llama-server grammar-based tool calling.
 *
 * ## Problem
 *
 * llama-server converts tool JSON schemas into BNF grammar rules for constrained
 * generation. With many tools having deeply nested schemas (e.g., `cron` with nested
 * `delivery.failureDestination` objects), the grammar complexity exceeds llama-server's
 * internal limits, causing it to fall back to unconstrained generation. The model then
 * generates tool calls as text (XML format) instead of structured `tool_calls`.
 *
 * ## Solution
 *
 * Simplify deeply nested schemas before passing them to the API:
 * - Flatten objects beyond a configurable depth to `{ type: "string" }` with a
 *   description noting the expected JSON structure
 * - Cap the number of properties per object
 * - Remove unsupported JSON Schema keywords that bloat the grammar
 *
 * This preserves tool functionality — the model still knows what parameters to pass —
 * while keeping the grammar within llama-server's limits.
 */

export type SimplifyOptions = {
  /** Maximum nesting depth before flattening to string. Default: 2. */
  maxDepth: number;
  /** Maximum properties per object level. Default: 12. */
  maxPropertiesPerLevel: number;
};

const DEFAULT_OPTIONS: SimplifyOptions = {
  maxDepth: 2,
  maxPropertiesPerLevel: 12,
};

type JsonSchema = Record<string, unknown>;

/**
 * Simplify a tool's parameter schema to reduce grammar complexity.
 * Returns a new schema object (does not mutate the input).
 */
export function simplifyToolSchema(
  schema: JsonSchema,
  opts?: Partial<SimplifyOptions>,
): JsonSchema {
  const options = { ...DEFAULT_OPTIONS, ...opts };
  return simplifyObject(schema, 0, options);
}

function simplifyObject(schema: JsonSchema, depth: number, opts: SimplifyOptions): JsonSchema {
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  // If we've exceeded max depth, collapse to a string description
  if (depth > opts.maxDepth && schema.type === "object") {
    const desc =
      typeof schema.description === "string" ? schema.description : describeCollapsedObject(schema);
    return {
      type: "string",
      description: `JSON object: ${desc}`,
    };
  }

  const result: JsonSchema = { ...schema };

  // Simplify properties recursively
  if (result.properties && typeof result.properties === "object") {
    const props = result.properties as Record<string, JsonSchema>;
    const propKeys = Object.keys(props);

    // Cap properties if too many
    if (propKeys.length > opts.maxPropertiesPerLevel) {
      const kept: Record<string, JsonSchema> = {};
      const required = new Set(Array.isArray(result.required) ? (result.required as string[]) : []);

      // Keep required properties first, then fill up to the cap
      let count = 0;
      for (const key of propKeys) {
        if (required.has(key) && count < opts.maxPropertiesPerLevel) {
          kept[key] = simplifyObject(props[key] ?? {}, depth + 1, opts);
          count++;
        }
      }
      for (const key of propKeys) {
        if (!required.has(key) && count < opts.maxPropertiesPerLevel) {
          kept[key] = simplifyObject(props[key] ?? {}, depth + 1, opts);
          count++;
        }
      }

      result.properties = kept;
      // Allow additional properties for the dropped ones
      result.additionalProperties = true;
    } else {
      const simplified: Record<string, JsonSchema> = {};
      for (const [key, value] of Object.entries(props)) {
        simplified[key] = simplifyObject(value, depth + 1, opts);
      }
      result.properties = simplified;
    }
  }

  // Simplify array items
  if (result.items && typeof result.items === "object") {
    result.items = simplifyObject(result.items as JsonSchema, depth + 1, opts);
  }

  // Simplify oneOf/anyOf/allOf
  for (const keyword of ["oneOf", "anyOf", "allOf"] as const) {
    if (Array.isArray(result[keyword])) {
      result[keyword] = (result[keyword] as JsonSchema[]).map((s) =>
        simplifyObject(s, depth, opts),
      );
    }
  }

  // Remove keywords that bloat grammar without adding value for local models
  delete result.$schema;
  delete result.$id;
  delete result.$ref;
  delete result.examples;
  delete result.default; // Grammar doesn't use defaults

  return result;
}

/**
 * Generate a human-readable description for a collapsed nested object.
 */
function describeCollapsedObject(schema: JsonSchema): string {
  const props = schema.properties as Record<string, JsonSchema> | undefined;
  if (!props) {
    return "object with arbitrary properties";
  }
  const keys = Object.keys(props).slice(0, 5);
  const suffix = Object.keys(props).length > 5 ? ", ..." : "";
  return `{${keys.join(", ")}${suffix}}`;
}

/**
 * Simplify all tool definitions in-place for a llama-server request.
 * Returns a new array (does not mutate the input).
 */
export function simplifyToolsForLlamaServer(
  tools: Array<{
    type: string;
    function: { name: string; description?: string; parameters?: JsonSchema; strict?: boolean };
  }>,
  opts?: Partial<SimplifyOptions>,
): typeof tools {
  return tools.map((tool) => ({
    ...tool,
    function: {
      ...tool.function,
      parameters: tool.function.parameters
        ? simplifyToolSchema(tool.function.parameters, opts)
        : tool.function.parameters,
      // Remove strict field — llama-server doesn't support it
      strict: undefined,
    },
  }));
}
