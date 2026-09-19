export type SchemaWalk = Generator<SchemaWalk, unknown, unknown>;

/** Resume child schema walks on a heap stack, never through recursive yield delegation. */
export function evaluateSchemaWalk(walk: SchemaWalk): unknown {
  const parents: SchemaWalk[] = [];
  let current = walk;
  let value: unknown;
  try {
    while (true) {
      const step = current.next(value);
      if (!step.done) {
        parents.push(current);
        current = step.value;
        value = undefined;
        continue;
      }
      value = step.value;
      const parent = parents.pop();
      if (!parent) {
        return value;
      }
      current = parent;
    }
  } finally {
    // Unwind path-local cycle tracking if a child rejects the schema.
    let parent: SchemaWalk | undefined;
    while ((parent = parents.pop())) {
      parent.return(undefined);
    }
  }
}
