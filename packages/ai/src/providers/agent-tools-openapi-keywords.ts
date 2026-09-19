/** OpenAPI-flavored keyword normalization (nullable syntax, composition cleanup). */
import { isRecord as isSchemaRecord } from "@openclaw/normalization-core/record-coerce";
import {
  copySchemaMeta,
  createCircularToolSchemaError,
  SCHEMA_ARRAY_KEYS,
  SCHEMA_LITERAL_KEYS,
  SCHEMA_MAP_KEYS,
  SCHEMA_OBJECT_KEYS,
} from "./agent-tools-schema-keys.js";

const OPENAPI_SCHEMA_ANNOTATION_KEYS = new Set([
  "discriminator",
  "externalDocs",
  "readOnly",
  "writeOnly",
  "xml",
  "example",
]);

function appendNullSchemaType(type: unknown): unknown {
  if (type === "null") {
    return type;
  }
  if (typeof type === "string") {
    return [type, "null"];
  }
  if (Array.isArray(type)) {
    return type.includes("null") ? type : [...type, "null"];
  }
  return type;
}

function isNullSchemaLike(schema: unknown): boolean {
  if (!isSchemaRecord(schema)) {
    return false;
  }
  if (schema.type === "null") {
    return true;
  }
  if (Array.isArray(schema.type) && schema.type.includes("null")) {
    return true;
  }
  if ("const" in schema && schema.const === null) {
    return true;
  }
  return Array.isArray(schema.enum) && schema.enum.includes(null);
}

function hasOpenApiComposition(schema: Record<string, unknown>): boolean {
  return ["allOf", "anyOf", "oneOf"].some((key) => Array.isArray(schema[key]));
}

function schemaCompositionAlreadyAllowsNull(schema: Record<string, unknown>): boolean {
  return (
    (Array.isArray(schema.anyOf) && schema.anyOf.some(isNullSchemaLike)) ||
    (Array.isArray(schema.oneOf) && schema.oneOf.some(isNullSchemaLike))
  );
}

function wrapNullableComposedSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (schemaCompositionAlreadyAllowsNull(schema)) {
    return schema;
  }
  const wrapped: Record<string, unknown> = {
    anyOf: [schema, { type: "null" }],
  };
  copySchemaMeta(schema, wrapped);
  return wrapped;
}

// Tool schemas are external input and can nest far deeper than the call stack, so this walker
// runs an explicit task stack instead of recursing (#141306). A visit task either resolves a
// leaf immediately or pushes one assemble task plus a visit task per child; the assemble task
// only runs after every child has written its result back, mirroring the original recursion.
type OpenApiKeywordsVisitTask = {
  kind: "visit";
  node: unknown;
  assign: (value: unknown) => void;
};

type OpenApiKeywordsAssembleArrayTask = {
  kind: "assemble-array";
  node: object;
  assign: (value: unknown) => void;
  entries: unknown[];
  changed: boolean;
};

type OpenApiKeywordsAssembleRecordTask = {
  kind: "assemble-record";
  node: object;
  assign: (value: unknown) => void;
  nullable: boolean;
  changed: boolean;
  // Captured at visit time; the assemble task rebuilds from these when any child changed.
  sourceEntries: Array<[string, unknown]>;
  // Plan entries in source order; child results write back through the entry.
  plan: Array<
    | { kind: "drop"; key: string }
    | { kind: "literal" }
    | {
        kind: "map";
        key: string;
        source: unknown;
        entries: Array<[string, unknown]>;
        mapChanged: boolean;
      }
    | { kind: "object"; key: string; source: unknown; value: unknown }
    | { kind: "array"; key: string; source: unknown[]; entries: unknown[]; arrayChanged: boolean }
    | { kind: "other" }
  >;
};

type OpenApiKeywordsTask =
  | OpenApiKeywordsVisitTask
  | OpenApiKeywordsAssembleArrayTask
  | OpenApiKeywordsAssembleRecordTask;

export function normalizeOpenApiSchemaKeywords(root: unknown): unknown {
  let rootResult: unknown = root;
  // Recursion previously bounded cyclic object graphs via the call stack; the explicit stack
  // removes that implicit guard, so the walk tracks the nodes on its current path instead.
  const ancestors = new Set<object>();
  const tasks: OpenApiKeywordsTask[] = [
    {
      kind: "visit",
      node: root,
      assign: (value) => {
        rootResult = value;
      },
    },
  ];
  let task: OpenApiKeywordsTask | undefined;
  while ((task = tasks.pop()) !== undefined) {
    if (task.kind === "assemble-array") {
      ancestors.delete(task.node);
      task.assign(task.changed ? task.entries : task.node);
      continue;
    }
    if (task.kind === "assemble-record") {
      ancestors.delete(task.node);
      const sourceEntries = task.sourceEntries;
      let normalized: Record<string, unknown> | undefined;
      let changed = task.changed;
      for (const entry of task.plan) {
        if (entry.kind === "literal" || entry.kind === "other") {
          continue;
        }
        if (entry.kind === "drop") {
          normalized ??= Object.fromEntries(sourceEntries);
          delete normalized[entry.key];
          continue;
        }
        if (entry.kind === "map") {
          if (entry.mapChanged) {
            (normalized ??= Object.fromEntries(sourceEntries))[entry.key] = Object.fromEntries(
              entry.entries,
            );
            changed = true;
          }
          continue;
        }
        if (entry.kind === "object") {
          if (entry.value !== entry.source) {
            (normalized ??= Object.fromEntries(sourceEntries))[entry.key] = entry.value;
            changed = true;
          }
          continue;
        }
        // A changed sibling also exposes these composition-array copies.
        (normalized ??= Object.fromEntries(sourceEntries))[entry.key] = entry.entries;
        changed ||= entry.arrayChanged;
      }

      if (task.nullable) {
        normalized ??= Object.fromEntries(sourceEntries);
        if (hasOpenApiComposition(normalized)) {
          task.assign(wrapNullableComposedSchema(normalized));
          continue;
        }
        if ("type" in normalized) {
          const nextType = appendNullSchemaType(normalized.type);
          if (nextType !== normalized.type) {
            normalized.type = nextType;
          }
        }
        if (Array.isArray(normalized.enum) && !normalized.enum.includes(null)) {
          normalized.enum = [...normalized.enum, null];
        }
      }

      task.assign(changed || task.nullable ? (normalized ?? task.node) : task.node);
      continue;
    }
    const { node, assign } = task;
    if (Array.isArray(node)) {
      if (ancestors.has(node)) {
        throw createCircularToolSchemaError();
      }
      ancestors.add(node);
      const assemble: OpenApiKeywordsAssembleArrayTask = {
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

    const assemble: OpenApiKeywordsAssembleRecordTask = {
      kind: "assemble-record",
      node,
      assign,
      nullable: node.nullable === true,
      changed: false,
      sourceEntries: Object.entries(node),
      plan: [],
    };
    const children: OpenApiKeywordsVisitTask[] = [];
    for (const [key, value] of Object.entries(node)) {
      if (key === "nullable" || OPENAPI_SCHEMA_ANNOTATION_KEYS.has(key)) {
        assemble.changed = true;
        assemble.plan.push({ kind: "drop", key });
        continue;
      }
      if (SCHEMA_LITERAL_KEYS.has(key) || key === "components") {
        assemble.plan.push({ kind: "literal" });
        continue;
      }
      if (SCHEMA_MAP_KEYS.has(key) && isSchemaRecord(value)) {
        const mapEntry: Extract<
          OpenApiKeywordsAssembleRecordTask["plan"][number],
          { kind: "map" }
        > = {
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
            assign: (childResult) => {
              mapEntry.mapChanged ||= childResult !== childValue;
              mapEntry.entries.push([childKey, childResult]);
            },
          });
        }
        continue;
      }
      if (SCHEMA_OBJECT_KEYS.has(key) && isSchemaRecord(value)) {
        const planEntry: Extract<
          OpenApiKeywordsAssembleRecordTask["plan"][number],
          { kind: "object" }
        > = { kind: "object", key, source: value, value };
        assemble.plan.push(planEntry);
        children.push({
          kind: "visit",
          node: value,
          assign: (childResult) => {
            planEntry.value = childResult;
          },
        });
        continue;
      }
      if (SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(value)) {
        const arrayEntry: Extract<
          OpenApiKeywordsAssembleRecordTask["plan"][number],
          { kind: "array" }
        > = {
          kind: "array",
          key,
          source: value,
          entries: Array.from({ length: value.length }),
          arrayChanged: false,
        };
        assemble.plan.push(arrayEntry);
        value.forEach((entry, index) => {
          children.push({
            kind: "visit",
            node: entry,
            assign: (childResult) => {
              arrayEntry.arrayChanged ||= childResult !== value[index];
              arrayEntry.entries[index] = childResult;
            },
          });
        });
        continue;
      }
      assemble.plan.push({ kind: "other" });
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
