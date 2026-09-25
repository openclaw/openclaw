/** Local $ref inlining so providers receive self-contained tool schemas. */
import { isRecord as isSchemaRecord } from "@openclaw/normalization-core/record-coerce";
import {
  copySchemaMeta,
  createCircularToolSchemaError,
  SCHEMA_ARRAY_KEYS,
  SCHEMA_LITERAL_KEYS,
  SCHEMA_MAP_KEYS,
  SCHEMA_OBJECT_KEYS,
  setOwnSchemaProperty,
} from "./agent-tools-schema-keys.js";

type SchemaDefs = {
  $defs: Map<string, unknown>;
  definitions: Map<string, unknown>;
};

function extendSchemaDefs(
  defs: SchemaDefs | undefined,
  schema: Record<string, unknown>,
): SchemaDefs | undefined {
  const defsEntry = isSchemaRecord(schema.$defs) ? schema.$defs : undefined;
  const legacyDefsEntry = isSchemaRecord(schema.definitions) ? schema.definitions : undefined;

  if (!defsEntry && !legacyDefsEntry) {
    return defs;
  }

  const next: SchemaDefs = defs
    ? {
        $defs: new Map(defs.$defs),
        definitions: new Map(defs.definitions),
      }
    : {
        $defs: new Map<string, unknown>(),
        definitions: new Map<string, unknown>(),
      };
  if (defsEntry) {
    for (const [key, value] of Object.entries(defsEntry)) {
      next.$defs.set(key, value);
    }
  }
  if (legacyDefsEntry) {
    for (const [key, value] of Object.entries(legacyDefsEntry)) {
      next.definitions.set(key, value);
    }
  }
  return next;
}

function decodeJsonPointerSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function resolveJsonPointerPath(value: unknown, segments: string[]): unknown {
  let current = value;
  for (const segment of segments) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    const key = decodeJsonPointerSegment(segment);
    if (Array.isArray(current)) {
      const index = /^(?:0|[1-9]\d*)$/.test(key) ? Number(key) : -1;
      if (index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    if (!isSchemaRecord(current)) {
      return undefined;
    }
    if (!Object.hasOwn(current, key)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function resolveLocalJsonPointer(rootDocument: unknown, ref: string): unknown {
  if (!ref.startsWith("#/")) {
    return undefined;
  }
  return resolveJsonPointerPath(rootDocument, ref.slice(2).split("/"));
}

function tryResolveLocalRef(
  ref: string,
  defs: SchemaDefs | undefined,
  rootDocument: unknown,
): unknown {
  const match = ref.match(/^#\/(\$defs|definitions)\/([^/]+)(?:\/(.*))?$/);
  if (match && defs) {
    const namespace = match[1] === "$defs" ? defs.$defs : defs.definitions;
    const name = decodeJsonPointerSegment(match[2] ?? "");
    const resolved = name ? namespace.get(name) : undefined;
    if (resolved !== undefined) {
      const remainingPath = match[3] ? match[3].split("/") : [];
      return resolveJsonPointerPath(resolved, remainingPath);
    }
  }
  return resolveLocalJsonPointer(rootDocument, ref);
}

// $ref expansion deepens a flat document through resolution instead of syntax, so a pre-walk
// document check cannot bound it — and external schemas nest far deeper than the call stack.
// This walker therefore runs an explicit task stack (#141306). A visit task either resolves a
// leaf immediately or pushes one assemble task plus a visit task per child; the assemble task
// only runs after every child has written its result back, mirroring the original recursion
// and preserving its pre-order state.unresolvedLocalRefs semantics.
type InlineVisitTask = {
  kind: "visit";
  node: unknown;
  defs: SchemaDefs | undefined;
  refStack: Set<string> | undefined;
  // Nodes on the current raw-descent path. A $ref expansion starts a fresh segment: cycles
  // spanning $ref edges repeat a ref string and are already bounded by refStack, while cycles
  // inside one segment are bounded here the way the call stack bounded them before.
  ancestors: Set<object>;
  assign: (value: unknown) => void;
};

type InlineAssembleArrayTask = {
  kind: "assemble-array";
  node: object;
  ancestors: Set<object>;
  assign: (value: unknown) => void;
  entries: unknown[];
};

type InlineAssembleRefTask = {
  kind: "assemble-ref";
  node: object;
  ancestors: Set<object>;
  assign: (value: unknown) => void;
  obj: Record<string, unknown>;
  resolved: unknown;
};

type InlineAssembleRecordTask = {
  kind: "assemble-record";
  node: object;
  ancestors: Set<object>;
  assign: (value: unknown) => void;
  obj: Record<string, unknown>;
  // Plan entries in source order; child results write back through the entry.
  plan: Array<
    | { kind: "skip" }
    | { kind: "literal"; key: string; value: unknown }
    | {
        kind: "map";
        key: string;
        entries: Array<[string, unknown]>;
      }
    | { kind: "object"; key: string; value: unknown }
    | { kind: "array"; key: string; entries: unknown[] }
    | { kind: "other"; key: string; value: unknown }
  >;
};

type InlineTask =
  | InlineVisitTask
  | InlineAssembleArrayTask
  | InlineAssembleRefTask
  | InlineAssembleRecordTask;

function inlineLocalSchemaRefsWithDefs(
  schema: unknown,
  defs: SchemaDefs | undefined,
  refStack: Set<string> | undefined,
  state: { unresolvedLocalRefs: boolean },
  rootDocument: unknown,
): unknown {
  let rootResult: unknown = schema;
  const rootAncestors = new Set<object>();
  const tasks: InlineTask[] = [
    {
      kind: "visit",
      node: schema,
      defs,
      refStack,
      ancestors: rootAncestors,
      assign: (value) => {
        rootResult = value;
      },
    },
  ];
  let task: InlineTask | undefined;
  while ((task = tasks.pop()) !== undefined) {
    if (task.kind === "assemble-array") {
      task.ancestors.delete(task.node);
      task.assign(task.entries);
      continue;
    }
    if (task.kind === "assemble-ref") {
      task.ancestors.delete(task.node);
      const inlined = task.resolved;
      if (!isSchemaRecord(inlined)) {
        task.assign(inlined);
        continue;
      }
      const result: Record<string, unknown> = { ...inlined };
      copySchemaMeta(task.obj, result);
      if (task.obj.nullable === true) {
        result.nullable = true;
      }
      task.assign(result);
      continue;
    }
    if (task.kind === "assemble-record") {
      task.ancestors.delete(task.node);
      const { obj, plan } = task;
      const result: Record<string, unknown> = {};
      for (const entry of plan) {
        if (entry.kind === "skip") {
          continue;
        }
        if (entry.kind === "map") {
          setOwnSchemaProperty(result, entry.key, Object.fromEntries(entry.entries));
          continue;
        }
        if (entry.kind === "array") {
          setOwnSchemaProperty(result, entry.key, entry.entries);
          continue;
        }
        setOwnSchemaProperty(result, entry.key, entry.value);
      }
      if (state.unresolvedLocalRefs) {
        if ("$defs" in obj) {
          result.$defs = obj.$defs;
        }
        if ("definitions" in obj) {
          result.definitions = obj.definitions;
        }
        if ("components" in obj) {
          result.components = obj.components;
        }
      }
      task.assign(result);
      continue;
    }

    // visit
    const { node, defs: taskDefs, refStack: taskRefStack, ancestors, assign } = task;
    if (!isSchemaRecord(node) && !Array.isArray(node)) {
      assign(node);
      continue;
    }
    if (ancestors.has(node)) {
      throw createCircularToolSchemaError();
    }
    ancestors.add(node);
    if (Array.isArray(node)) {
      const entries: unknown[] = Array.from({ length: node.length });
      tasks.push({ kind: "assemble-array", node, ancestors, assign, entries });
      for (let index = node.length - 1; index >= 0; index -= 1) {
        const slot = index;
        tasks.push({
          kind: "visit",
          node: node[slot],
          defs: taskDefs,
          refStack: taskRefStack,
          ancestors,
          assign: (value) => {
            entries[slot] = value;
          },
        });
      }
      continue;
    }

    const obj = node;
    const nextDefs = extendSchemaDefs(taskDefs, obj);
    const refValue = typeof obj.$ref === "string" ? obj.$ref : undefined;

    if (refValue) {
      if (taskRefStack?.has(refValue)) {
        ancestors.delete(node);
        assign({});
        continue;
      }
      const resolved = tryResolveLocalRef(refValue, nextDefs, rootDocument);
      if (resolved === undefined) {
        ancestors.delete(node);
        if (refValue.startsWith("#/")) {
          state.unresolvedLocalRefs = true;
        }
        assign({ ...obj });
        continue;
      }
      const nextRefStack = taskRefStack ? new Set(taskRefStack) : new Set<string>();
      nextRefStack.add(refValue);
      const refTask: InlineAssembleRefTask = {
        kind: "assemble-ref",
        node,
        ancestors,
        assign,
        obj,
        resolved: undefined,
      };
      tasks.push(refTask);
      tasks.push({
        kind: "visit",
        node: resolved,
        defs: nextDefs,
        refStack: nextRefStack,
        ancestors: new Set<object>(),
        assign: (value) => {
          refTask.resolved = value;
        },
      });
      continue;
    }

    const assemble: InlineAssembleRecordTask = {
      kind: "assemble-record",
      node,
      ancestors,
      assign,
      obj,
      plan: [],
    };
    const children: InlineVisitTask[] = [];
    for (const [key, value] of Object.entries(obj)) {
      if (key === "$defs" || key === "definitions" || key === "components") {
        assemble.plan.push({ kind: "skip" });
        continue;
      }
      if (SCHEMA_LITERAL_KEYS.has(key)) {
        assemble.plan.push({ kind: "literal", key, value });
        continue;
      }
      if (SCHEMA_MAP_KEYS.has(key) && isSchemaRecord(value)) {
        const mapEntry: Extract<InlineAssembleRecordTask["plan"][number], { kind: "map" }> = {
          kind: "map",
          key,
          entries: [],
        };
        assemble.plan.push(mapEntry);
        for (const [childKey, childValue] of Object.entries(value)) {
          children.push({
            kind: "visit",
            node: childValue,
            defs: nextDefs,
            refStack: taskRefStack,
            ancestors,
            assign: (childResult) => {
              mapEntry.entries.push([childKey, childResult]);
            },
          });
        }
        continue;
      }
      if (SCHEMA_OBJECT_KEYS.has(key) && isSchemaRecord(value)) {
        const planEntry: Extract<InlineAssembleRecordTask["plan"][number], { kind: "object" }> = {
          kind: "object",
          key,
          value: undefined,
        };
        assemble.plan.push(planEntry);
        children.push({
          kind: "visit",
          node: value,
          defs: nextDefs,
          refStack: taskRefStack,
          ancestors,
          assign: (childResult) => {
            planEntry.value = childResult;
          },
        });
        continue;
      }
      if (SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(value)) {
        const arrayEntry: Extract<InlineAssembleRecordTask["plan"][number], { kind: "array" }> = {
          kind: "array",
          key,
          entries: Array.from({ length: value.length }),
        };
        assemble.plan.push(arrayEntry);
        value.forEach((entry, index) => {
          children.push({
            kind: "visit",
            node: entry,
            defs: nextDefs,
            refStack: taskRefStack,
            ancestors,
            assign: (childResult) => {
              arrayEntry.entries[index] = childResult;
            },
          });
        });
        continue;
      }
      assemble.plan.push({ kind: "other", key, value });
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

/** Inline local $ref pointers so providers receive self-contained tool schemas. */
export function inlineLocalToolSchemaRefs(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  // The record view only reads $defs; a top-level array schema reads them as the
  // missing-key undefined, exactly as the original recursion did.
  // SAFETY: the guard above narrows to non-null objects, which are record-compatible.
  const schemaRecord = schema as Record<string, unknown>;
  return inlineLocalSchemaRefsWithDefs(
    schema,
    Array.isArray(schema) ? extendSchemaDefs(undefined, schemaRecord) : undefined,
    undefined,
    {
      unresolvedLocalRefs: false,
    },
    schema,
  );
}
