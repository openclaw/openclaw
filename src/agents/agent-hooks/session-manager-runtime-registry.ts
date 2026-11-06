/** Creates a WeakMap-backed runtime registry keyed by SessionManager object identity. */
export function createSessionManagerRuntimeRegistry<TValue>() {
  const registry = new WeakMap<object, TValue>();

  return {
    set: (sessionManager: unknown, value: TValue | null): void => {
      if (!sessionManager || typeof sessionManager !== "object") {
        return;
      }
      if (value === null) {
        registry.delete(sessionManager);
      } else {
        registry.set(sessionManager, value);
      }
    },
    get: (sessionManager: unknown): TValue | null => {
      return sessionManager && typeof sessionManager === "object"
        ? (registry.get(sessionManager) ?? null)
        : null;
    },
  };
}
