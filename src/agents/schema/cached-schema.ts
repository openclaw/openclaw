import { Clone } from "typebox/value";
import { pruneMapToMaxSize } from "../../infra/map-size.js";

/** Retain factory-owned schema variants, never the tool's execution or authority. */
export function createCachedToolSchema<Inputs, Schema extends object>(options: {
  key: (inputs: Inputs) => string;
  build: (inputs: Inputs) => Schema;
}): (inputs: Inputs) => Schema {
  const schemas = new Map<string, Schema>();
  return (inputs) => {
    const key = options.key(inputs);
    const cached = schemas.get(key);
    if (cached) {
      return cached;
    }
    // Preserve TypeBox metadata while detaching any plugin-supplied properties.
    const schema = Clone(options.build(inputs));
    const pending: unknown[] = [schema];
    while (pending.length > 0) {
      const value = pending.pop();
      if (value && typeof value === "object" && !Object.isFrozen(value)) {
        pending.push(...Object.values(value));
        Object.freeze(value);
      }
    }
    schemas.set(key, schema);
    pruneMapToMaxSize(schemas, 64);
    return schema;
  };
}
