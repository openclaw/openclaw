import type { AnyAgentTool } from "./api.js";

const AIMLAPI_UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
  "anyOf",
  "oneOf",
  "allOf",
  "patternProperties",
  "additionalProperties",
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "definitions",
  "examples",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "multipleOf",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
]);

type ToolChoiceRecord = {
  type?: unknown;
  name?: unknown;
  function?: { name?: unknown } | unknown;
};

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function extractLiteralEnum(variants: unknown[]): { type?: string; enum: unknown[] } | null {
  if (variants.length === 0) {
    return null;
  }
  const out: unknown[] = [];
  let commonType: string | undefined;
  for (const variant of variants) {
    const record = toRecord(variant);
    if (!record) {
      return null;
    }
    let literal: unknown;
    if ("const" in record) {
      literal = record.const;
    } else if (Array.isArray(record.enum) && record.enum.length === 1) {
      literal = record.enum[0];
    } else {
      return null;
    }
    out.push(literal);
    if (typeof record.type === "string") {
      commonType = commonType ?? record.type;
      if (commonType !== record.type) {
        commonType = undefined;
      }
    }
  }
  return out.length > 0 ? { ...(commonType ? { type: commonType } : {}), enum: out } : null;
}

function extractEnumValues(schema: unknown): unknown[] | undefined {
  const record = toRecord(schema);
  if (!record) {
    return undefined;
  }
  if (Array.isArray(record.enum)) {
    return record.enum;
  }
  if ("const" in record) {
    return [record.const];
  }
  const variants = Array.isArray(record.anyOf)
    ? record.anyOf
    : Array.isArray(record.oneOf)
      ? record.oneOf
      : null;
  if (!variants) {
    return undefined;
  }
  const values = variants.flatMap((variant) => extractEnumValues(variant) ?? []);
  return values.length > 0 ? values : undefined;
}

function mergePropertySchemas(existing: unknown, incoming: unknown): unknown {
  if (!existing) {
    return incoming;
  }
  if (!incoming) {
    return existing;
  }

  const existingEnum = extractEnumValues(existing);
  const incomingEnum = extractEnumValues(incoming);
  if (!existingEnum && !incomingEnum) {
    return existing;
  }

  const values = Array.from(new Set([...(existingEnum ?? []), ...(incomingEnum ?? [])]));
  const merged: Record<string, unknown> = {};
  for (const source of [existing, incoming]) {
    const record = toRecord(source);
    if (!record) {
      continue;
    }
    for (const key of ["title", "description", "default"]) {
      if (!(key in merged) && key in record) {
        merged[key] = record[key];
      }
    }
  }
  const types = new Set(values.map((value) => typeof value));
  if (types.size === 1) {
    merged.type = Array.from(types)[0];
  }
  merged.enum = values;
  return merged;
}

function flattenObjectUnionSchema(source: Record<string, unknown>): Record<string, unknown> | null {
  const variants = Array.isArray(source.anyOf)
    ? source.anyOf
    : Array.isArray(source.oneOf)
      ? source.oneOf
      : null;
  if (!variants) {
    return null;
  }

  const mergedProperties: Record<string, unknown> = {};
  const requiredCounts = new Map<string, number>();
  let objectVariants = 0;

  for (const entry of variants) {
    const record = toRecord(entry);
    if (!record) {
      continue;
    }
    const props = toRecord(record.properties);
    if (!props) {
      continue;
    }
    objectVariants += 1;
    for (const [key, value] of Object.entries(props)) {
      mergedProperties[key] =
        key in mergedProperties ? mergePropertySchemas(mergedProperties[key], value) : value;
    }
    const required = Array.isArray(record.required)
      ? record.required.filter((key): key is string => typeof key === "string")
      : [];
    for (const key of required) {
      requiredCounts.set(key, (requiredCounts.get(key) ?? 0) + 1);
    }
  }

  if (objectVariants === 0) {
    return null;
  }

  const baseRequired = Array.isArray(source.required)
    ? source.required.filter((key): key is string => typeof key === "string")
    : undefined;
  const mergedRequired =
    baseRequired && baseRequired.length > 0
      ? baseRequired
      : Array.from(requiredCounts.entries())
          .filter(([, count]) => count === objectVariants)
          .map(([key]) => key);

  return {
    type: "object",
    ...(typeof source.title === "string" ? { title: source.title } : {}),
    ...(typeof source.description === "string" ? { description: source.description } : {}),
    properties: mergedProperties,
    ...(mergedRequired.length > 0 ? { required: mergedRequired } : {}),
  };
}

function cleanAimlapiSchema(schema: unknown, depth = 0): unknown {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map((entry) => cleanAimlapiSchema(entry, depth + 1));
  }

  const source = schema as Record<string, unknown>;
  const union =
    (Array.isArray(source.anyOf) && source.anyOf) ||
    (Array.isArray(source.oneOf) && source.oneOf) ||
    null;
  if (union) {
    const flattenedObject = flattenObjectUnionSchema(source);
    if (flattenedObject) {
      return cleanAimlapiSchema(flattenedObject, depth);
    }
    const flattened = extractLiteralEnum(union);
    if (flattened) {
      return {
        ...(typeof source.title === "string" ? { title: source.title } : {}),
        ...(typeof source.description === "string" ? { description: source.description } : {}),
        ...(flattened.type ? { type: flattened.type } : {}),
        enum: flattened.enum,
      };
    }
  }

  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (AIMLAPI_UNSUPPORTED_SCHEMA_KEYWORDS.has(key)) {
      continue;
    }
    if (key === "type" && Array.isArray(value)) {
      const normalized = value.filter((entry) => entry !== "null");
      if (normalized.length === 1 && typeof normalized[0] === "string") {
        cleaned.type = normalized[0];
      }
      continue;
    }
    if (key === "properties") {
      const props = toRecord(value);
      if (!props) {
        continue;
      }
      cleaned.properties = Object.fromEntries(
        Object.entries(props).map(([propKey, propValue]) => [
          propKey,
          cleanAimlapiSchema(propValue, depth + 1),
        ]),
      );
      continue;
    }
    if (key === "items") {
      cleaned.items = cleanAimlapiSchema(value, depth + 1);
      continue;
    }
    if (key === "required" && Array.isArray(value)) {
      cleaned.required = value.filter((entry): entry is string => typeof entry === "string");
      continue;
    }
    cleaned[key] = cleanAimlapiSchema(value, depth + 1);
  }

  if (depth === 0) {
    const properties = toRecord(cleaned.properties) ?? {};
    const required = Array.isArray(cleaned.required)
      ? cleaned.required.filter((key): key is string => key in properties)
      : [];
    return {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
    };
  }

  return cleaned;
}

export function normalizeAimlapiToolParameters(tool: AnyAgentTool): AnyAgentTool {
  const toolRecord = tool as unknown as Record<string, unknown>;
  const functionValue = toolRecord.function;
  const functionRecord =
    functionValue && typeof functionValue === "object" && !Array.isArray(functionValue)
      ? (functionValue as Record<string, unknown>)
      : null;

  return {
    ...tool,
    parameters: cleanAimlapiSchema(tool.parameters),
    ...(functionRecord
      ? {
          function: {
            ...functionRecord,
            parameters: cleanAimlapiSchema(functionRecord.parameters),
          },
        }
      : {}),
  };
}

export function normalizeAimlapiPayloadTools(tools: unknown): unknown {
  if (!Array.isArray(tools)) {
    return tools;
  }
  return tools.map((tool) => normalizeAimlapiToolParameters(tool as unknown as AnyAgentTool));
}

export function normalizeAimlapiToolChoice(toolChoice: unknown): unknown {
  if (toolChoice === "required") {
    return "auto";
  }
  if (!toolChoice || typeof toolChoice !== "object" || Array.isArray(toolChoice)) {
    return toolChoice;
  }

  const record = toolChoice as ToolChoiceRecord;
  if (record.type === "required") {
    return "auto";
  }
  if (record.type === "tool" && typeof record.name === "string" && record.name.length > 0) {
    return {
      type: "function",
      function: { name: record.name },
    };
  }
  return toolChoice;
}

export function normalizeAimlapiPayloadMessages(messages: unknown): unknown {
  if (!Array.isArray(messages)) {
    return messages;
  }
  let changed = false;
  const nextMessages = messages.map((entry) => {
    if (!entry || typeof entry !== "object") {
      return entry;
    }
    const record = entry as Record<string, unknown>;
    if (record.role !== "assistant" || record.content !== null) {
      return entry;
    }
    changed = true;
    return {
      ...record,
      content: "",
    };
  });
  return changed ? nextMessages : messages;
}
