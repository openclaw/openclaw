/**
 * OpenAI strict JSON-schema normalization for tool inventories and request payloads.
 *
 * Caches normalized object inputs by provider compatibility so repeated inventory builds preserve identity.
 */
import {
  normalizeToolParameterSchema,
  shouldOmitEmptyArrayItems,
  type ToolSchemaModelCompat,
} from "./agent-tools-parameter-schema.js";
import type { OpenAIToolProjection } from "./openai-tool-projection.js";
import { findOpenAIStrictSchemaViolations } from "./openai-tool-schema-compat.js";
import { createToolSchemaNormalizationCache } from "./tool-schema-normalization-cache.js";

export { findOpenAIStrictSchemaViolations } from "./openai-tool-schema-compat.js";

/**
 * OpenAI strict-tool-schema normalization and diagnostics.
 *
 * Strict schemas need all object properties required and `additionalProperties: false`; model
 * compatibility settings can also remove unsupported schema constructs before strict checks run.
 */
type ToolSchemaCompatInput = {
  unsupportedToolSchemaKeywords?: unknown;
  omitEmptyArrayItems?: unknown;
};

const MAX_STRICT_SCHEMA_CACHE_ENTRIES_PER_SCHEMA = 8;
const strictOpenAISchemaCache = createToolSchemaNormalizationCache<unknown>(
  MAX_STRICT_SCHEMA_CACHE_ENTRIES_PER_SCHEMA,
);

function resolveToolSchemaModelCompat(
  compat: ToolSchemaCompatInput | null | undefined,
): ToolSchemaModelCompat | undefined {
  if (!compat) {
    return undefined;
  }
  const unsupportedToolSchemaKeywords = Array.isArray(compat.unsupportedToolSchemaKeywords)
    ? compat.unsupportedToolSchemaKeywords.filter(
        (keyword): keyword is string => typeof keyword === "string",
      )
    : [];
  if (unsupportedToolSchemaKeywords.length === 0 && compat.omitEmptyArrayItems !== true) {
    return undefined;
  }
  return {
    ...(unsupportedToolSchemaKeywords.length > 0 ? { unsupportedToolSchemaKeywords } : {}),
    ...(compat.omitEmptyArrayItems === true ? { omitEmptyArrayItems: true } : {}),
  };
}

function resolveStrictOpenAISchemaCacheKey(
  modelCompat: ToolSchemaCompatInput | null | undefined,
): string {
  const compat = resolveToolSchemaModelCompat(modelCompat);
  return JSON.stringify([
    [...(compat?.unsupportedToolSchemaKeywords ?? [])].toSorted(),
    shouldOmitEmptyArrayItems(compat),
  ]);
}

/** Normalizes a tool parameter schema into the OpenAI strict JSON-schema subset. */
export function normalizeStrictOpenAIJsonSchema(
  schema: unknown,
  modelCompat?: ToolSchemaCompatInput | null,
): unknown {
  const schemaInput = schema ?? {};
  if (!schemaInput || typeof schemaInput !== "object") {
    return normalizeStrictOpenAIJsonSchemaTree(
      normalizeToolParameterSchema(schemaInput, {
        modelCompat: resolveToolSchemaModelCompat(modelCompat),
      }),
    );
  }
  const cacheKey = resolveStrictOpenAISchemaCacheKey(modelCompat);
  const cached = strictOpenAISchemaCache.get(schemaInput, cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  return strictOpenAISchemaCache.remember(
    schemaInput,
    cacheKey,
    // Cache by input object and compatibility key so repeated inventory generation preserves object
    // identity without mixing schemas normalized for different provider limitations.
    normalizeStrictOpenAIJsonSchemaTree(
      normalizeToolParameterSchema(schemaInput, {
        modelCompat: resolveToolSchemaModelCompat(modelCompat),
      }),
    ),
  );
}

// Tool schemas are external input and can nest far deeper than the call stack, so the walkers
// below run explicit task stacks instead of recursing (#141306). A visit task either resolves a
// leaf immediately or pushes one assemble task plus a visit task per child; the assemble task
// only runs after every child has written its result back, mirroring the original recursion.
// The `properties` schema map keeps its parent's depth, exactly as the recursion did.
type StrictVisitTask = {
  kind: "visit";
  node: unknown;
  depth: number;
  assign: (value: unknown) => void;
};

type StrictAssembleArrayTask = {
  kind: "assemble-array";
  node: object;
  depth: number;
  assign: (value: unknown) => void;
  // Arrays fill slots by index.
  entries: unknown[];
  changed: boolean;
};

type StrictAssembleRecordTask = {
  kind: "assemble-record";
  node: object;
  depth: number;
  assign: (value: unknown) => void;
  // Records collect [key, childResult] pairs for Object.fromEntries so user-named keys such as
  // `__proto__` become own properties, matching the recursion.
  entries: Array<[string, unknown]>;
  changed: boolean;
};

type StrictTask = StrictVisitTask | StrictAssembleArrayTask | StrictAssembleRecordTask;

function createCircularToolSchemaError(): TypeError {
  return new TypeError("Tool schema contains a circular reference and cannot be normalized.");
}

function normalizeStrictOpenAIJsonSchemaTree(root: unknown): unknown {
  let rootResult: unknown = root;
  // Recursion previously bounded cyclic object graphs via the call stack; the explicit stack
  // removes that implicit guard, so the walk tracks the nodes on its current path instead.
  const ancestors = new Set<object>();
  const tasks: StrictTask[] = [
    {
      kind: "visit",
      node: root,
      depth: 0,
      assign: (value) => {
        rootResult = value;
      },
    },
  ];
  let task: StrictTask | undefined;
  while ((task = tasks.pop()) !== undefined) {
    if (task.kind !== "visit") {
      ancestors.delete(task.node);
      if (task.kind === "assemble-array") {
        task.assign(task.changed ? task.entries : task.node);
        continue;
      }
      const normalized = Object.fromEntries(task.entries);
      if (normalized.type === "object") {
        const properties =
          normalized.properties &&
          typeof normalized.properties === "object" &&
          !Array.isArray(normalized.properties)
            ? (normalized.properties as Record<string, unknown>)
            : undefined;
        if (
          properties &&
          Object.keys(properties).length === 0 &&
          !Array.isArray(normalized.required)
        ) {
          normalized.required = [];
          task.changed = true;
        }
        if (task.depth === 0 && !("additionalProperties" in normalized)) {
          normalized.additionalProperties = false;
          task.changed = true;
        }
      }
      task.assign(task.changed ? normalized : task.node);
      continue;
    }
    const { node, depth, assign } = task;
    if (Array.isArray(node)) {
      if (ancestors.has(node)) {
        throw createCircularToolSchemaError();
      }
      ancestors.add(node);
      const assemble: StrictAssembleArrayTask = {
        kind: "assemble-array",
        node,
        depth,
        assign,
        entries: Array.from({ length: node.length }),
        changed: false,
      };
      tasks.push(assemble);
      const entries = assemble.entries;
      for (let index = node.length - 1; index >= 0; index -= 1) {
        const slot = index;
        tasks.push({
          kind: "visit",
          node: node[slot],
          depth,
          assign: (value) => {
            assemble.changed ||= value !== node[slot];
            entries[slot] = value;
          },
        });
      }
      continue;
    }
    if (!node || typeof node !== "object") {
      assign(node);
      continue;
    }
    if (ancestors.has(node)) {
      throw createCircularToolSchemaError();
    }
    ancestors.add(node);
    const record = node as Record<string, unknown>;
    const assemble: StrictAssembleRecordTask = {
      kind: "assemble-record",
      node,
      depth,
      assign,
      entries: [],
      changed: false,
    };
    tasks.push(assemble);
    const normalized = assemble.entries;
    const entries = Object.entries(record);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (!entry) {
        continue;
      }
      const [key, value] = entry;
      tasks.push({
        kind: "visit",
        node: value,
        depth: key === "properties" ? depth : depth + 1,
        assign: (childResult) => {
          assemble.changed ||= childResult !== value;
          normalized.push([key, childResult]);
        },
      });
    }
  }
  return rootResult;
}

/** Normalizes tool parameters using strict OpenAI rules only when strict mode is active. */
export function normalizeOpenAIStrictToolParameters<T>(
  schema: T,
  strict: boolean,
  modelCompat?: ToolSchemaCompatInput | null,
): T {
  const toolSchemaCompat = resolveToolSchemaModelCompat(modelCompat);
  if (!strict) {
    return normalizeToolParameterSchema(schema ?? {}, { modelCompat: toolSchemaCompat }) as T;
  }
  return normalizeStrictOpenAIJsonSchema(schema, toolSchemaCompat) as T;
}

/** Returns whether a schema already satisfies OpenAI strict tool-schema constraints. */
export function isStrictOpenAIJsonSchemaCompatible(schema: unknown): boolean {
  return isStrictOpenAIJsonSchemaCompatibleTree(normalizeStrictOpenAIJsonSchema(schema));
}

type OpenAIStrictToolSchemaDiagnostic = {
  toolIndex: number;
  toolName?: string;
  violations: string[];
};

/** Returns strict-schema diagnostics for an already materialized OpenAI tool projection. */
export function findOpenAIStrictToolProjectionDiagnostics(
  projection: OpenAIToolProjection,
): OpenAIStrictToolSchemaDiagnostic[] {
  return [
    ...projection.diagnostics.map((diagnostic) => ({
      toolIndex: diagnostic.toolIndex,
      ...(diagnostic.toolName ? { toolName: diagnostic.toolName } : {}),
      violations: [...diagnostic.violations],
    })),
    ...projection.tools.flatMap((tool) => {
      const violations = findOpenAIStrictSchemaViolations(
        normalizeStrictOpenAIJsonSchema(tool.parameters),
        `${tool.name}.parameters`,
      );
      return violations.length > 0
        ? [{ toolIndex: tool.toolIndex, toolName: tool.name, violations }]
        : [];
    }),
  ];
}

function isStrictOpenAIJsonSchemaCompatibleTree(root: unknown): boolean {
  // Depth-first boolean check on an explicit stack (#141306); evaluation order does not affect
  // the conjunction, only short-circuiting on the first violation does. Leave markers bound
  // cyclic object graphs the way the call stack bounded them before.
  type Pending = { kind: "visit"; node: unknown } | { kind: "leave"; node: object };
  const ancestors = new Set<object>();
  const pending: Pending[] = [{ kind: "visit", node: root }];
  let current: Pending | undefined;
  while ((current = pending.pop()) !== undefined) {
    if (current.kind === "leave") {
      ancestors.delete(current.node);
      continue;
    }
    const node = current.node;
    if (Array.isArray(node)) {
      if (ancestors.has(node)) {
        throw createCircularToolSchemaError();
      }
      ancestors.add(node);
      pending.push({ kind: "leave", node });
      for (const entry of node) {
        pending.push({ kind: "visit", node: entry });
      }
      continue;
    }
    if (!node || typeof node !== "object") {
      continue;
    }
    if (ancestors.has(node)) {
      throw createCircularToolSchemaError();
    }
    ancestors.add(node);

    const record = node as Record<string, unknown>;
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
        ? record.required.filter((entry): entry is string => typeof entry === "string")
        : undefined;
      if (!required) {
        return false;
      }
      const requiredSet = new Set(required);
      if (Object.keys(properties).some((key) => !requiredSet.has(key))) {
        return false;
      }
    }

    pending.push({ kind: "leave", node });
    for (const [key, entry] of Object.entries(record)) {
      if (key === "properties" && entry && typeof entry === "object" && !Array.isArray(entry)) {
        for (const value of Object.values(entry as Record<string, unknown>)) {
          pending.push({ kind: "visit", node: value });
        }
        continue;
      }
      pending.push({ kind: "visit", node: entry });
    }
  }
  return true;
}

/** Resolves strict mode for the projected tools that will be emitted in the request payload. */
export function resolveOpenAIProjectedToolsStrictToolFlag(
  projection: OpenAIToolProjection,
  strict: boolean | null | undefined,
): boolean | undefined {
  if (strict !== true) {
    return strict === false ? false : undefined;
  }
  return projection.tools.every((tool) => isStrictOpenAIJsonSchemaCompatible(tool.parameters));
}
