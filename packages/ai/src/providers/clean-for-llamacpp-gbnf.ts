import { isRecord as isSchemaRecord } from "@openclaw/normalization-core/record-coerce";

/** llama.cpp rejects grammar repetitions whose expanded rule count reaches 2000. */
export const LLAMACPP_GBNF_MAX_REPETITION_THRESHOLD = 2000;

const SCHEMA_MAP_KEYS = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);

const SCHEMA_CHILD_KEYS = new Set([
  "additionalItems",
  "additionalProperties",
  "allOf",
  "anyOf",
  "contains",
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

// Tool schemas are external input and can nest far deeper than the call stack, so the walkers
// below run explicit task stacks instead of recursing (#141306). A visit task either resolves a
// leaf immediately or pushes one assemble task plus a visit task per child; the assemble task
// only runs after every child has written its result back, mirroring the original recursion.
type CleanVisitTask = {
  kind: "visit";
  node: unknown;
  assign: (value: unknown) => void;
};

type CleanAssembleArrayTask = {
  kind: "assemble-array";
  node: object;
  assign: (value: unknown) => void;
  entries: unknown[];
  changed: boolean;
};

type CleanAssembleRecordTask = {
  kind: "assemble-record";
  node: object;
  assign: (value: unknown) => void;
  // Plan entries in source order; child results write back through the entry.
  plan: Array<
    | { kind: "drop" }
    | { kind: "keep"; key: string; value: unknown }
    | { kind: "child"; key: string; value: unknown }
    | {
        kind: "map";
        key: string;
        source: Record<string, unknown>;
        // Child results land in source order and rebuild through Object.fromEntries so
        // user-named keys such as `__proto__` become own properties, matching the recursion.
        entries: Array<[string, unknown]>;
        mapChanged: boolean;
      }
  >;
  changed: boolean;
};

type CleanTask = CleanVisitTask | CleanAssembleArrayTask | CleanAssembleRecordTask;

function createCircularToolSchemaError(): TypeError {
  return new TypeError("Tool schema contains a circular reference and cannot be normalized.");
}

function cleanSchemaNode(root: unknown): unknown {
  let rootResult: unknown = root;
  // Recursion previously bounded cyclic object graphs via the call stack; the explicit stack
  // removes that implicit guard, so the walk tracks the nodes on its current path instead.
  const ancestors = new Set<object>();
  const tasks: CleanTask[] = [
    {
      kind: "visit",
      node: root,
      assign: (value) => {
        rootResult = value;
      },
    },
  ];
  let task: CleanTask | undefined;
  while ((task = tasks.pop()) !== undefined) {
    if (task.kind === "assemble-array") {
      ancestors.delete(task.node);
      task.assign(task.changed ? task.entries : task.node);
      continue;
    }
    if (task.kind === "assemble-record") {
      ancestors.delete(task.node);
      const mapChanged = task.plan.some((entry) => entry.kind === "map" && entry.mapChanged);
      if (!task.changed && !mapChanged) {
        task.assign(task.node);
        continue;
      }
      const cleaned: Record<string, unknown> = {};
      for (const entry of task.plan) {
        if (entry.kind === "keep" || entry.kind === "child") {
          cleaned[entry.key] = entry.value;
        } else if (entry.kind === "map") {
          cleaned[entry.key] = entry.mapChanged ? Object.fromEntries(entry.entries) : entry.source;
        }
      }
      task.assign(cleaned);
      continue;
    }
    const { node, assign } = task;
    if (Array.isArray(node)) {
      if (ancestors.has(node)) {
        throw createCircularToolSchemaError();
      }
      ancestors.add(node);
      const assemble: CleanAssembleArrayTask = {
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

    const assemble: CleanAssembleRecordTask = {
      kind: "assemble-record",
      node,
      assign,
      plan: [],
      changed: false,
    };
    const children: CleanVisitTask[] = [];
    for (const [key, value] of Object.entries(node)) {
      if (key === "pattern") {
        assemble.changed = true;
        assemble.plan.push({ kind: "drop" });
        continue;
      }
      if (
        key === "maxLength" &&
        typeof value === "number" &&
        value >= LLAMACPP_GBNF_MAX_REPETITION_THRESHOLD
      ) {
        assemble.changed = true;
        assemble.plan.push({ kind: "drop" });
        continue;
      }

      if (SCHEMA_MAP_KEYS.has(key) && isSchemaRecord(value)) {
        const mapEntry: Extract<CleanAssembleRecordTask["plan"][number], { kind: "map" }> = {
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
      if (SCHEMA_CHILD_KEYS.has(key)) {
        const planEntry: Extract<CleanAssembleRecordTask["plan"][number], { kind: "child" }> = {
          kind: "child",
          key,
          value,
        };
        assemble.plan.push(planEntry);
        children.push({
          kind: "visit",
          node: value,
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

function collectSchemaViolations(root: unknown, path: string, violations: string[]): void {
  // Depth-first in the original recursion's visit order, via an explicit stack (#141306).
  // Leave markers bound cyclic object graphs the way the call stack bounded them before.
  type Pending = { kind: "visit"; node: unknown; path: string } | { kind: "leave"; node: object };
  const ancestors = new Set<object>();
  const pending: Pending[] = [{ kind: "visit", node: root, path }];
  let current: Pending | undefined;
  while ((current = pending.pop()) !== undefined) {
    if (current.kind === "leave") {
      ancestors.delete(current.node);
      continue;
    }
    const { node, path: currentPath } = current;
    if (Array.isArray(node)) {
      if (ancestors.has(node)) {
        throw createCircularToolSchemaError();
      }
      ancestors.add(node);
      pending.push({ kind: "leave", node });
      for (let index = node.length - 1; index >= 0; index -= 1) {
        pending.push({ kind: "visit", node: node[index], path: `${currentPath}[${index}]` });
      }
      continue;
    }
    if (!isSchemaRecord(node)) {
      continue;
    }
    if (ancestors.has(node)) {
      throw createCircularToolSchemaError();
    }
    ancestors.add(node);

    if ("pattern" in node) {
      violations.push(`${currentPath}.pattern`);
    }
    if (
      typeof node.maxLength === "number" &&
      node.maxLength >= LLAMACPP_GBNF_MAX_REPETITION_THRESHOLD
    ) {
      violations.push(`${currentPath}.maxLength`);
    }

    pending.push({ kind: "leave", node });
    const children: Array<{ node: unknown; path: string }> = [];
    for (const [key, value] of Object.entries(node)) {
      if (SCHEMA_MAP_KEYS.has(key) && isSchemaRecord(value)) {
        for (const [childKey, childValue] of Object.entries(value)) {
          children.push({ node: childValue, path: `${currentPath}.${key}.${childKey}` });
        }
      } else if (SCHEMA_CHILD_KEYS.has(key)) {
        children.push({ node: value, path: `${currentPath}.${key}` });
      }
    }
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child) {
        pending.push({ kind: "visit", node: child.node, path: child.path });
      }
    }
  }
}

/** Removes JSON Schema constraints that llama.cpp cannot compile into GBNF. */
export function cleanSchemaForLlamacppGbnf(schema: unknown): unknown {
  return cleanSchemaNode(schema);
}

/** Reports schema paths that llama.cpp cannot compile into GBNF. */
export function findLlamacppGbnfSchemaViolations(schema: unknown, path: string): string[] {
  const violations: string[] = [];
  collectSchemaViolations(schema, path, violations);
  return violations;
}
