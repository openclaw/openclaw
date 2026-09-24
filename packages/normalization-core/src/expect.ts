/** Returns the value or throws with the named context; use for genuine invariants only. */
export function expectDefined<T>(value: T | null | undefined, context: string): T {
  if (value === null || value === undefined) {
    throw new Error("expected " + context + " to be defined");
  }
  return value;
}
