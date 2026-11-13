import { isProxy } from "node:util/types";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getAiTransportHost } from "../host.js";

// Pure JSON projections depend only on the immutable source, not the request's route or session.
const frozenJsonProjections = new WeakMap<object, unknown>();

// Keep text by reference instead of encoding/parsing it solely for comparison.
// Hook-provided opaque values still use native JSON, including the property's key.
export function projectJsonValue(
  value: unknown,
  key: string,
  ancestors: Map<object, boolean>,
): unknown {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value + 0 : null;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (value === undefined || typeof value === "symbol") {
    return undefined;
  }
  if (
    typeof value !== "object" ||
    isProxy(value) ||
    Object.getPrototypeOf(value) !== (Array.isArray(value) ? Array.prototype : Object.prototype) ||
    "toJSON" in value ||
    ancestors.has(value)
  ) {
    // Native JSON can invoke a dynamic serializer even for a frozen graph (for example BigInt).
    for (const ancestor of ancestors.keys()) {
      ancestors.set(ancestor, false);
    }
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- Preserve JSON/toJSON semantics, not object identity.
    const projected: Record<string, unknown> = JSON.parse(
      JSON.stringify({ __proto__: null, [key]: value }),
    );
    return Object.hasOwn(projected, key) ? projected[key] : undefined;
  }
  const cached = frozenJsonProjections.get(value);
  if (cached !== undefined) {
    return cached;
  }
  const immutable =
    Object.isFrozen(value) && getAiTransportHost().immutableData?.isDeeplyFrozenPlainData(value);
  ancestors.set(value, true);
  try {
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      const length = value.length;
      for (let index = 0; index < length; index++) {
        result.push(projectJsonValue(value[index], String(index), ancestors) ?? null);
      }
      if (immutable && ancestors.get(value)) {
        frozenJsonProjections.set(value, result);
      }
      return result;
    }
    const result: Record<string, unknown> = {};
    for (const name of Object.keys(value)) {
      const member = projectJsonValue(Reflect.get(value, name), name, ancestors);
      if (member !== undefined) {
        if (name in result) {
          // Match JSON's own data properties, including __proto__ and inherited setters.
          Object.defineProperty(result, name, {
            value: member,
            enumerable: true,
            configurable: true,
            writable: true,
          });
        } else {
          result[name] = member;
        }
      }
    }
    if (immutable && ancestors.get(value)) {
      frozenJsonProjections.set(value, result);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

export function projectJsonObject(value: object): unknown {
  const projected = projectJsonValue(value, "", new Map());
  // A root toJSON returning undefined was not valid JSON either.
  return projected === undefined ? JSON.parse("undefined") : projected;
}

// Projection already owns JSON semantics and rejects cycles. Comparing its data
// needs no generic comparator's key arrays, descriptors or cycle bookkeeping.
export function projectedJsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    for (let index = 0; index < left.length; index++) {
      if (!projectedJsonEqual(left[index], right[index])) {
        return false;
      }
    }
    return true;
  }
  if (!isRecord(left) || !isRecord(right)) {
    return false;
  }
  let keys = 0;
  for (const key in left) {
    if (Object.hasOwn(left, key)) {
      if (!Object.hasOwn(right, key) || !projectedJsonEqual(left[key], right[key])) {
        return false;
      }
      keys++;
    }
  }
  for (const key in right) {
    if (Object.hasOwn(right, key)) {
      keys--;
    }
  }
  return keys === 0;
}
