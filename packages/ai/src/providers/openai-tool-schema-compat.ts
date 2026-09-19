import type { TSchema } from "typebox";

type NormalizeOpenAIStrictCompatOptions = {
  promoteEmptyObject: boolean;
};

const OPENAI_STRICT_COMPAT_SCHEMA_MAP_KEYS = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  // Draft-07 dependencies mix schema values with property-name arrays. The
  // recursive helpers leave scalar array entries untouched.
  "dependencies",
  "patternProperties",
  "properties",
]);

// Annotation-only keywords whose null values can be dropped without changing
// what the schema accepts; null constraint keywords must stay so projection
// quarantines the tool instead of widening it.
const OPENAI_NULLABLE_ANNOTATION_KEYS = new Set([
  "default",
  "description",
  "examples",
  "format",
  "title",
]);

const OPENAI_STRICT_COMPAT_SCHEMA_NESTED_KEYS = new Set([
  "additionalItems",
  "additionalProperties",
  "allOf",
  "anyOf",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "oneOf",
  "prefixItems",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

// Tool schemas are external input and can nest far deeper than the call stack, so this walker
// runs an explicit task stack instead of recursing (#141306). A visit task either resolves a
// leaf immediately or pushes one assemble task plus a visit task per child; the assemble task
// only runs after every child has written its result back, mirroring the original recursion.
// Children always walk with promoteEmptyObject: false; only the root visit promotes.
type CompatVisitTask = {
  kind: "visit";
  node: unknown;
  promoteEmptyObject: boolean;
  assign: (value: unknown) => void;
};

type CompatAssembleArrayTask = {
  kind: "assemble-array";
  node: object;
  assign: (value: unknown) => void;
  entries: unknown[];
  changed: boolean;
};

type CompatAssembleRecordTask = {
  kind: "assemble-record";
  node: object;
  assign: (value: unknown) => void;
  promoteEmptyObject: boolean;
  hadNullType: boolean;
  changed: boolean;
  // Entries in source order; map/nested child results write back through the entry.
  plan: Array<
    | { kind: "drop" }
    | { kind: "keep"; key: string; value: unknown }
    | {
        kind: "map";
        key: string;
        source: unknown;
        cleanedEntries: Array<[string, unknown]>;
        mapChanged: boolean;
      }
    | { kind: "nested"; key: string; value: unknown }
  >;
};

type CompatTask = CompatVisitTask | CompatAssembleArrayTask | CompatAssembleRecordTask;

function createCircularToolSchemaError(): TypeError {
  return new TypeError("Tool schema contains a circular reference and cannot be normalized.");
}

function normalizeOpenAIStrictCompatSchemaTree(
  root: unknown,
  rootOptions: NormalizeOpenAIStrictCompatOptions,
): unknown {
  let rootResult: unknown = root;
  // Recursion previously bounded cyclic object graphs via the call stack; the explicit stack
  // removes that implicit guard, so the walk tracks the nodes on its current path instead.
  const ancestors = new Set<object>();
  const tasks: CompatTask[] = [
    {
      kind: "visit",
      node: root,
      promoteEmptyObject: rootOptions.promoteEmptyObject,
      assign: (value) => {
        rootResult = value;
      },
    },
  ];
  let task: CompatTask | undefined;
  while ((task = tasks.pop()) !== undefined) {
    if (task.kind === "assemble-array") {
      ancestors.delete(task.node);
      task.assign(task.changed ? task.entries : task.node);
      continue;
    }
    if (task.kind === "assemble-record") {
      ancestors.delete(task.node);
      const mapChanged = task.plan.some((entry) => entry.kind === "map" && entry.mapChanged);
      const changed = task.changed || mapChanged;
      // Records rebuild through Object.fromEntries so user-named keys such as `__proto__`
      // become own properties, matching the recursion.
      const normalized = Object.fromEntries(
        task.plan.flatMap((entry): Array<[string, unknown]> => {
          if (entry.kind === "drop") {
            return [];
          }
          if (entry.kind === "map") {
            return [
              [
                entry.key,
                entry.mapChanged ? Object.fromEntries(entry.cleanedEntries) : entry.source,
              ],
            ];
          }
          return [[entry.key, entry.value]];
        }),
      );
      task.assign(
        applyCompatRecordPostProcessing(normalized, task.node, changed, {
          promoteEmptyObject: task.promoteEmptyObject,
          hadNullType: task.hadNullType,
        }),
      );
      continue;
    }
    const { node, assign } = task;
    if (Array.isArray(node)) {
      if (ancestors.has(node)) {
        throw createCircularToolSchemaError();
      }
      ancestors.add(node);
      const assemble: CompatAssembleArrayTask = {
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
          promoteEmptyObject: false,
          assign: (value) => {
            assemble.changed ||= value !== node[slot];
            assemble.entries[slot] = value;
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
    const assemble: CompatAssembleRecordTask = {
      kind: "assemble-record",
      node,
      assign,
      promoteEmptyObject: task.promoteEmptyObject,
      hadNullType: false,
      changed: false,
      plan: [],
    };
    const children: CompatVisitTask[] = [];
    for (const [key, value] of Object.entries(record)) {
      // Repair only null-valued entries that carry no constraint semantics.
      // Null constraints stay invalid so projection quarantines the tool.
      if (value === null && (OPENAI_NULLABLE_ANNOTATION_KEYS.has(key) || key === "type")) {
        assemble.hadNullType ||= key === "type";
        assemble.changed = true;
        assemble.plan.push({ kind: "drop" });
        continue;
      }
      if (OPENAI_STRICT_COMPAT_SCHEMA_MAP_KEYS.has(key)) {
        const mapEntry: Extract<CompatAssembleRecordTask["plan"][number], { kind: "map" }> = {
          kind: "map",
          key,
          source: value,
          cleanedEntries: [],
          mapChanged: false,
        };
        assemble.plan.push(mapEntry);
        if (value && typeof value === "object" && !Array.isArray(value)) {
          for (const [childKey, childValue] of Object.entries(value)) {
            children.push({
              kind: "visit",
              node: childValue,
              promoteEmptyObject: false,
              assign: (childResult) => {
                mapEntry.mapChanged ||= childResult !== childValue;
                mapEntry.cleanedEntries.push([childKey, childResult]);
              },
            });
          }
        }
        continue;
      }
      if (OPENAI_STRICT_COMPAT_SCHEMA_NESTED_KEYS.has(key)) {
        const planEntry: Extract<CompatAssembleRecordTask["plan"][number], { kind: "nested" }> = {
          kind: "nested",
          key,
          value,
        };
        assemble.plan.push(planEntry);
        children.push({
          kind: "visit",
          node: value,
          promoteEmptyObject: false,
          assign: (childResult) => {
            assemble.changed ||= childResult !== value;
            planEntry.value = childResult;
          },
        });
        continue;
      }
      assemble.plan.push({ kind: "keep", key, value });
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

// Post-processing shared by the changed and unchanged record paths: the recursion applied these
// repairs to its freshly built copy and returned the original only when that copy ended up
// identical, so both outcomes funnel through the same steps here.
function applyCompatRecordPostProcessing(
  normalized: Record<string, unknown>,
  original: object,
  changed: boolean,
  task: Pick<CompatAssembleRecordTask, "promoteEmptyObject" | "hadNullType">,
): unknown {
  if (Object.keys(normalized).length === 0) {
    if (!task.promoteEmptyObject) {
      return original;
    }
    return {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    };
  }

  let mutated = false;
  const hasObjectShapeHints =
    (normalized.properties &&
      typeof normalized.properties === "object" &&
      !Array.isArray(normalized.properties)) ||
    Array.isArray(normalized.required);
  const hasArrayShapeHints = "items" in normalized;
  if (!("type" in normalized) && hasObjectShapeHints !== hasArrayShapeHints) {
    normalized.type = hasObjectShapeHints ? "object" : "array";
    mutated = true;
  } else if (task.hadNullType && !("type" in normalized)) {
    // Without an unambiguous shape, retain the invalid type so projection
    // rejects the tool instead of widening it to an unconstrained schema.
    normalized.type = null;
  }
  if (normalized.type === "object" && !("properties" in normalized)) {
    normalized.properties = {};
    mutated = true;
  }

  const hasEmptyProperties =
    normalized.properties &&
    typeof normalized.properties === "object" &&
    !Array.isArray(normalized.properties) &&
    Object.keys(normalized.properties as Record<string, unknown>).length === 0;

  if (normalized.type === "object" && !Array.isArray(normalized.required) && hasEmptyProperties) {
    normalized.required = [];
    mutated = true;
  }
  if (
    normalized.type === "object" &&
    hasEmptyProperties &&
    !("additionalProperties" in normalized)
  ) {
    normalized.additionalProperties = false;
    mutated = true;
  }

  return changed || mutated ? normalized : original;
}

/** Repairs recoverable OpenAI tool-schema shapes before canonical normalization. */
export function normalizeOpenAIStrictCompatSchema(schema: unknown): TSchema {
  return normalizeOpenAIStrictCompatSchemaTree(schema, {
    promoteEmptyObject: true,
  }) as TSchema;
}

/** Finds schema paths that violate OpenAI strict tool-schema requirements. */
export function findOpenAIStrictSchemaViolations(
  schema: unknown,
  path: string,
  options?: { requireObjectRoot?: boolean },
): string[] {
  // Depth-first in the original recursion's visit order, via an explicit stack (#141306).
  // Leave markers bound cyclic object graphs the way the call stack bounded them before.
  type Pending =
    | { kind: "visit"; node: unknown; path: string; requireObjectRoot: boolean }
    | { kind: "leave"; node: object };
  const ancestors = new Set<object>();
  const violations: string[] = [];
  const pending: Pending[] = [
    { kind: "visit", node: schema, path, requireObjectRoot: options?.requireObjectRoot === true },
  ];
  let current: Pending | undefined;
  while ((current = pending.pop()) !== undefined) {
    if (current.kind === "leave") {
      ancestors.delete(current.node);
      continue;
    }
    const { node, path: currentPath } = current;
    if (Array.isArray(node)) {
      if (current.requireObjectRoot) {
        violations.push(`${currentPath}.type`);
        continue;
      }
      if (ancestors.has(node)) {
        throw createCircularToolSchemaError();
      }
      ancestors.add(node);
      pending.push({ kind: "leave", node });
      for (let index = node.length - 1; index >= 0; index -= 1) {
        pending.push({
          kind: "visit",
          node: node[index],
          path: `${currentPath}[${index}]`,
          requireObjectRoot: false,
        });
      }
      continue;
    }
    if (!node || typeof node !== "object") {
      if (current.requireObjectRoot) {
        violations.push(`${currentPath}.type`);
      }
      continue;
    }
    if (ancestors.has(node)) {
      throw createCircularToolSchemaError();
    }
    ancestors.add(node);

    const record = node as Record<string, unknown>;
    for (const key of ["anyOf", "oneOf", "allOf"] as const) {
      if (key in record) {
        violations.push(`${currentPath}.${key}`);
      }
    }
    if (Array.isArray(record.type)) {
      violations.push(`${currentPath}.type`);
    }

    const properties =
      record.properties &&
      typeof record.properties === "object" &&
      !Array.isArray(record.properties)
        ? (record.properties as Record<string, unknown>)
        : undefined;

    if (record.type === "object") {
      if (record.additionalProperties !== false) {
        violations.push(`${currentPath}.additionalProperties`);
      }
      const required = Array.isArray(record.required)
        ? record.required.filter((entry): entry is string => typeof entry === "string")
        : undefined;
      if (!required) {
        violations.push(`${currentPath}.required`);
      } else if (properties) {
        const requiredSet = new Set(required);
        for (const key of Object.keys(properties)) {
          if (!requiredSet.has(key)) {
            violations.push(`${currentPath}.required.${key}`);
          }
        }
      }
    }

    pending.push({ kind: "leave", node });
    const children: Array<{ node: unknown; path: string }> = [];
    // Schema maps contain user-chosen names. Walk their values as schemas, but
    // never interpret map keys such as `$defs.anyOf` as schema keywords.
    for (const key of OPENAI_STRICT_COMPAT_SCHEMA_MAP_KEYS) {
      const schemaMap = record[key];
      if (!schemaMap || typeof schemaMap !== "object" || Array.isArray(schemaMap)) {
        continue;
      }
      for (const [entryKey, value] of Object.entries(schemaMap as Record<string, unknown>)) {
        children.push({ node: value, path: `${currentPath}.${key}.${entryKey}` });
      }
    }
    // Only walk JSON Schema applicators. Annotation payloads such as
    // examples/default may contain arbitrary objects that are not schemas.
    for (const key of OPENAI_STRICT_COMPAT_SCHEMA_NESTED_KEYS) {
      const value = record[key];
      if (value && typeof value === "object") {
        children.push({ node: value, path: `${currentPath}.${key}` });
      }
    }
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child) {
        pending.push({
          kind: "visit",
          node: child.node,
          path: child.path,
          requireObjectRoot: false,
        });
      }
    }
  }
  return violations;
}
