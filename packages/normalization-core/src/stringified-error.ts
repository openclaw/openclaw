/** Preserves Error values and stringifies every other value into a new Error. */
export function toStringifiedError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
