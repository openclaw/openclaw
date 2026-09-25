import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexServiceTier } from "./protocol.js";

export type ThreadOwnerToken = {
  invalidated: boolean;
  invalidate: () => void;
};

export type ThreadReleaseTransition = {
  completion: Promise<void>;
  physicalRelease?: Promise<void>;
  retainedOwnerToken?: ThreadOwnerToken;
  invalidated?: boolean;
};

/**
 * Exact lifecycle inputs a live ephemeral thread was told. The generic policy is
 * creation-owned and cannot be refreshed or cold-resumed; the skill catalog is the
 * one refreshable section and records the catalog last delivered to the thread.
 */
export type CodexEphemeralThreadPolicy = {
  developerInstructions?: string;
  skillsInstructions?: string;
  /**
   * Catalog carried by the thread's creation-time native developer instructions.
   * Compaction rebuilds initial context from those instructions and drops the
   * client-authored refresh, so this is the catalog a compacted thread reverts to.
   */
  nativeSkillsInstructions?: string;
};

export type RetainedLiveThread = {
  ownerToken?: ThreadOwnerToken;
  configFingerprint?: string;
  ephemeralPolicy?: CodexEphemeralThreadPolicy;
  serviceTier?: CodexServiceTier | null;
  expiresAt: number;
  release: (
    threadId: string,
    assertCurrent?: () => void,
    withCurrent?: (write: () => void) => Promise<void>,
  ) => Promise<void>;
};

export type CodexAppServerLiveThreadOwnership = {
  assertCurrent: () => void;
  configFingerprint?: string;
  ephemeralPolicy?: CodexEphemeralThreadPolicy;
  serviceTier?: CodexServiceTier | null;
  /** Releases this active claim or the exact idle record it published. */
  release: (
    threadId: string,
    assertCurrent?: () => void,
    withCurrent?: (write: () => void) => Promise<void>,
  ) => Promise<void>;
  /** Forgets this local owner after native shutdown, without unsubscribing a successor. */
  forget: () => void;
};

export type ThreadOwnershipState = {
  closed: boolean;
  retainedThreads: Map<string, RetainedLiveThread>;
  claimedThreads: Map<string, ThreadOwnerToken>;
  releasingThreads: Map<string, ThreadReleaseTransition>;
  protectedThreads: Map<string, number>;
};

export function createThreadOwnerToken(
  threadId: string,
  onInvalidated?: () => void,
): ThreadOwnerToken {
  const owner: ThreadOwnerToken = {
    invalidated: false,
    invalidate: () => {
      if (owner.invalidated) {
        return;
      }
      owner.invalidated = true;
      try {
        onInvalidated?.();
      } catch (error) {
        embeddedAgentLog.warn("codex thread ownership invalidation failed", {
          threadId,
          reason: formatErrorMessage(error),
        });
      }
    },
  };
  return owner;
}

export function hasThreadOwnership(
  runtime: ThreadOwnershipState | undefined,
  threadId: string,
): boolean {
  return (
    runtime !== undefined &&
    !runtime.closed &&
    (runtime.retainedThreads.get(threadId) !== undefined ||
      runtime.releasingThreads.get(threadId) !== undefined ||
      runtime.claimedThreads.get(threadId) !== undefined)
  );
}

export function hasSiblingThreadWork(
  runtime: ThreadOwnershipState | undefined,
  threadId: string,
): boolean {
  if (!runtime || runtime.closed) {
    return false;
  }
  // A protected parent can be settled while its native children still write.
  if (runtime.protectedThreads.size > 0) {
    return true;
  }
  // Ephemeral history exists only on this process, even after its turn settles.
  for (const [retainedThreadId, retained] of runtime.retainedThreads) {
    if (retainedThreadId !== threadId && retained.ephemeralPolicy !== undefined) {
      return true;
    }
  }
  for (const claimedThreadId of runtime.claimedThreads.keys()) {
    if (claimedThreadId !== threadId) {
      return true;
    }
  }
  return false;
}

export function invalidateThreadOwnership(runtime: ThreadOwnershipState, threadId: string): void {
  const retainedOwner = runtime.retainedThreads.get(threadId)?.ownerToken;
  const claimedOwner = runtime.claimedThreads.get(threadId);
  const releasing = runtime.releasingThreads.get(threadId);
  if (releasing) {
    releasing.invalidated = true;
  }
  runtime.retainedThreads.delete(threadId);
  runtime.claimedThreads.delete(threadId);
  retainedOwner?.invalidate();
  claimedOwner?.invalidate();
  releasing?.retainedOwnerToken?.invalidate();
}

export function forgetThreadOwnership(
  runtime: ThreadOwnershipState,
  threadId: string,
  owner: ThreadOwnerToken,
): boolean {
  let forgotten = false;
  if (runtime.claimedThreads.get(threadId) === owner) {
    runtime.claimedThreads.delete(threadId);
    forgotten = true;
  }
  if (runtime.retainedThreads.get(threadId)?.ownerToken === owner) {
    runtime.retainedThreads.delete(threadId);
    forgotten = true;
  }
  const releasing = runtime.releasingThreads.get(threadId);
  if (releasing?.retainedOwnerToken === owner) {
    releasing.invalidated = true;
    forgotten = true;
  }
  if (forgotten) {
    owner.invalidate();
  }
  return forgotten;
}

/** Compaction discards client-authored catalog refreshes, not creation policy. */
export function revertRetainedThreadSkillsCatalog(
  runtime: ThreadOwnershipState,
  threadId: string,
): void {
  const retained = runtime.retainedThreads.get(threadId);
  if (retained?.ephemeralPolicy) {
    retained.ephemeralPolicy = {
      ...retained.ephemeralPolicy,
      skillsInstructions: retained.ephemeralPolicy.nativeSkillsInstructions,
    };
  }
}

export function createCodexEphemeralThreadPolicy({
  developerInstructions,
  skillsInstructions,
}: Pick<
  CodexEphemeralThreadPolicy,
  "developerInstructions" | "skillsInstructions"
>): CodexEphemeralThreadPolicy {
  return {
    developerInstructions,
    skillsInstructions,
    nativeSkillsInstructions: skillsInstructions,
  };
}
