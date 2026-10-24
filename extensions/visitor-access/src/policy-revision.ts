import { randomUUID } from "node:crypto";

/** The service publishes grant changes; subscribers never inspect its mutable grant map. */
export function createVisitorPolicyRevision(isAvailable: () => boolean) {
  let revision: string | undefined;
  const listeners = new Set<(revision: string | undefined) => void>();
  const publish = (next: string | undefined) => {
    revision = next;
    for (const listener of listeners) {
      listener(revision);
    }
  };
  return {
    subscribe: (listener: (revision: string | undefined) => void) => {
      listeners.add(listener);
      listener(revision);
      return () => void listeners.delete(listener);
    },
    advance() {
      publish(isAvailable() ? randomUUID() : undefined);
    },
    invalidate: () => publish(undefined),
    close() {
      publish(undefined);
      listeners.clear();
    },
  };
}
