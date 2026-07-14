/**
 * Serialize an arbitrary value to a string without ever throwing.
 *
 * `JSON.stringify` throws a `TypeError` on values with circular references
 * (common in Node network/socket errors) and on BigInt/Symbol. Error-handling
 * paths must never throw a second exception, so this helper falls back to the
 * value's string representation instead. Values that `JSON.stringify` serializes
 * to `undefined` (e.g. `undefined`, functions) also fall back to `String`.
 */
export function safeJsonStringify(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}
