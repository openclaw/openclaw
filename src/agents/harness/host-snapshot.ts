function freezeSnapshot<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const nested of Object.values(value)) {
    freezeSnapshot(nested, seen);
  }
  return Object.freeze(value);
}

/** Host capabilities retain immutable input facts independently of caller mutation. */
export function cloneHostSnapshot<T>(value: T): T {
  return freezeSnapshot(structuredClone(value));
}
