import { normalizeToolParameterSchema } from "./pi-tools-parameter-schema.js";
export { resolveOpenAIStrictToolSetting } from "./openai-strict-tool-setting.js";

type ToolWithParameters = {
  name?: unknown;
  parameters: unknown;
};

export function normalizeStrictOpenAIJsonSchema(schema: unknown): unknown {
  return normalizeStrictOpenAIJsonSchemaRecursive(normalizeToolParameterSchema(schema ?? {}), 0);
}

function normalizeStrictOpenAIJsonSchemaRecursive(schema: unknown, depth: number): unknown {
  if (Array.isArray(schema)) {
    let changed = false;
    const normalized = schema.map((entry) => {
      const next = normalizeStrictOpenAIJsonSchemaRecursive(entry, depth);
      changed ||= next !== entry;
      return next;
    });
    return changed ? normalized : schema;
  }
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  const record = schema as Record<string, unknown>;
  let changed = false;
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const next = normalizeStrictOpenAIJsonSchemaRecursive(
      value,
      key === "properties" ? depth : depth + 1,
    );
    normalized[key] = next;
    changed ||= next !== value;
  }

  if (normalized.type === "object") {
    const properties =
      normalized.properties &&
      typeof normalized.properties === "object" &&
      !Array.isArray(normalized.properties)
        ? (normalized.properties as Record<string, unknown>)
        : undefined;
    if (properties && Object.keys(properties).length === 0 && !Array.isArray(normalized.required)) {
      normalized.required = [];
      changed = true;
    }
    if (depth === 0 && !("additionalProperties" in normalized)) {
      normalized.additionalProperties = false;
      changed = true;
    }
  }

  return changed ? normalized : schema;
}

export function normalizeOpenAIStrictToolParameters<T>(schema: T, strict: boolean): T {
  if (!strict) {
    return normalizeToolParameterSchema(schema ?? {}) as T;
  }
  return normalizeStrictOpenAIJsonSchema(schema) as T;
}

export function isStrictOpenAIJsonSchemaCompatible(schema: unknown): boolean {
  return isStrictOpenAIJsonSchemaCompatibleRecursive(normalizeStrictOpenAIJsonSchema(schema));
}

type OpenAIStrictToolSchemaDiagnostic = {
  toolIndex: number;
  toolName?: string;
  violations: string[];
};

export function findOpenAIStrictToolSchemaDiagnostics(
  tools: readonly ToolWithParameters[],
): OpenAIStrictToolSchemaDiagnostic[] {
  const diagnostics: OpenAIStrictToolSchemaDiagnostic[] = [];
  for (const [toolIndex, tool] of tools.entries()) {
    const violations = findStrictOpenAIJsonSchemaViolations(
      normalizeStrictOpenAIJsonSchema(tool.parameters),
      `${typeof tool.name === "string" && tool.name ? tool.name : `tool[${toolIndex}]`}.parameters`,
    );
    if (violations.length === 0) {
      continue;
    }
    diagnostics.push({
      toolIndex,
      ...(typeof tool.name === "string" && tool.name ? { toolName: tool.name } : {}),
      violations,
    });
  }
  return diagnostics;
}

function isStrictOpenAIJsonSchemaCompatibleRecursive(schema: unknown): boolean {
  if (Array.isArray(schema)) {
    return schema.every((entry) => isStrictOpenAIJsonSchemaCompatibleRecursive(entry));
  }
  if (!schema || typeof schema !== "object") {
    return true;
  }

  const record = schema as Record<string, unknown>;
  if ("anyOf" in record || "oneOf" in record || "allOf" in record) {
    return false;
  }
  if (Array.isArray(record.type)) {
    return false;
  }
  if (record.type === "object" && record.additionalProperties !== false) {
    return false;
  }
  if (record.type === "object") {
    const properties =
      record.properties &&
      typeof record.properties === "object" &&
      !Array.isArray(record.properties)
        ? (record.properties as Record<string, unknown>)
        : {};
    const required = Array.isArray(record.required)
      ? collectStringEntries(record.required)
      : undefined;
    if (!required) {
      return false;
    }
    const requiredSet = new Set(required);
    if (Object.keys(properties).some((key) => !requiredSet.has(key))) {
      return false;
    }
  }

  for (const [key, entry] of Object.entries(record)) {
    if (key === "properties" && entry && typeof entry === "object" && !Array.isArray(entry)) {
      for (const value of Object.values(entry as Record<string, unknown>)) {
        if (!isStrictOpenAIJsonSchemaCompatibleRecursive(value)) {
          return false;
        }
      }
      continue;
    }
    if (!isStrictOpenAIJsonSchemaCompatibleRecursive(entry)) {
      return false;
    }
  }
  return true;
}

function collectStringEntries(values: unknown[]): string[] {
  const strings: string[] = [];
  for (const value of values) {
    if (typeof value === "string") {
      strings.push(value);
    }
  }
  return strings;
}

function findStrictOpenAIJsonSchemaViolations(schema: unknown, path: string): string[] {
  if (Array.isArray(schema)) {
    const violations: string[] = [];
    for (const [index, entry] of schema.entries()) {
      violations.push(...findStrictOpenAIJsonSchemaViolations(entry, `${path}[${index}]`));
    }
    return violations;
  }
  if (!schema || typeof schema !== "object") {
    return [];
  }

  const record = schema as Record<string, unknown>;
  const violations: string[] = [];
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    if (key in record) {
      violations.push(`${path}.${key}`);
    }
  }
  if (Array.isArray(record.type)) {
    violations.push(`${path}.type`);
  }
  if (record.type === "object") {
    if (record.additionalProperties !== false) {
      violations.push(`${path}.additionalProperties`);
    }
    const properties =
      record.properties &&
      typeof record.properties === "object" &&
      !Array.isArray(record.properties)
        ? (record.properties as Record<string, unknown>)
        : {};
    const required = Array.isArray(record.required)
      ? collectStringEntries(record.required)
      : undefined;
    if (!required) {
      violations.push(`${path}.required`);
    } else {
      const requiredSet = new Set(required);
      for (const key of Object.keys(properties)) {
        if (!requiredSet.has(key)) {
          violations.push(`${path}.required.${key}`);
        }
      }
    }
  }

  if (
    record.properties &&
    typeof record.properties === "object" &&
    !Array.isArray(record.properties)
  ) {
    for (const [key, value] of Object.entries(record.properties)) {
      violations.push(...findStrictOpenAIJsonSchemaViolations(value, `${path}.properties.${key}`));
    }
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === "properties") {
      continue;
    }
    if (value && typeof value === "object") {
      violations.push(...findStrictOpenAIJsonSchemaViolations(value, `${path}.${key}`));
    }
  }

  return violations;
}

export function resolveOpenAIStrictToolFlagForInventory(
  tools: readonly ToolWithParameters[],
  strict: boolean | null | undefined,
): boolean | undefined {
  if (strict !== true) {
    return strict === false ? false : undefined;
  }
  return tools.every((tool) => isStrictOpenAIJsonSchemaCompatible(tool.parameters));
}
