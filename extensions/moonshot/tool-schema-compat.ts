// Moonshot API rejects `{"type": "boolean"}` in tool parameter schemas with
// HTTP 400 "invalid scalar type [object boolean]". This module converts boolean
// schemas to `{"type": "string", "enum": ["true", "false"]}` so the API
// accepts them. The LLM still returns native JSON booleans in practice, so
// tool execute functions are unaffected.

import type {
  AnyAgentTool,
  ProviderNormalizeToolSchemasContext,
  ProviderToolSchemaDiagnostic,
} from "openclaw/plugin-sdk/plugin-entry";

function isBooleanSchema(schema: Record<string, unknown>): boolean {
  return schema.type === "boolean";
}

function convertBooleanNode(schema: Record<string, unknown>): Record<string, unknown> {
  const converted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "type") {
      converted.type = "string";
      continue;
    }
    converted[key] = value;
  }
  converted.enum = ["true", "false"];
  return converted;
}

function cleanSchemaForMoonshot(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map(cleanSchemaForMoonshot);
  }

  const obj = schema as Record<string, unknown>;

  if (isBooleanSchema(obj)) {
    return convertBooleanNode(obj);
  }

  const cleaned: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      cleaned[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [
          k,
          cleanSchemaForMoonshot(v),
        ]),
      );
    } else if (key === "items" && value && typeof value === "object") {
      cleaned[key] = Array.isArray(value)
        ? value.map(cleanSchemaForMoonshot)
        : cleanSchemaForMoonshot(value);
    } else if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)) {
      cleaned[key] = value.map(cleanSchemaForMoonshot);
    } else {
      cleaned[key] = value;
    }
  }

  return cleaned;
}

function findBooleanSchemaViolations(schema: unknown, path: string): string[] {
  if (!schema || typeof schema !== "object") {
    return [];
  }
  if (Array.isArray(schema)) {
    return schema.flatMap((item, index) => findBooleanSchemaViolations(item, `${path}[${index}]`));
  }
  const record = schema as Record<string, unknown>;
  const violations: string[] = [];

  if (isBooleanSchema(record)) {
    violations.push(`${path}.type=boolean`);
  }

  const properties =
    record.properties && typeof record.properties === "object" && !Array.isArray(record.properties)
      ? (record.properties as Record<string, unknown>)
      : undefined;
  if (properties) {
    for (const [key, value] of Object.entries(properties)) {
      violations.push(...findBooleanSchemaViolations(value, `${path}.properties.${key}`));
    }
  }

  for (const compKey of ["anyOf", "oneOf", "allOf"] as const) {
    const arr = record[compKey];
    if (Array.isArray(arr)) {
      violations.push(
        ...arr.flatMap((variant, i) =>
          findBooleanSchemaViolations(variant, `${path}.${compKey}[${i}]`),
        ),
      );
    }
  }

  if (record.items && typeof record.items === "object") {
    violations.push(...findBooleanSchemaViolations(record.items, `${path}.items`));
  }

  return violations;
}

export function normalizeMoonshotToolSchemas(
  ctx: ProviderNormalizeToolSchemasContext,
): AnyAgentTool[] {
  return ctx.tools.map((tool) => {
    if (!tool.parameters || typeof tool.parameters !== "object") {
      return tool;
    }
    return {
      ...tool,
      parameters: cleanSchemaForMoonshot(tool.parameters as Record<string, unknown>),
    };
  });
}

export function inspectMoonshotToolSchemas(
  ctx: ProviderNormalizeToolSchemasContext,
): ProviderToolSchemaDiagnostic[] {
  return ctx.tools.flatMap((tool, toolIndex) => {
    const violations = findBooleanSchemaViolations(tool.parameters, `${tool.name}.parameters`);
    if (violations.length === 0) {
      return [];
    }
    return [{ toolName: tool.name, toolIndex, violations }];
  });
}

export const __testing = {
  cleanSchemaForMoonshot,
  findBooleanSchemaViolations,
} as const;
