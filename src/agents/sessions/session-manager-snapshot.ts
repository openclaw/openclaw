import { isProxy } from "node:util/types";

const nativeCloneRequired = new Error("Opaque session snapshot requires native cloning");

/** Snapshot mutable containers without copying already-owned transcript string bytes. */
export function cloneTranscriptView<T>(snapshot: T): T {
  const copies = new Map<object, object>();
  const copy = (value: unknown): unknown => {
    if (typeof value === "function" || typeof value === "symbol") {
      throw nativeCloneRequired;
    }
    if (value === null || typeof value !== "object") {
      return value;
    }
    if (isProxy(value)) {
      throw nativeCloneRequired;
    }
    if (copies.has(value)) {
      return copies.get(value);
    }
    const prototype = Object.getPrototypeOf(value);
    if (value instanceof Map && prototype === Map.prototype) {
      const result = new Map<unknown, unknown>();
      copies.set(value, result);
      for (const [key, member] of value) {
        result.set(copy(key), copy(member));
      }
      return result;
    }
    if (value instanceof Set && prototype === Set.prototype) {
      const result = new Set<unknown>();
      copies.set(value, result);
      for (const member of value) {
        result.add(copy(member));
      }
      return result;
    }
    if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype) {
      throw nativeCloneRequired;
    }
    const result: object = Array.isArray(value) ? [] : {};
    if (Array.isArray(result) && Array.isArray(value)) {
      result.length = value.length;
    }
    copies.set(value, result);
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!("value" in descriptor)) {
        throw nativeCloneRequired;
      }
      Object.defineProperty(result, key, {
        value: copy(descriptor.value),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  };
  try {
    // SAFETY: Copying containers preserves the snapshot's shape and shared references.
    return copy(snapshot) as T;
  } catch (error) {
    if (error !== nativeCloneRequired) {
      throw error;
    }
    // fromEntries accepts opaque structured-cloneable SDK data. Clone the whole
    // graph so references crossing an opaque value retain their original identity.
    return structuredClone(snapshot);
  }
}
