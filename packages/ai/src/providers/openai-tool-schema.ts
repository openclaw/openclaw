import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeToolParameterSchema,
  shouldOmitEmptyArrayItems,
  type ToolSchemaModelCompat,
} from "./agent-tools-parameter-schema.js";
import type { OpenAIToolProjection } from "./openai-tool-projection.js";
import { findOpenAIStrictSchemaViolations } from "./openai-tool-schema-compat.js";
import { SCHEMA_MAP_KEYS } from "./schema-walk.js";
import { assertToolSchemaDepth, ToolSchemaDepthExceededError } from "./tool-schema-depth.js";
import { createToolSchemaNormalizationCache } from "./tool-schema-normalization-cache.js";

export { findOpenAIStrictSchemaViolations } from "./openai-tool-schema-compat.js";

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
  const cacheable = typeof schemaInput === "object";
  const cacheKey = cacheable ? resolveStrictOpenAISchemaCacheKey(modelCompat) : "";
  if (cacheable) {
    const cached = strictOpenAISchemaCache.get(schemaInput, cacheKey);
    if (cached !== undefined) {
      return cached;
    }
  }
  const normalized = normalizeStrictOpenAIJsonSchemaRecursive(
    normalizeToolParameterSchema(schemaInput, {
      modelCompat: resolveToolSchemaModelCompat(modelCompat),
    }),
    0,
  );
  // Preserve object identity per input and compatibility key.
  return cacheable
    ? strictOpenAISchemaCache.remember(schemaInput, cacheKey, normalized)
    : normalized;
}

function normalizeStrictOpenAIJsonSchemaRecursive(
  schema: unknown,
  depth: number,
  nesting = 0,
): unknown {
  // `depth` counts object levels for the root additionalProperties rule, while
  // `nesting` bounds every structural hop, including unbounded array chains.
  assertToolSchemaDepth(nesting);
  if (Array.isArray(schema)) {
    let changed = false;
    const normalized = schema.map((entry) => {
      const next = normalizeStrictOpenAIJsonSchemaRecursive(entry, depth, nesting + 1);
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
  const normalized = Object.fromEntries<unknown>(
    Object.entries(record).map(([key, value]) => {
      // Schema map containers ($defs, properties, ...) are transparent for the
      // nesting bound: their entries sit one level below the owning schema,
      // matching the shared depth accounting used by the general and
      // compatibility walkers. The `depth` rule (root additionalProperties) is
      // unchanged: only `properties` carries the parent depth.
      const mapContainer = SCHEMA_MAP_KEYS.has(key);
      const next = normalizeStrictOpenAIJsonSchemaRecursive(
        value,
        key === "properties" ? depth : depth + 1,
        mapContainer ? nesting : nesting + 1,
      );
      changed ||= next !== value;
      return [key, next];
    }),
  );

  if (normalized.type === "object") {
    const properties = isRecord(normalized.properties) ? normalized.properties : undefined;
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
  let normalized: unknown;
  try {
    normalized = normalizeStrictOpenAIJsonSchema(schema);
  } catch (error) {
    if (error instanceof ToolSchemaDepthExceededError) {
      // A schema past the traversal budget cannot be verified, so it is not
      // strict-compatible; strict-mode resolution must not crash either.
      return false;
    }
    throw error;
  }
  return findOpenAIStrictSchemaViolations(normalized, "parameters").length === 0;
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
      let violations: string[];
      try {
        violations = findOpenAIStrictSchemaViolations(
          normalizeStrictOpenAIJsonSchema(tool.parameters),
          `${tool.name}.parameters`,
        );
      } catch (error) {
        if (error instanceof ToolSchemaDepthExceededError) {
          // Diagnostics are logging-only: report the rejected schema as a
          // bounded violation instead of rethrowing past the logger and
          // aborting healthy siblings during strict-resolution logging.
          return [
            { toolIndex: tool.toolIndex, toolName: tool.name, violations: [`${tool.name}.parameters.depth`] },
          ];
        }
        throw error;
      }
      return violations.length > 0
        ? [{ toolIndex: tool.toolIndex, toolName: tool.name, violations }]
        : [];
    }),
  ];
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
