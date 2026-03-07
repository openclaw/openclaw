import { redactSensitiveText } from "../logging/redact.js";

function sanitizeString(value: string): string {
  return redactSensitiveText(value, { mode: "tools" });
}

export function sanitizePayloadForLogging<T>(value: T): T {
  if (typeof value === "string") {
    return sanitizeString(value) as T;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return sanitizePayloadWithMemo(value, new WeakMap<object, unknown>()) as T;
}

function sanitizePayloadWithMemo(value: unknown, memo: WeakMap<object, unknown>): unknown {
  if (typeof value === "string") {
    return sanitizeString(value);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const memoized = memo.get(value as object);
  if (memoized !== undefined) {
    return memoized;
  }
  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    memo.set(value, clone);
    for (const item of value) {
      clone.push(sanitizePayloadWithMemo(item, memo));
    }
    return clone;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return value;
  }
  const clone: Record<string, unknown> = {};
  memo.set(value as object, clone);
  for (const [key, entryValue] of Object.entries(value)) {
    clone[key] = sanitizePayloadWithMemo(entryValue, memo);
  }
  return clone;
}
