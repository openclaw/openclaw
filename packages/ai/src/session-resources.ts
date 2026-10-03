import type { getDefaultAiTransportHost } from "./host.js";

/** Runtime transport owner attached to retained provider resources. */
export type SessionResourceOwner = ReturnType<typeof getDefaultAiTransportHost>;

/** Cleanup callback for resources tied to an LLM session or all sessions. */
export type SessionResourceCleanup = (sessionId?: string, owner?: SessionResourceOwner) => void;

// Process-local registry of cleanup hooks owned by LLM providers/transports.
const sessionResourceCleanups = new Set<SessionResourceCleanup>();
const sessionResourceCleanupObservers = new Set<SessionResourceCleanup>();
const sessionResourceOwnerIds = new WeakMap<SessionResourceOwner, number>();
let nextSessionResourceOwnerId = 1;

/** Returns a process-local key that keeps retained resources separated by runtime owner. */
export function getSessionResourceOwnerId(owner: SessionResourceOwner): number {
  const existing = sessionResourceOwnerIds.get(owner);
  if (existing !== undefined) {
    return existing;
  }
  const id = nextSessionResourceOwnerId++;
  sessionResourceOwnerIds.set(owner, id);
  return id;
}

/** Registers a session-resource cleanup hook and returns an unregister function. */
export function registerSessionResourceCleanup(cleanup: SessionResourceCleanup): () => void {
  sessionResourceCleanups.add(cleanup);
  return () => {
    sessionResourceCleanups.delete(cleanup);
  };
}

/** Registers metadata cleanup that runs only after every resource cleanup succeeds. */
export function registerSessionResourceCleanupObserver(
  observer: SessionResourceCleanup,
): () => void {
  sessionResourceCleanupObservers.add(observer);
  return () => {
    sessionResourceCleanupObservers.delete(observer);
  };
}

/** Runs all registered cleanup hooks, aggregating failures after every hook has run. */
export function cleanupSessionResources(sessionId?: string, owner?: SessionResourceOwner): void {
  const errors: unknown[] = [];
  for (const cleanup of sessionResourceCleanups) {
    try {
      cleanup(sessionId, owner);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Failed to cleanup session resources");
  }
  for (const observer of sessionResourceCleanupObservers) {
    observer(sessionId, owner);
  }
}
