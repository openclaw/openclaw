import type { getDefaultAiTransportHost } from "./host.js";

/** Runtime transport owner attached to retained provider resources. */
export type SessionResourceOwner = ReturnType<typeof getDefaultAiTransportHost>;

/** Cleanup callback for resources tied to an LLM session or all sessions. */
export type SessionResourceCleanup = (sessionId?: string, owner?: SessionResourceOwner) => void;

// Process-local registry of cleanup hooks owned by LLM providers/transports.
const sessionResourceCleanups = new Set<SessionResourceCleanup>();
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
}

declare const providerStateBrand: unique symbol;

/**
 * Ownership of one conversation's mutable provider state (response continuation, pooled
 * sockets). Only the conversation's writer run obtains one; every other run shares the
 * conversation's affinity (`sessionId`, prompt-cache key) but keeps no state.
 */
export type ProviderStateScope = {
  readonly sessionId: string;
  readonly [providerStateBrand]: true;
};

/** The stream option that carries the writer's scope; absent for every other run. */
export const PROVIDER_STATE_SCOPE: unique symbol = Symbol("providerStateScope");

/** Called only by the writer's lane admission; a lint rule enforces that. */
export function claimConversationProviderState(sessionId: string): ProviderStateScope {
  // SAFETY: the brand is type-only; it keeps a plain session id from standing in for a scope.
  return { sessionId } as ProviderStateScope;
}
