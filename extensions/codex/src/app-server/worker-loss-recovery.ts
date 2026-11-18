import { isDeepStrictEqual } from "node:util";
import type { NativeWorkerPlacement } from "openclaw/plugin-sdk/agent-harness-session-runtime";
import type { CodexAppServerThreadBinding } from "./session-binding.js";

/** Loss lineage never replaces native-owned or unassociated historic contexts. */
export function isCodexWorkerLossPredecessor(
  placement: NativeWorkerPlacement | undefined,
  binding: CodexAppServerThreadBinding | undefined,
): boolean {
  const recovery = placement?.recovery;
  return Boolean(
    recovery &&
    binding?.workerPlacementOwner &&
    !binding.connectionScope &&
    !binding.preserveNativeModel &&
    !binding.pendingSupervisionBranch &&
    isDeepStrictEqual(binding.workerPlacementOwner, recovery.predecessor) &&
    placement.owner.environmentId !== recovery.predecessor.environmentId &&
    placement.owner.agentId === recovery.predecessor.agentId &&
    placement.owner.sessionId === recovery.predecessor.sessionId &&
    placement.owner.sessionKey === recovery.predecessor.sessionKey,
  );
}

/** The same owner facts accompany fresh, cold-resumed, and warm native bindings. */
export function codexWorkerBindingProvenance(
  placement: NativeWorkerPlacement | undefined,
  predecessor?: CodexAppServerThreadBinding,
): Partial<Pick<CodexAppServerThreadBinding, "workerPlacementOwner" | "recoveredFrom">> {
  if (!placement || predecessor?.connectionScope || predecessor?.preserveNativeModel) {
    return {};
  }
  return {
    workerPlacementOwner: placement.owner,
    ...(predecessor && isCodexWorkerLossPredecessor(placement, predecessor)
      ? {
          recoveredFrom: { owner: placement.recovery!.predecessor, threadId: predecessor.threadId },
        }
      : {}),
  };
}
