// This helper accepts draft-07 through 2020-12 schemas. Keep the union of
// schema-bearing keys aligned with the package's dialect-specific walkers.
const SCHEMA_MAP_KEYS = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  // Draft-07 dependencies mix schemas with property-name arrays. Stripping
  // leaves the string entries in those arrays unchanged.
  "dependencies",
  "patternProperties",
  "properties",
]);

/** Containers whose value is a single nested schema. */
const SCHEMA_OBJECT_KEYS = new Set([
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

/** Containers whose value is a list of nested schemas. */
const SCHEMA_ARRAY_KEYS = new Set(["allOf", "anyOf", "items", "oneOf", "prefixItems"]);

// Tool schemas are external input and can nest far deeper than the call stack, so this walker
// runs an explicit task stack instead of recursing (#141306). A visit task either resolves a
// leaf immediately or pushes one assemble task plus a visit task per child; the assemble task
// only runs after every child has written its result back, mirroring the original recursion.
type StripVisitTask = {
  kind: "visit";
  node: unknown;
  assign: (value: unknown) => void;
};

type StripAssembleTask = {
  kind: "assemble";
  assign: (value: unknown) => void;
  node: object;
  // Plan entries in source order; child results write back through the entry, and the cleaned
  // record is built in plan order at assemble time so key insertion order matches the
  // recursion exactly.
  plan: Array<
    | { kind: "keep"; key: string; value: unknown }
    | { kind: "map"; key: string; entries: Array<[string, unknown]> }
    | { kind: "array"; key: string; entries: unknown[] }
    | { kind: "object"; key: string; value: unknown }
  >;
  arrayEntries: unknown[] | undefined;
};

type StripTask = StripVisitTask | StripAssembleTask;

/** Thrown when a tool schema graph revisits a node on its own walk path. */
function createCircularToolSchemaError(): TypeError {
  return new TypeError("Tool schema contains a circular reference and cannot be normalized.");
}

/** Remove schema keywords unsupported by a target provider/tool surface. */
export function stripUnsupportedSchemaKeywords(
  schema: unknown,
  unsupportedKeywords: ReadonlySet<string>,
): unknown {
  let rootResult: unknown = schema;
  // Recursion previously bounded cyclic object graphs via the call stack; the explicit stack
  // removes that implicit guard, so each walker tracks the nodes on its current path instead.
  const ancestors = new Set<object>();
  const tasks: StripTask[] = [
    {
      kind: "visit",
      node: schema,
      assign: (value) => {
        rootResult = value;
      },
    },
  ];
  let task: StripTask | undefined;
  while ((task = tasks.pop()) !== undefined) {
    if (task.kind === "assemble") {
      ancestors.delete(task.node);
      if (task.arrayEntries) {
        task.assign(task.arrayEntries);
        continue;
      }
      const cleaned: Record<string, unknown> = {};
      for (const entry of task.plan) {
        if (entry.kind === "map") {
          // Schema names are literal data; rebuild with Object.fromEntries so a `__proto__`
          // name becomes an own property, matching the recursion.
          cleaned[entry.key] = Object.fromEntries(entry.entries);
          continue;
        }
        cleaned[entry.key] = entry.kind === "array" ? entry.entries : entry.value;
      }
      task.assign(cleaned);
      continue;
    }
    const { node, assign } = task;
    if (!node || typeof node !== "object") {
      assign(node);
      continue;
    }
    if (ancestors.has(node)) {
      throw createCircularToolSchemaError();
    }
    ancestors.add(node);
    if (Array.isArray(node)) {
      const entries: unknown[] = Array.from({ length: node.length });
      tasks.push({ kind: "assemble", assign, node, plan: [], arrayEntries: entries });
      for (let index = node.length - 1; index >= 0; index -= 1) {
        const slot = index;
        tasks.push({
          kind: "visit",
          node: node[slot],
          assign: (value) => {
            entries[slot] = value;
          },
        });
      }
      continue;
    }
    const obj = node as Record<string, unknown>;
    const plan: StripAssembleTask["plan"] = [];
    const children: StripVisitTask[] = [];
    for (const [key, value] of Object.entries(obj)) {
      if (unsupportedKeywords.has(key)) {
        continue;
      }
      // Schema containers hold nested schemas under different shapes. Walk
      // through each known container while preserving unrelated metadata fields.
      if (SCHEMA_MAP_KEYS.has(key) && value && typeof value === "object" && !Array.isArray(value)) {
        const planEntry: Extract<StripAssembleTask["plan"][number], { kind: "map" }> = {
          kind: "map",
          key,
          entries: [],
        };
        plan.push(planEntry);
        for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
          children.push({
            kind: "visit",
            node: childValue,
            assign: (childResult) => {
              planEntry.entries.push([childKey, childResult]);
            },
          });
        }
        continue;
      }
      if (SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(value)) {
        const planEntry: Extract<StripAssembleTask["plan"][number], { kind: "array" }> = {
          kind: "array",
          key,
          entries: Array.from({ length: value.length }),
        };
        plan.push(planEntry);
        value.forEach((entry, index) => {
          children.push({
            kind: "visit",
            node: entry,
            assign: (childResult) => {
              planEntry.entries[index] = childResult;
            },
          });
        });
        continue;
      }
      if (SCHEMA_OBJECT_KEYS.has(key) && value && typeof value === "object") {
        const planEntry: Extract<StripAssembleTask["plan"][number], { kind: "object" }> = {
          kind: "object",
          key,
          value: undefined,
        };
        plan.push(planEntry);
        children.push({
          kind: "visit",
          node: value,
          assign: (childResult) => {
            planEntry.value = childResult;
          },
        });
        continue;
      }
      plan.push({ kind: "keep", key, value });
    }
    tasks.push({ kind: "assemble", assign, node, plan, arrayEntries: undefined });
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child) {
        tasks.push(child);
      }
    }
  }
  return rootResult;
}
