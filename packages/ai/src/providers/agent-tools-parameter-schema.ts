/**
 * Normalizes model-facing tool parameter schemas across provider quirks.
 * Handles local JSON Schema refs, OpenAPI nullable syntax, top-level unions,
 * and provider-specific unsupported keyword stripping.
 */
import { isRecord as isSchemaRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  normalizeStringEntries,
  uniqueValues,
} from "@openclaw/normalization-core/string-normalization";
import type { TSchema } from "typebox";
import { normalizeOpenApiSchemaKeywords } from "./agent-tools-openapi-keywords.js";
import {
  createCircularToolSchemaError,
  SCHEMA_ARRAY_KEYS,
  SCHEMA_MAP_KEYS,
  SCHEMA_OBJECT_KEYS,
  setOwnSchemaProperty,
} from "./agent-tools-schema-keys.js";
import { inlineLocalToolSchemaRefs } from "./agent-tools-schema-refs.js";
import { cleanSchemaForGemini } from "./clean-for-gemini.js";
import { cleanSchemaForLlamacppGbnf } from "./clean-for-llamacpp-gbnf.js";
import { stripUnsupportedSchemaKeywords } from "./schema-keyword-strip.js";
import { createToolSchemaNormalizationCache } from "./tool-schema-normalization-cache.js";

/**
 * Narrow structural view of the host's model compat config. packages/ai must stay
 * config-agnostic, so only tool-schema-relevant fields are modeled here; the host's
 * ModelCompatConfig remains structurally assignable.
 */
export type ToolSchemaModelCompat = {
  toolSchemaProfile?: string;
  unsupportedToolSchemaKeywords?: string[];
  omitEmptyArrayItems?: boolean;
};

/** Extracts the compat record whether callers pass a model (`{ compat }`) or the compat itself. */
export function extractToolSchemaModelCompat(
  modelOrCompat: { compat?: unknown } | ToolSchemaModelCompat | undefined,
): ToolSchemaModelCompat | undefined {
  if (!modelOrCompat || typeof modelOrCompat !== "object") {
    return undefined;
  }
  if ("compat" in modelOrCompat) {
    const compat = (modelOrCompat as { compat?: unknown }).compat;
    return compat && typeof compat === "object" ? (compat as ToolSchemaModelCompat) : undefined;
  }
  return modelOrCompat as ToolSchemaModelCompat;
}

/** JSON Schema keywords this model/provider rejects in tool schemas. */
export function resolveUnsupportedToolSchemaKeywords(
  modelOrCompat: { compat?: unknown } | ToolSchemaModelCompat | undefined,
): ReadonlySet<string> {
  const keywords = extractToolSchemaModelCompat(modelOrCompat)?.unsupportedToolSchemaKeywords ?? [];
  return new Set(
    normalizeStringEntries(
      keywords.filter((keyword): keyword is string => typeof keyword === "string"),
    ),
  );
}

/** Whether empty `items: {}` on array schemas must be omitted for this model/provider. */
export function shouldOmitEmptyArrayItems(
  modelOrCompat: { compat?: unknown } | ToolSchemaModelCompat | undefined,
): boolean {
  return extractToolSchemaModelCompat(modelOrCompat)?.omitEmptyArrayItems === true;
}

export type ToolParameterSchemaOptions = {
  modelProvider?: string;
  modelId?: string;
  modelCompat?: ToolSchemaModelCompat;
};

const MAX_TOOL_PARAMETER_SCHEMA_CACHE_ENTRIES_PER_SCHEMA = 8;
const toolParameterSchemaCache = createToolSchemaNormalizationCache<TSchema>(
  MAX_TOOL_PARAMETER_SCHEMA_CACHE_ENTRIES_PER_SCHEMA,
);

function resolveToolParameterSchemaCacheKey(
  options: ToolParameterSchemaOptions | undefined,
): string {
  const normalizedProvider = normalizeLowercaseStringOrEmpty(options?.modelProvider);
  const normalizedModelId = normalizeLowercaseStringOrEmpty(options?.modelId);
  const toolSchemaProfile = normalizeLowercaseStringOrEmpty(
    options?.modelCompat?.toolSchemaProfile,
  );
  const unsupportedKeywords = Array.from(
    resolveUnsupportedToolSchemaKeywords(options?.modelCompat),
  ).toSorted();
  const omitEmptyArrayItems = shouldOmitEmptyArrayItems(options?.modelCompat);
  return JSON.stringify([
    normalizedProvider,
    normalizedModelId,
    toolSchemaProfile,
    unsupportedKeywords,
    omitEmptyArrayItems,
  ]);
}

function isGeminiModelId(modelId: string): boolean {
  return /(?:^|[/:])gemini(?:$|[-/:.])/.test(modelId);
}

function extractEnumValues(schema: unknown): unknown[] | undefined {
  if (!schema || typeof schema !== "object") {
    return undefined;
  }
  const record = schema as Record<string, unknown>;
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
  // Variant chains are external input and can nest deeper than the call stack, so expansion
  // runs depth-first on an explicit stack (#141306). Leave markers bound cyclic object graphs
  // the way the call stack bounded them before.
  type Pending = { kind: "visit"; node: unknown } | { kind: "leave"; node: object };
  const ancestors = new Set<object>();
  const values: unknown[] = [];
  const pending: Pending[] = [];
  for (let index = variants.length - 1; index >= 0; index -= 1) {
    pending.push({ kind: "visit", node: variants[index] });
  }
  let current: Pending | undefined;
  while ((current = pending.pop()) !== undefined) {
    if (current.kind === "leave") {
      ancestors.delete(current.node);
      continue;
    }
    const node = current.node;
    // Arrays contribute nothing here (no enum/const/composition keys), so the record guard
    // skipping them matches the recursion, which read the same missing keys as undefined.
    if (!isSchemaRecord(node)) {
      continue;
    }
    if (ancestors.has(node)) {
      throw createCircularToolSchemaError();
    }
    ancestors.add(node);
    if (Array.isArray(node.enum)) {
      // Append per entry: spreading the enum into push arguments reintroduces the engine's
      // argument-count limit on wide enums, which the original flatMap did not hit.
      for (const enumValue of node.enum) {
        values.push(enumValue);
      }
      ancestors.delete(node);
      continue;
    }
    if ("const" in node) {
      values.push(node.const);
      ancestors.delete(node);
      continue;
    }
    const childVariants = Array.isArray(node.anyOf)
      ? node.anyOf
      : Array.isArray(node.oneOf)
        ? node.oneOf
        : null;
    if (!childVariants) {
      ancestors.delete(node);
      continue;
    }
    pending.push({ kind: "leave", node });
    for (let index = childVariants.length - 1; index >= 0; index -= 1) {
      pending.push({ kind: "visit", node: childVariants[index] });
    }
  }
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
  if (existingEnum || incomingEnum) {
    const values = uniqueValues([...(existingEnum ?? []), ...(incomingEnum ?? [])]);
    const merged: Record<string, unknown> = {};
    for (const source of [existing, incoming]) {
      if (!source || typeof source !== "object") {
        continue;
      }
      const record = source as Record<string, unknown>;
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

  return existing;
}

type FlattenableVariantKey = "anyOf" | "oneOf";
type TopLevelConditionalKey = FlattenableVariantKey | "allOf";

function hasTopLevelArrayKeyword(
  schemaRecord: Record<string, unknown>,
  key: TopLevelConditionalKey,
): boolean {
  return Array.isArray(schemaRecord[key]);
}

function getFlattenableVariantKey(
  schemaRecord: Record<string, unknown>,
): FlattenableVariantKey | null {
  if (hasTopLevelArrayKeyword(schemaRecord, "anyOf")) {
    return "anyOf";
  }
  if (hasTopLevelArrayKeyword(schemaRecord, "oneOf")) {
    return "oneOf";
  }
  return null;
}

function getTopLevelConditionalKey(
  schemaRecord: Record<string, unknown>,
): TopLevelConditionalKey | null {
  return (
    getFlattenableVariantKey(schemaRecord) ??
    (hasTopLevelArrayKeyword(schemaRecord, "allOf") ? "allOf" : null)
  );
}

function hasTopLevelObjectSchema(
  schemaRecord: Record<string, unknown>,
  conditionalKey: TopLevelConditionalKey | null,
): boolean {
  return (
    schemaRecord.type === "object" &&
    isSchemaRecord(schemaRecord.properties) &&
    conditionalKey === null
  );
}

function isObjectLikeSchemaMissingType(
  schemaRecord: Record<string, unknown>,
  conditionalKey: TopLevelConditionalKey | null,
): boolean {
  return (
    !("type" in schemaRecord) &&
    (isSchemaRecord(schemaRecord.properties) || Array.isArray(schemaRecord.required)) &&
    conditionalKey === null
  );
}

function isTypedObjectSchemaMissingValidProperties(
  schemaRecord: Record<string, unknown>,
  conditionalKey: TopLevelConditionalKey | null,
): boolean {
  return (
    schemaRecord.type === "object" &&
    !isSchemaRecord(schemaRecord.properties) &&
    conditionalKey === null
  );
}

function isTrulyEmptySchema(schemaRecord: Record<string, unknown>): boolean {
  return Object.keys(schemaRecord).length === 0;
}

type ArrayItemsMode = "add" | "omit" | "normalize";

// Tool schemas are external input and can nest far deeper than the call stack, so this walker
// runs an explicit task stack instead of recursing (#141306). A visit task either resolves a
// leaf immediately or pushes one assemble task plus a visit task per child; the assemble task
// only runs after every child has written its result back, mirroring the original recursion.
type ArrayItemsVisitTask = {
  kind: "visit";
  node: unknown;
  mode: ArrayItemsMode;
  assign: (value: unknown) => void;
};

type ArrayItemsAssembleArrayTask = {
  kind: "assemble-array";
  node: object;
  assign: (value: unknown) => void;
  entries: unknown[];
  changed: boolean;
};

type ArrayItemsAssembleRecordTask = {
  kind: "assemble-record";
  node: object;
  assign: (value: unknown) => void;
  // Shallow copy of the source record with the missing-items adjustment already applied.
  normalized: Record<string, unknown>;
  changed: boolean;
  // Plan entries in source order; child results write back through the entry.
  plan: Array<
    | { kind: "keep" }
    | { kind: "drop-items" }
    | {
        kind: "map";
        key: string;
        source: Record<string, unknown>;
        entries: Array<[string, unknown]>;
        mapChanged: boolean;
      }
    | {
        kind: "value";
        key: string;
        source: unknown[];
        // One child per array entry (composition list).
        childResults: unknown[];
        childrenAreArrayEntries: true;
      }
    | {
        kind: "value";
        key: string;
        source: unknown;
        // Single child (non-array value).
        childResults: unknown[];
        childrenAreArrayEntries: false;
      }
  >;
};

type ArrayItemsTask =
  | ArrayItemsVisitTask
  | ArrayItemsAssembleArrayTask
  | ArrayItemsAssembleRecordTask;

function normalizeArraySchemaItems(root: unknown, mode: ArrayItemsMode): unknown {
  let rootResult: unknown = root;
  // Recursion previously bounded cyclic object graphs via the call stack; the explicit stack
  // removes that implicit guard, so the walk tracks the nodes on its current path instead.
  const ancestors = new Set<object>();
  const tasks: ArrayItemsTask[] = [
    {
      kind: "visit",
      node: root,
      mode,
      assign: (value) => {
        rootResult = value;
      },
    },
  ];
  let task: ArrayItemsTask | undefined;
  while ((task = tasks.pop()) !== undefined) {
    if (task.kind === "assemble-array") {
      ancestors.delete(task.node);
      task.assign(task.changed ? task.entries : task.node);
      continue;
    }
    if (task.kind === "assemble-record") {
      ancestors.delete(task.node);
      const { normalized, plan } = task;
      let changed = task.changed;
      for (const entry of plan) {
        if (entry.kind === "keep") {
          continue;
        }
        if (entry.kind === "drop-items") {
          delete normalized.items;
          changed = true;
          continue;
        }
        if (entry.kind === "map") {
          if (entry.mapChanged) {
            setOwnSchemaProperty(normalized, entry.key, Object.fromEntries(entry.entries));
            changed = true;
          }
          continue;
        }
        const next = entry.childrenAreArrayEntries
          ? entry.childResults.some((result, index) => result !== entry.source[index])
            ? entry.childResults
            : entry.source
          : entry.childResults[0];
        if (next !== entry.source) {
          setOwnSchemaProperty(normalized, entry.key, next);
          changed = true;
        }
      }
      task.assign(changed ? normalized : task.node);
      continue;
    }
    const { node, mode: taskMode, assign } = task;
    if (Array.isArray(node)) {
      // Only omission descends through a malformed array used as a schema node.
      // Addition visits direct tuple/composition entries through the record plan below.
      if (taskMode === "add") {
        assign(node);
        continue;
      }
      if (ancestors.has(node)) {
        throw createCircularToolSchemaError();
      }
      ancestors.add(node);
      const assemble: ArrayItemsAssembleArrayTask = {
        kind: "assemble-array",
        node,
        assign,
        entries: Array.from({ length: node.length }),
        changed: false,
      };
      tasks.push(assemble);
      for (let index = node.length - 1; index >= 0; index -= 1) {
        const slot = index;
        tasks.push({
          kind: "visit",
          node: node[slot],
          mode: "omit",
          assign: (value) => {
            assemble.changed ||= value !== node[slot];
            assemble.entries[slot] = value;
          },
        });
      }
      continue;
    }
    if (!isSchemaRecord(node)) {
      assign(node);
      continue;
    }
    if (ancestors.has(node)) {
      throw createCircularToolSchemaError();
    }
    ancestors.add(node);

    const schema = node;
    const missingItems =
      taskMode !== "omit" && schema.type === "array" && schema.items === undefined;
    const normalized: Record<string, unknown> = { ...schema };
    if (missingItems) {
      if (taskMode === "add") {
        normalized.items = {};
      } else {
        // The former add-then-omit flow also removed an explicitly undefined items key.
        delete normalized.items;
      }
    }
    const allowsArray =
      schema.type === "array" || (Array.isArray(schema.type) && schema.type.includes("array"));

    const assemble: ArrayItemsAssembleRecordTask = {
      kind: "assemble-record",
      node: schema,
      assign,
      normalized,
      changed: missingItems,
      plan: [],
    };
    const children: ArrayItemsVisitTask[] = [];
    for (const [key, value] of Object.entries(normalized)) {
      if (
        taskMode !== "add" &&
        key === "items" &&
        allowsArray &&
        isSchemaRecord(value) &&
        isTrulyEmptySchema(value)
      ) {
        assemble.plan.push({ kind: "drop-items" });
        continue;
      }
      if (SCHEMA_MAP_KEYS.has(key) && isSchemaRecord(value)) {
        const mapEntry: Extract<ArrayItemsAssembleRecordTask["plan"][number], { kind: "map" }> = {
          kind: "map",
          key,
          source: value,
          entries: [],
          mapChanged: false,
        };
        assemble.plan.push(mapEntry);
        for (const [childKey, childValue] of Object.entries(value)) {
          children.push({
            kind: "visit",
            node: childValue,
            mode: taskMode,
            assign: (childResult) => {
              mapEntry.mapChanged ||= childResult !== childValue;
              mapEntry.entries.push([childKey, childResult]);
            },
          });
        }
        continue;
      }
      if (SCHEMA_OBJECT_KEYS.has(key) || SCHEMA_ARRAY_KEYS.has(key)) {
        // Addition historically accepts a schema object in a composition slot;
        // omission only traverses composition arrays. Keep that malformed-input boundary.
        const valueMode = SCHEMA_OBJECT_KEYS.has(key) || Array.isArray(value) ? taskMode : "add";
        if (valueMode === taskMode || taskMode !== "omit") {
          if (Array.isArray(value)) {
            const planEntry: Extract<
              ArrayItemsAssembleRecordTask["plan"][number],
              { kind: "value" }
            > = {
              kind: "value",
              key,
              source: value,
              childResults: Array.from({ length: value.length }),
              childrenAreArrayEntries: true,
            };
            assemble.plan.push(planEntry);
            value.forEach((entry, index) => {
              children.push({
                kind: "visit",
                node: entry,
                mode: valueMode,
                assign: (childResult) => {
                  planEntry.childResults[index] = childResult;
                },
              });
            });
          } else {
            const planEntry: Extract<
              ArrayItemsAssembleRecordTask["plan"][number],
              { kind: "value" }
            > = {
              kind: "value",
              key,
              source: value,
              childResults: [undefined],
              childrenAreArrayEntries: false,
            };
            assemble.plan.push(planEntry);
            children.push({
              kind: "visit",
              node: value,
              mode: valueMode,
              assign: (childResult) => {
                planEntry.childResults[0] = childResult;
              },
            });
          }
          continue;
        }
      }
      assemble.plan.push({ kind: "keep" });
    }
    tasks.push(assemble);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child) {
        tasks.push(child);
      }
    }
  }
  return rootResult;
}

function normalizeToolParameterSchemaUncached(
  schema: unknown,
  options?: ToolParameterSchemaOptions,
): TSchema {
  const inlinedSchema = normalizeOpenApiSchemaKeywords(inlineLocalToolSchemaRefs(schema));
  const schemaRecord =
    inlinedSchema && typeof inlinedSchema === "object"
      ? (inlinedSchema as Record<string, unknown>)
      : undefined;
  if (!schemaRecord) {
    return inlinedSchema as TSchema;
  }

  // Provider quirks:
  // - Gemini rejects several JSON Schema keywords, so we scrub those.
  // - OpenAI rejects function tool schemas unless the *top-level* is `type: "object"`.
  //   (TypeBox root unions compile to `{ anyOf: [...] }` without `type`).
  // - Anthropic expects full JSON Schema draft 2020-12 compliance.
  // - xAI's documented tool-schema contract rejects contains-count bounds.
  //
  // Normalize once here so callers can always pass `tools` through unchanged.
  const normalizedProvider = normalizeLowercaseStringOrEmpty(options?.modelProvider);
  const normalizedModelId = normalizeLowercaseStringOrEmpty(options?.modelId);
  const normalizedToolSchemaProfile = normalizeLowercaseStringOrEmpty(
    options?.modelCompat?.toolSchemaProfile,
  );
  const isGeminiProvider =
    normalizedProvider.includes("google") ||
    normalizedProvider.includes("gemini") ||
    isGeminiModelId(normalizedModelId) ||
    normalizedToolSchemaProfile === "gemini";
  const isAnthropicProvider = normalizedProvider.includes("anthropic");
  const unsupportedToolSchemaKeywords = resolveUnsupportedToolSchemaKeywords(options?.modelCompat);
  const omitEmptyArrayItems = shouldOmitEmptyArrayItems(options?.modelCompat);
  const isLlamacppGbnfProfile = normalizedToolSchemaProfile === "llamacpp";

  function applyProviderCleaning(s: unknown): TSchema {
    let arrayItemsCompatibleSchema = normalizeArraySchemaItems(
      s,
      omitEmptyArrayItems ? "normalize" : "add",
    );
    if (isLlamacppGbnfProfile) {
      arrayItemsCompatibleSchema = cleanSchemaForLlamacppGbnf(arrayItemsCompatibleSchema);
    }
    if (isGeminiProvider && !isAnthropicProvider) {
      const geminiCompatibleSchema = cleanSchemaForGemini(arrayItemsCompatibleSchema);
      return unsupportedToolSchemaKeywords.size > 0
        ? (stripUnsupportedSchemaKeywords(
            geminiCompatibleSchema,
            unsupportedToolSchemaKeywords,
          ) as TSchema)
        : geminiCompatibleSchema;
    }
    if (unsupportedToolSchemaKeywords.size > 0) {
      return stripUnsupportedSchemaKeywords(
        arrayItemsCompatibleSchema,
        unsupportedToolSchemaKeywords,
      ) as TSchema;
    }
    return arrayItemsCompatibleSchema as TSchema;
  }

  const conditionalKey = getTopLevelConditionalKey(schemaRecord);
  const flattenableVariantKey = getFlattenableVariantKey(schemaRecord);

  if (hasTopLevelObjectSchema(schemaRecord, conditionalKey)) {
    return applyProviderCleaning(schemaRecord);
  }

  if (isObjectLikeSchemaMissingType(schemaRecord, conditionalKey)) {
    return applyProviderCleaning({
      ...schemaRecord,
      type: "object",
      properties: isSchemaRecord(schemaRecord.properties) ? schemaRecord.properties : {},
    });
  }

  if (isTypedObjectSchemaMissingValidProperties(schemaRecord, conditionalKey)) {
    return applyProviderCleaning({ ...schemaRecord, properties: {} });
  }

  if (!flattenableVariantKey) {
    if (isTrulyEmptySchema(schemaRecord)) {
      // Handle the proven MCP no-parameter case: a truly empty schema object.
      return applyProviderCleaning({ type: "object", properties: {} });
    }
    if (conditionalKey === "allOf") {
      // Top-level `allOf` is not safely flattenable with the same heuristics we
      // use for unions. Keep it explicit rather than silently rewriting it.
      return applyProviderCleaning(inlinedSchema);
    }
    return applyProviderCleaning(inlinedSchema);
  }
  const variants = schemaRecord[flattenableVariantKey] as unknown[];
  // Seed mergedProperties with the root-declared properties so branch properties
  // merge *into* them instead of replacing them. Otherwise a root `required`
  // field that is not re-declared in any branch would be dropped from
  // `properties` while staying `required`, producing an unsatisfiable schema
  // when `additionalProperties` is false (#128743).
  const mergedProperties: Record<string, unknown> = isSchemaRecord(schemaRecord.properties)
    ? { ...schemaRecord.properties }
    : {};
  const requiredCounts = new Map<string, number>();
  let objectVariants = 0;

  for (const entry of variants) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const props = (entry as { properties?: unknown }).properties;
    if (!props || typeof props !== "object") {
      continue;
    }
    objectVariants += 1;
    for (const [key, value] of Object.entries(props as Record<string, unknown>)) {
      const existing = Object.hasOwn(mergedProperties, key) ? mergedProperties[key] : undefined;
      setOwnSchemaProperty(mergedProperties, key, mergePropertySchemas(existing, value));
    }
    const required = Array.isArray((entry as { required?: unknown }).required)
      ? (entry as { required: unknown[] }).required
      : [];
    for (const key of required) {
      if (typeof key !== "string") {
        continue;
      }
      requiredCounts.set(key, (requiredCounts.get(key) ?? 0) + 1);
    }
  }

  const baseRequired = Array.isArray(schemaRecord.required)
    ? schemaRecord.required.filter((key) => typeof key === "string")
    : undefined;
  const mergedRequired =
    baseRequired && baseRequired.length > 0
      ? baseRequired
      : objectVariants > 0
        ? Array.from(requiredCounts.entries())
            .filter(([, count]) => count === objectVariants)
            .map(([key]) => key)
        : undefined;

  const nextSchema: Record<string, unknown> = { ...schemaRecord };
  const flattenedSchema = {
    type: "object",
    ...(typeof nextSchema.title === "string" ? { title: nextSchema.title } : {}),
    ...(typeof nextSchema.description === "string" ? { description: nextSchema.description } : {}),
    properties:
      Object.keys(mergedProperties).length > 0 ? mergedProperties : (schemaRecord.properties ?? {}),
    ...(mergedRequired && mergedRequired.length > 0 ? { required: mergedRequired } : {}),
    additionalProperties:
      "additionalProperties" in schemaRecord ? schemaRecord.additionalProperties : true,
  };

  // Flatten union schemas into a single object schema:
  // - Gemini doesn't allow top-level `type` together with `anyOf`.
  // - OpenAI rejects schemas without top-level `type: "object"`.
  // - Anthropic accepts proper JSON Schema with constraints.
  // Merging properties preserves useful enums like `action` while keeping schemas portable.
  return applyProviderCleaning(flattenedSchema);
}

/** Return a provider-compatible JSON schema for a model-facing tool. */
export function normalizeToolParameterSchema(
  schema: unknown,
  options?: ToolParameterSchemaOptions,
): TSchema {
  if (!schema || typeof schema !== "object") {
    return normalizeToolParameterSchemaUncached(schema, options);
  }
  const cacheKey = resolveToolParameterSchemaCacheKey(options);
  const cached = toolParameterSchemaCache.get(schema, cacheKey);
  if (cached) {
    return cached;
  }
  return toolParameterSchemaCache.remember(
    schema,
    cacheKey,
    normalizeToolParameterSchemaUncached(schema, options),
  );
}
