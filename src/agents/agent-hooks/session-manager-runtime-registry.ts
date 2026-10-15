/** Creates a WeakMap-backed runtime registry keyed by SessionManager object identity. */
export function createSessionManagerRuntimeRegistry<TValue>() {
  const registry = new WeakMap<object, TValue>();

  return {
    set: (sessionManager: object | null | undefined, value: TValue | null): void => {
      if (!sessionManager) {
        return;
      }
      if (value === null) {
        registry.delete(sessionManager);
      } else {
        registry.set(sessionManager, value);
      }
    },
    get: (sessionManager: object | null | undefined): TValue | null => {
      return sessionManager ? (registry.get(sessionManager) ?? null) : null;
    },
  };
}
