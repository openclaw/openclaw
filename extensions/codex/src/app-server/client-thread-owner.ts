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

export type RetainedLiveThread = {
  ownerToken?: ThreadOwnerToken;
  configFingerprint?: string;
  ephemeralPolicy?: string;
  serviceTier?: CodexServiceTier | null;
  expiresAt: number;
  release: (threadId: string, assertCurrent?: () => void) => Promise<void>;
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
