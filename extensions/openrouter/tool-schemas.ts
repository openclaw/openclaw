import type { ProviderNormalizeToolSchemasContext } from "openclaw/plugin-sdk/plugin-entry";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import { asOptionalRecord as readRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeOpenRouterApiModelId, normalizeOpenRouterModelFamilyId } from "./models.js";

const openAiTools = buildProviderToolCompatFamilyHooks("openai");
const schemaTypes = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);
const schemaMapKeys = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
  "dependencies",
  "$defs",
  "definitions",
]);
const schemaValueKeys = new Set([
  "items",
  "additionalItems",
  "prefixItems",
  "additionalProperties",
  "anyOf",
  "oneOf",
  "allOf",
  "then",
  "else",
  "if",
  "not",
  "contains",
  "propertyNames",
  "unevaluatedItems",
  "unevaluatedProperties",
  "contentSchema",
]);

function readSchemaTypes(type: unknown): string[] | undefined {
  const types = Array.isArray(type) ? type : [type];
  return types.length > 0 &&
    types.every((entry) => typeof entry === "string" && schemaTypes.has(entry))
    ? types
    : undefined;
}

function canMoveParentType(branches: unknown[], parentTypes: string[]): boolean {
  return (
    branches.length > 0 &&
    branches.every((branch) => {
      const record = readRecord(branch);
      // Unknown references, boolean schemas and nested unions cannot safely inherit a type.
      if (!record || "$ref" in record || "anyOf" in record || "oneOf" in record) {
        return false;
      }
      if (!("type" in record)) {
        return true;
      }
      return (
        readSchemaTypes(record.type)?.every(
          (type) =>
            parentTypes.includes(type) || (type === "integer" && parentTypes.includes("number")),
        ) === true
      );
    })
  );
}

function normalizeMoonshotSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map(normalizeMoonshotSchema);
  }
  const record = readRecord(schema);
  if (!record) {
    return schema;
  }
  return normalizeMoonshotSchemaObject(record);
}

function normalizeMoonshotSchemaObject(record: Record<string, unknown>): Record<string, unknown> {
  // Traverse schema locations only: default/examples/enum can contain arbitrary user data.
  // fromEntries preserves own __proto__ keys without invoking Object.prototype setters.
  const next = Object.fromEntries(
    Object.entries(record).map(([key, value]) => {
      const entries = schemaMapKeys.has(key) ? readRecord(value) : undefined;
      if (entries) {
        return [
          key,
          Object.fromEntries(
            Object.entries(entries).map(([name, child]) => [name, normalizeMoonshotSchema(child)]),
          ),
        ];
      }
      return [key, schemaValueKeys.has(key) ? normalizeMoonshotSchema(value) : value];
    }),
  );
  const parentTypes = readSchemaTypes(next.type);
  const branches = next.anyOf;
  if (!parentTypes || !Array.isArray(branches) || !canMoveParentType(branches, parentTypes)) {
    return next;
  }
  // Moonshot requires anyOf branch types. Distribute the parent's conjunctive type only
  // when every typed branch is already a subset; retain all other parent constraints.
  // oneOf has no evidenced rewrite here. Never apply DeepSeek's first-branch reduction.
  const { type, ...result } = next;
  const typedBranches: unknown[] = [];
  for (const branch of branches) {
    const branchRecord = readRecord(branch);
    typedBranches.push(
      branchRecord && !("type" in branchRecord) ? { type, ...branchRecord } : branch,
    );
  }
  result.anyOf = typedBranches;
  return result;
}

const moonshotTools = {
  normalizeToolSchemas: (ctx: ProviderNormalizeToolSchemasContext) =>
    ctx.tools.map((tool) => {
      const parameters = readRecord(tool.parameters);
      return parameters ? { ...tool, parameters: normalizeMoonshotSchemaObject(parameters) } : tool;
    }),
  // Retained unions are valid schema contracts, not DeepSeek-incompatible diagnostics.
  inspectToolSchemas: (_ctx: ProviderNormalizeToolSchemasContext) => [],
};

function resolveOpenRouterToolFamily(modelId: string) {
  const normalized =
    normalizeOpenRouterModelFamilyId(normalizeOpenRouterApiModelId(modelId)) ?? modelId;
  if (normalized.startsWith("moonshot/") || normalized.startsWith("moonshotai/")) {
    return moonshotTools;
  }
  return openAiTools;
}

export function normalizeOpenRouterToolSchemas(ctx: ProviderNormalizeToolSchemasContext) {
  return resolveOpenRouterToolFamily(ctx.modelId ?? "").normalizeToolSchemas(ctx);
}

export function inspectOpenRouterToolSchemas(ctx: ProviderNormalizeToolSchemasContext) {
  return resolveOpenRouterToolFamily(ctx.modelId ?? "").inspectToolSchemas(ctx);
}
