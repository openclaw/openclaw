import { buildConfigSchema, type ConfigUiHint, type ConfigUiHints } from "@openclaw/config/schema.ts";
import { OpenClawSchema } from "@openclaw/config/zod-schema.ts";

type JsonSchemaNode = {
  description?: string;
  default?: unknown;
  const?: unknown;
  type?: string | string[];
  enum?: unknown[];
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode | JsonSchemaNode[];
  additionalProperties?: JsonSchemaNode | boolean;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
};

type SchemaContext = {
  schemaRoot: JsonSchemaNode;
  uiHints: ConfigUiHints;
  version: string;
  generatedAt: string;
};

export type FieldKind =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "enum"
  | "array"
  | "object"
  | "unknown";

export type ExplorerSchemaNode = {
  kind: FieldKind;
  enumValues: string[];
  properties: Record<string, ExplorerSchemaNode>;
  item: ExplorerSchemaNode | null;
  additionalProperties: ExplorerSchemaNode | null;
  allowsUnknownProperties: boolean;
};

export type ExplorerField = {
  path: string;
  label: string;
  help: string;
  sensitive: boolean;
  advanced: boolean;
  kind: FieldKind;
  enumValues: string[];
  itemKind: FieldKind | null;
  itemEnumValues: string[];
  recordValueKind: FieldKind | null;
  recordEnumValues: string[];
  hasDefault: boolean;
  editable: boolean;
  schemaNode: ExplorerSchemaNode | null;
};

export type ExplorerSection = {
  id: string;
  label: string;
  order: number;
  description: string;
  fields: ExplorerField[];
};

export type ExplorerSnapshot = {
  version: string;
  generatedAt: string;
  sectionCount: number;
  fieldCount: number;
  sections: ExplorerSection[];
};

const SECTION_FALLBACK_ORDER = 500;

let cachedContext: SchemaContext | null = null;

function getSchemaContext(): SchemaContext {
  if (cachedContext) {
    return cachedContext;
  }

  // buildConfigSchema() intentionally strips core channel schema from the base response.
  // For the standalone builder we want the complete core schema for interactive controls,
  // while still reusing uiHints/version metadata from buildConfigSchema().
  const configSchema = buildConfigSchema();
  const fullSchema = OpenClawSchema.toJSONSchema({
    target: "draft-07",
    unrepresentable: "any",
  });
  const schemaRoot = asObjectNode(fullSchema) ?? {};

  cachedContext = {
    schemaRoot,
    uiHints: configSchema.uiHints,
    version: configSchema.version,
    generatedAt: configSchema.generatedAt,
  };
  return cachedContext;
}

function humanizeKey(value: string): string {
  if (!value.trim()) {
    return value;
  }
  return value
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (char) => char.toUpperCase());
}

function firstPathSegment(path: string): string {
  const [segment] = path.split(".");
  return segment?.trim() ?? "";
}

function lastPathSegment(path: string): string {
  const segments = path.split(".");
  return segments.at(-1) ?? path;
}

function isSectionHint(path: string, hint: ConfigUiHint): boolean {
  return !path.includes(".") && typeof hint.order === "number" && typeof hint.group === "string";
}

function fieldSort(a: ExplorerField, b: ExplorerField): number {
  return a.path.localeCompare(b.path);
}

function sectionSort(a: ExplorerSection, b: ExplorerSection): number {
  if (a.order !== b.order) {
    return a.order - b.order;
  }
  return a.label.localeCompare(b.label);
}

function pruneRedundantCompositeFields(fields: ExplorerField[]): ExplorerField[] {
  return fields.filter((field) => {
    if (field.kind !== "object" && field.kind !== "array") {
      return true;
    }

    // If we already expose concrete descendants as first-class fields,
    // do not also render the composite parent card (it duplicates controls).
    const prefix = `${field.path}.`;
    const hasDescendant = fields.some((candidate) =>
      candidate.path !== field.path && candidate.path.startsWith(prefix)
    );

    return !hasDescendant;
  });
}

function normalizeSchemaPath(path: string): string[] {
  return path
    .replace(/\[\]/g, ".*")
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function asObjectNode(node: unknown): JsonSchemaNode | null {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    return null;
  }
  return node as JsonSchemaNode;
}

function resolveUnion(node: JsonSchemaNode): JsonSchemaNode {
  const pool = [...(node.anyOf ?? []), ...(node.oneOf ?? []), ...(node.allOf ?? [])];
  const preferred = pool.find((entry) => {
    const type = entry.type;
    if (typeof type === "string") {
      return type !== "null";
    }
    if (Array.isArray(type)) {
      return type.some((part) => part !== "null");
    }
    return true;
  });
  return preferred ?? node;
}

function resolveSchemaNode(root: JsonSchemaNode, path: string): JsonSchemaNode | null {
  const segments = normalizeSchemaPath(path);
  let current: JsonSchemaNode | null = root;

  for (const segment of segments) {
    if (!current) {
      return null;
    }

    current = resolveUnion(current);

    if (segment === "*") {
      if (Array.isArray(current.items)) {
        current = current.items[0] ?? null;
        continue;
      }
      const itemNode = asObjectNode(current.items);
      if (itemNode) {
        current = itemNode;
        continue;
      }
      const additionalNode = asObjectNode(current.additionalProperties);
      if (additionalNode) {
        current = additionalNode;
        continue;
      }
      return null;
    }

    const properties = current.properties ?? {};
    if (segment in properties) {
      current = properties[segment] ?? null;
      continue;
    }

    const additionalNode = asObjectNode(current.additionalProperties);
    if (additionalNode) {
      current = additionalNode;
      continue;
    }

    return null;
  }

  return current;
}

function enumValuesFromNode(node: JsonSchemaNode | null, depth = 0): string[] {
  if (!node || depth > 5) {
    return [];
  }

  const values = new Set<string>();

  if (Array.isArray(node.enum)) {
    for (const entry of node.enum) {
      values.add(String(entry));
    }
  }

  if (node.const !== undefined) {
    values.add(String(node.const));
  }

  const unionPool = [...(node.anyOf ?? []), ...(node.oneOf ?? []), ...(node.allOf ?? [])];
  for (const entry of unionPool) {
    for (const option of enumValuesFromNode(entry, depth + 1)) {
      values.add(option);
    }
  }

  return Array.from(values);
}

function hasOpenScalarType(node: JsonSchemaNode | null, expected: "string" | "number" | "integer" | "boolean", depth = 0): boolean {
  if (!node || depth > 8) {
    return false;
  }

  const rawType = node.type;
  const matchesType =
    rawType === expected || (Array.isArray(rawType) && rawType.includes(expected));
  if (matchesType && node.const === undefined && !Array.isArray(node.enum)) {
    return true;
  }

  const unionPool = [...(node.anyOf ?? []), ...(node.oneOf ?? []), ...(node.allOf ?? [])];
  return unionPool.some((entry) => hasOpenScalarType(entry, expected, depth + 1));
}

function resolveType(node: JsonSchemaNode | null): FieldKind {
  if (!node) {
    return "unknown";
  }

  const enumValues = enumValuesFromNode(node);
  if (enumValues.length > 0) {
    if (hasOpenScalarType(node, "string")) {
      return "string";
    }
    if (hasOpenScalarType(node, "integer")) {
      return "integer";
    }
    if (hasOpenScalarType(node, "number")) {
      return "number";
    }
    if (hasOpenScalarType(node, "boolean")) {
      return "boolean";
    }
    return "enum";
  }

  const resolved = resolveUnion(node);
  const rawType = resolved.type;
  const type = Array.isArray(rawType) ? rawType.find((entry) => entry !== "null") : rawType;

  switch (type) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "integer":
      return "integer";
    case "boolean":
      return "boolean";
    case "array":
      return "array";
    case "object":
      return "object";
    default:
      if (resolved.properties) {
        return "object";
      }
      if (resolved.items) {
        return "array";
      }
      return "unknown";
  }
}

function firstArrayItemNode(node: JsonSchemaNode | null): JsonSchemaNode | null {
  if (!node) {
    return null;
  }
  const resolved = resolveUnion(node);
  if (Array.isArray(resolved.items)) {
    return asObjectNode(resolved.items[0] ?? null);
  }
  return asObjectNode(resolved.items);
}

function recordValueNode(node: JsonSchemaNode | null): JsonSchemaNode | null {
  if (!node) {
    return null;
  }
  const resolved = resolveUnion(node);
  const properties = resolved.properties ?? {};
  if (Object.keys(properties).length > 0) {
    return null;
  }
  return asObjectNode(resolved.additionalProperties);
}

function isEditable(path: string, kind: FieldKind): boolean {
  if (path.includes("*") || path.includes("[]")) {
    return false;
  }
  return kind !== "unknown";
}

function buildExplorerSchemaNode(node: JsonSchemaNode | null, depth = 0): ExplorerSchemaNode | null {
  if (!node || depth > 8) {
    return null;
  }

  const resolved = resolveUnion(node);
  const kind = resolveType(resolved);

  const properties: Record<string, ExplorerSchemaNode> = {};
  for (const [key, child] of Object.entries(resolved.properties ?? {})) {
    const childSchema = buildExplorerSchemaNode(asObjectNode(child), depth + 1);
    if (childSchema) {
      properties[key] = childSchema;
    }
  }

  const item = buildExplorerSchemaNode(firstArrayItemNode(resolved), depth + 1);

  const additionalRaw = resolved.additionalProperties;
  const additionalProperties = buildExplorerSchemaNode(asObjectNode(additionalRaw), depth + 1);
  const allowsUnknownProperties = additionalRaw === true;

  return {
    kind,
    enumValues: enumValuesFromNode(node),
    properties,
    item,
    additionalProperties,
    allowsUnknownProperties,
  };
}

function buildExplorerField(path: string, hint: ConfigUiHint | undefined, root: JsonSchemaNode): ExplorerField {
  const schemaNode = resolveSchemaNode(root, path);
  const kind = resolveType(schemaNode);
  const arrayItemNode = kind === "array" ? firstArrayItemNode(schemaNode) : null;
  const itemKind = arrayItemNode ? resolveType(arrayItemNode) : null;
  const recordNode = kind === "object" ? recordValueNode(schemaNode) : null;
  const recordValueKind = recordNode ? resolveType(recordNode) : null;

  return {
    path,
    label: hint?.label?.trim() || humanizeKey(lastPathSegment(path)),
    help: hint?.help?.trim() ?? schemaNode?.description?.trim() ?? "",
    sensitive: Boolean(hint?.sensitive),
    advanced: Boolean(hint?.advanced),
    kind,
    enumValues: enumValuesFromNode(schemaNode),
    itemKind,
    itemEnumValues: enumValuesFromNode(arrayItemNode),
    recordValueKind,
    recordEnumValues: enumValuesFromNode(recordNode),
    hasDefault: schemaNode?.default !== undefined,
    editable: isEditable(path, kind),
    schemaNode: buildExplorerSchemaNode(schemaNode),
  };
}

export function resolveExplorerField(path: string): ExplorerField | null {
  const context = getSchemaContext();
  const hint = context.uiHints[path];
  const schemaNode = resolveSchemaNode(context.schemaRoot, path);
  if (!schemaNode && !hint) {
    return null;
  }
  const field = buildExplorerField(path, hint, context.schemaRoot);
  return field.kind === "unknown" ? null : field;
}

export function buildExplorerSnapshot(): ExplorerSnapshot {
  const context = getSchemaContext();
  const uiHints = context.uiHints;
  const schemaRoot = context.schemaRoot;
  const schemaProperties = schemaRoot.properties ?? {};

  const sections = new Map<string, ExplorerSection>();

  for (const [path, hint] of Object.entries(uiHints)) {
    if (!isSectionHint(path, hint)) {
      continue;
    }
    sections.set(path, {
      id: path,
      label: hint.label?.trim() || hint.group?.trim() || humanizeKey(path),
      order: hint.order,
      description: "",
      fields: [],
    });
  }

  for (const [rootKey, node] of Object.entries(schemaProperties)) {
    if (sections.has(rootKey)) {
      const existing = sections.get(rootKey);
      if (existing) {
        existing.description = node.description?.trim() ?? existing.description;
      }
      continue;
    }
    const rootHint = uiHints[rootKey];
    sections.set(rootKey, {
      id: rootKey,
      label: rootHint?.label?.trim() || humanizeKey(rootKey),
      order: rootHint?.order ?? SECTION_FALLBACK_ORDER,
      description: node.description?.trim() ?? rootHint?.help?.trim() ?? "",
      fields: [],
    });
  }

  for (const [path, hint] of Object.entries(uiHints)) {
    const rootKey = firstPathSegment(path);
    if (!rootKey) {
      continue;
    }

    if (!sections.has(rootKey)) {
      sections.set(rootKey, {
        id: rootKey,
        label: humanizeKey(rootKey),
        order: SECTION_FALLBACK_ORDER,
        description: "",
        fields: [],
      });
    }

    if (isSectionHint(path, hint)) {
      continue;
    }

    const target = sections.get(rootKey);
    if (!target) {
      continue;
    }

    const field = buildExplorerField(path, hint, schemaRoot);
    if (field.kind === "unknown") {
      // Ignore hint-only fields that do not resolve against the current schema.
      continue;
    }
    target.fields.push(field);
  }

  const orderedSections = Array.from(sections.values())
    .map((section) => {
      const sorted = section.fields.toSorted(fieldSort);
      return { ...section, fields: pruneRedundantCompositeFields(sorted) };
    })
    .filter((section) => section.fields.length > 0)
    .toSorted(sectionSort);

  const fieldCount = orderedSections.reduce((sum, section) => sum + section.fields.length, 0);

  return {
    version: context.version,
    generatedAt: context.generatedAt,
    sectionCount: orderedSections.length,
    fieldCount,
    sections: orderedSections,
  };
}
