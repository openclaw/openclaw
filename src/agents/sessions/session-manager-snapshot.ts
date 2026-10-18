import { isProxy } from "node:util/types";
import { isOwnedTranscriptPayload } from "../../config/sessions/transcript-json.js";
import { isDeeplyFrozenPlainData } from "../../shared/immutable-data.js";

const nativeCloneRequired = new Error("Opaque session snapshot requires native cloning");

/** Detach mutable containers while sharing sealed transcript payloads. */
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
    // Public mutable SDK views can also alias frozen descendants outside admitted roots.
    if (isOwnedTranscriptPayload(value) || isDeeplyFrozenPlainData(value)) {
      return value;
    }
    if (copies.has(value)) {
      return copies.get(value);
    }
    const prototype = Object.getPrototypeOf(value);
    if (value instanceof Map && prototype === Map.prototype) {
      const result = new Map<unknown, unknown>();
      copies.set(value, result);
      value.forEach((member, key) => result.set(copy(key), copy(member)));
      return result;
    }
    if (value instanceof Set && prototype === Set.prototype) {
      const result = new Set<unknown>();
      copies.set(value, result);
      value.forEach((member) => result.add(copy(member)));
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
