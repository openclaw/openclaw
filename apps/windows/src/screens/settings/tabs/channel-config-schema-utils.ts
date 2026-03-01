// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConfigPathSegment =
  | { kind: "key"; key: string }
  | { kind: "index"; index: number };

export type ConfigPath = ConfigPathSegment[];

export interface ConfigUiHint {
  label?: string;
  help?: string;
  order?: number;
  advanced?: boolean;
  sensitive?: boolean;
  placeholder?: string;
}

export interface ConfigSchemaNode {
  raw: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

export function asRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

export function toStringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parsePathKey(path: ConfigPath): string {
  return path
    .map((segment) => (segment.kind === "key" ? segment.key : null))
    .filter((segment): segment is string => Boolean(segment))
    .join(".");
}

export function cloneDeep<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ---------------------------------------------------------------------------
// Path constructors
// ---------------------------------------------------------------------------

export function keySegment(key: string): ConfigPathSegment {
  return { kind: "key", key };
}

export function indexSegment(index: number): ConfigPathSegment {
  return { kind: "index", index };
}

// ---------------------------------------------------------------------------
// Schema node accessors
// ---------------------------------------------------------------------------

export function parseConfigSchemaNode(raw: unknown): ConfigSchemaNode | null {
  if (!asRecord(raw)) return null;
  return { raw };
}

function parseChildNode(raw: unknown): ConfigSchemaNode | null {
  return parseConfigSchemaNode(raw);
}

export function schemaTitle(node: ConfigSchemaNode): string | undefined {
  return toStringValue(node.raw.title);
}

export function schemaDescription(node: ConfigSchemaNode): string | undefined {
  return toStringValue(node.raw.description);
}

export function schemaEnum(node: ConfigSchemaNode): unknown[] | undefined {
  return Array.isArray(node.raw.enum) ? node.raw.enum : undefined;
}

export function schemaConst(node: ConfigSchemaNode): unknown {
  return node.raw.const;
}

export function schemaTypeList(node: ConfigSchemaNode): string[] {
  const rawType = node.raw.type;
  if (typeof rawType === "string") return [rawType];
  if (Array.isArray(rawType)) {
    return rawType.filter((item): item is string => typeof item === "string");
  }
  return [];
}

export function schemaType(node: ConfigSchemaNode): string | undefined {
  const list = schemaTypeList(node);
  const filtered = list.filter((entry) => entry !== "null");
  if (filtered.length > 0) return filtered[0];
  if (list.length > 0) return list[0];
  return undefined;
}

export function isNullSchema(node: ConfigSchemaNode): boolean {
  const list = schemaTypeList(node);
  return list.length === 1 && list[0] === "null";
}

export function schemaDefault(node: ConfigSchemaNode): unknown {
  if (node.raw.default !== undefined) return node.raw.default;
  switch (schemaType(node)) {
    case "object":
      return {};
    case "array":
      return [];
    case "boolean":
      return false;
    case "integer":
      return 0;
    case "number":
      return 0;
    case "string":
      return "";
    default:
      return "";
  }
}

export function schemaProperties(
  node: ConfigSchemaNode
): Record<string, ConfigSchemaNode> {
  if (!asRecord(node.raw.properties)) return {};
  const entries = Object.entries(node.raw.properties)
    .map(([key, value]) => [key, parseChildNode(value)] as const)
    .filter((entry): entry is readonly [string, ConfigSchemaNode] =>
      Boolean(entry[1])
    );
  return Object.fromEntries(entries);
}

export function schemaAnyOf(node: ConfigSchemaNode): ConfigSchemaNode[] {
  if (!Array.isArray(node.raw.anyOf)) return [];
  return node.raw.anyOf
    .map(parseChildNode)
    .filter((entry): entry is ConfigSchemaNode => Boolean(entry));
}

export function schemaOneOf(node: ConfigSchemaNode): ConfigSchemaNode[] {
  if (!Array.isArray(node.raw.oneOf)) return [];
  return node.raw.oneOf
    .map(parseChildNode)
    .filter((entry): entry is ConfigSchemaNode => Boolean(entry));
}

export function schemaLiteral(node: ConfigSchemaNode): unknown {
  const constValue = schemaConst(node);
  if (constValue !== undefined) return constValue;
  const enumValues = schemaEnum(node);
  if (enumValues && enumValues.length === 1) return enumValues[0];
  return undefined;
}

export function schemaItems(node: ConfigSchemaNode): ConfigSchemaNode | null {
  if (Array.isArray(node.raw.items)) {
    return parseChildNode(node.raw.items[0]);
  }
  return parseChildNode(node.raw.items);
}

export function schemaAdditional(
  node: ConfigSchemaNode
): ConfigSchemaNode | null {
  if (!asRecord(node.raw.additionalProperties)) return null;
  return parseChildNode(node.raw.additionalProperties);
}

export function allowsAdditional(node: ConfigSchemaNode): boolean {
  if (typeof node.raw.additionalProperties === "boolean") {
    return node.raw.additionalProperties;
  }
  return schemaAdditional(node) !== null;
}

// ---------------------------------------------------------------------------
// Path-based accessors
// ---------------------------------------------------------------------------

function schemaNodeAtPathInternal(
  node: ConfigSchemaNode,
  path: ConfigPath
): ConfigSchemaNode | null {
  let current: ConfigSchemaNode | null = node;
  for (const segment of path) {
    if (!current) return null;
    if (segment.kind === "key") {
      if (schemaType(current) !== "object") return null;
      const properties = schemaProperties(current);
      if (segment.key in properties) {
        current = properties[segment.key];
      } else {
        current = schemaAdditional(current);
      }
    } else {
      if (schemaType(current) !== "array") return null;
      current = schemaItems(current);
    }
  }
  return current;
}

export function schemaNodeAtPath(
  node: ConfigSchemaNode,
  path: ConfigPath
): ConfigSchemaNode | null {
  return schemaNodeAtPathInternal(node, path);
}

export function getValueAtPath(root: unknown, path: ConfigPath): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (segment.kind === "key") {
      if (!asRecord(current)) return undefined;
      current = current[segment.key];
    } else {
      if (!Array.isArray(current)) return undefined;
      current = current[segment.index];
    }
  }
  return current;
}

function setValueRecursive(
  current: unknown,
  path: ConfigPath,
  value: unknown | undefined
): unknown {
  if (path.length === 0) {
    return value;
  }

  const [head, ...tail] = path;
  if (head.kind === "key") {
    const next = asRecord(current) ? cloneDeep(current) : {};
    if (tail.length === 0) {
      if (value === undefined) {
        delete next[head.key];
      } else {
        next[head.key] = value;
      }
      return next;
    }

    const childCurrent = next[head.key];
    const childNext = setValueRecursive(childCurrent, tail, value);
    if (childNext === undefined) {
      delete next[head.key];
    } else {
      next[head.key] = childNext;
    }
    return next;
  }

  const next = Array.isArray(current) ? cloneDeep(current) : [];
  const index = head.index;
  while (next.length <= index) {
    next.push(null);
  }

  if (tail.length === 0) {
    if (value === undefined) {
      next.splice(index, 1);
    } else {
      next[index] = value;
    }
    return next;
  }

  const childCurrent = next[index];
  const childNext = setValueRecursive(childCurrent, tail, value);
  next[index] = childNext;
  return next;
}

export function setValueAtPath(
  root: unknown,
  path: ConfigPath,
  value: unknown | undefined
): unknown {
  return setValueRecursive(root, path, value);
}

// ---------------------------------------------------------------------------
// UI hint helpers
// ---------------------------------------------------------------------------

export function decodeUiHints(raw: unknown): Record<string, ConfigUiHint> {
  if (!asRecord(raw)) return {};
  const entries = Object.entries(raw)
    .map(([key, value]) => {
      if (!asRecord(value)) return null;
      const hint: ConfigUiHint = {
        label: toStringValue(value.label),
        help: toStringValue(value.help),
        order: toNumber(value.order),
        advanced:
          typeof value.advanced === "boolean" ? value.advanced : undefined,
        sensitive:
          typeof value.sensitive === "boolean" ? value.sensitive : undefined,
        placeholder: toStringValue(value.placeholder),
      };
      return [key, hint] as const;
    })
    .filter((entry): entry is readonly [string, ConfigUiHint] =>
      Boolean(entry)
    );
  return Object.fromEntries(entries);
}

export function hintForPath(
  path: ConfigPath,
  hints: Record<string, ConfigUiHint>
): ConfigUiHint | undefined {
  const key = parsePathKey(path);
  if (hints[key]) return hints[key];

  const segments = key.split(".");
  for (const [hintKey, hint] of Object.entries(hints)) {
    if (!hintKey.includes("*")) continue;
    const hintSegments = hintKey.split(".");
    if (hintSegments.length !== segments.length) continue;

    let matches = true;
    for (let i = 0; i < segments.length; i += 1) {
      if (hintSegments[i] !== "*" && hintSegments[i] !== segments[i]) {
        matches = false;
        break;
      }
    }
    if (matches) return hint;
  }
  return undefined;
}

export function isSensitivePath(path: ConfigPath): boolean {
  const key = parsePathKey(path).toLowerCase();
  return (
    key.includes("token") ||
    key.includes("password") ||
    key.includes("secret") ||
    key.includes("apikey") ||
    key.endsWith("key")
  );
}
