import { types } from "node:util";
import { readLoggingConfig } from "../logging/config.js";
import {
  captureModelVisibleRedactionPolicy,
  matchesModelVisibleRedactionPolicy,
} from "../logging/redact-internal-state.js";

type PropertySnapshot = { key: PropertyKey; value: unknown; enumerable: boolean | undefined };
type ObjectSnapshot = { object: object; prototype: unknown; properties: PropertySnapshot[] };
type ResultSnapshot = ObjectSnapshot[];
type CachedResult = {
  policy: ReturnType<typeof captureModelVisibleRedactionPolicy>;
  input: ResultSnapshot;
  output: ResultSnapshot;
  result: object;
};

// Keep string references, not serialized copies: validation walks properties, never text.
function captureResultSnapshot(root: object): ResultSnapshot | undefined {
  const snapshot: ResultSnapshot = [];
  const seen = new WeakSet<object>();
  const visit = (value: unknown): boolean => {
    if (typeof value === "function") {
      return false;
    }
    if (!value || typeof value !== "object" || seen.has(value)) {
      return true;
    }
    if (types.isProxy(value)) {
      return false;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (
      prototype !== Object.prototype &&
      prototype !== null &&
      !(Array.isArray(value) && prototype === Array.prototype)
    ) {
      return false;
    }
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        // Sparse arrays can read inherited values through Array.prototype.map.
        if (!Object.hasOwn(value, index)) {
          return false;
        }
      }
    }
    seen.add(value);
    const properties: PropertySnapshot[] = [];
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !visit(descriptor.value)) {
        return false;
      }
      properties.push({ key, value: descriptor.value, enumerable: descriptor.enumerable });
    }
    snapshot.push({ object: value, prototype, properties });
    return true;
  };
  return visit(root) ? snapshot : undefined;
}

function matchesResultSnapshot(snapshot: ResultSnapshot): boolean {
  return snapshot.every(({ object, prototype, properties }) => {
    const keys = Reflect.ownKeys(object);
    return (
      Object.getPrototypeOf(object) === prototype &&
      keys.length === properties.length &&
      properties.every(({ key, value, enumerable }, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        return (
          keys[index] === key &&
          descriptor !== undefined &&
          "value" in descriptor &&
          Object.is(descriptor.value, value) &&
          descriptor.enumerable === enumerable
        );
      })
    );
  });
}

/** The event owner shares mutable-safe facts only until its consumers settle. */
export function createToolResultPreparation(result: object, sanitize: () => object): () => object {
  let cached: CachedResult | undefined;
  return () => {
    const loggingConfig = readLoggingConfig();
    if (
      cached &&
      matchesModelVisibleRedactionPolicy(cached.policy, loggingConfig) &&
      matchesResultSnapshot(cached.input) &&
      matchesResultSnapshot(cached.output)
    ) {
      return cached.result;
    }
    cached = undefined;
    const input = captureResultSnapshot(result);
    const policy = captureModelVisibleRedactionPolicy(loggingConfig);
    const sanitized = sanitize();
    const output = input && captureResultSnapshot(sanitized);
    if (input && output) {
      cached = { policy, input, output, result: sanitized };
    }
    return sanitized;
  };
}
