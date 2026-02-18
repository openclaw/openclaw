/**
 * A lightweight per-object registry backed by a WeakMap.
 * Keys must be objects; non-object keys (null, numbers, etc.) are silently ignored.
 */
export function createSessionManagerRuntimeRegistry<T>() {
  const map = new WeakMap<object, T | null>();
  return {
    get(key: unknown): T | null {
      if (typeof key !== "object" || key === null) {
        return null;
      }
      return map.has(key) ? (map.get(key) ?? null) : null;
    },
    set(key: unknown, value: T | null): void {
      if (typeof key !== "object" || key === null) {
        return;
      }
      map.set(key, value);
    },
  };
}
