/**
 * Serialize an arbitrary value to a string without ever throwing.
 *
 * `JSON.stringify` throws a `TypeError` on values with circular references
 * (common in Node network/socket errors) and on BigInt/Symbol. Error-handling
 * paths must never throw a second exception, so this helper falls back to the
 * value's string representation instead. Values that `JSON.stringify` serializes
 * to `undefined` (e.g. `undefined`, functions) also fall back to `String`.
 *
 * The `String()` fallback is itself guarded: values with a null prototype or
 * a throwing `Symbol.toPrimitive` / `toString` can make `String()` throw, so
 * the deepest fallback is a fixed sentinel string.
 */
export function safeJsonStringify(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? guardedString(value) : serialized;
  } catch {
    return guardedString(value);
  }
}

/**
 * Non-throwing wrapper around `String()`.  Returns the string representation
 * of `value` when possible, or a fixed sentinel when the primitive conversion
 * itself throws (e.g. null-prototype objects or a throwing `Symbol.toPrimitive`).
 */
function guardedString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "<unserializable error>";
  }
}
