import { buildSpawnAuthorityReceipt } from "../../../config/sessions/session-entry-lineage.js";
import type { SessionEntry } from "../../../config/sessions/types.js";

type ParentIncarnation = Pick<SessionEntry, "sessionId" | "lifecycleRevision">;

const PARENT_CHANGED_ERROR = "Parent session changed before spawn; retry from the current turn.";

/** One spawn's captured parent: the child's authority receipt and its pre-commit recheck. */
export type SpawnParentLineage = {
  receipt: ReturnType<typeof buildSpawnAuthorityReceipt>;
  /** Re-reads the parent; call it after every awaited preparation step, right before commit. */
  assertParentUnchanged: () => Promise<void>;
};

/**
 * Captures the parent incarnation a spawned child records in its lineage receipt.
 * A stored parent must still be the spawning turn's incarnation, and it is re-read
 * through the caller's session read worker immediately before the child commits.
 * A stale receipt can only deny memory access later; the recheck rejects it early.
 * A rowless parent records no incarnation and grants nothing, so it spawns as before.
 */
export function captureSpawnParentLineage(params: {
  parentEntry: ParentIncarnation | undefined;
  expectedParentSessionId?: string;
  senderIsOwner?: boolean;
  readParentEntry: () => Promise<ParentIncarnation | undefined>;
}): SpawnParentLineage {
  const { parentEntry } = params;
  if (
    parentEntry &&
    params.expectedParentSessionId !== undefined &&
    parentEntry.sessionId !== params.expectedParentSessionId
  ) {
    throw new Error(PARENT_CHANGED_ERROR);
  }
  return {
    receipt: buildSpawnAuthorityReceipt(parentEntry, params.senderIsOwner),
    assertParentUnchanged: async () => {
      if (!parentEntry) {
        return;
      }
      const latest = await params.readParentEntry();
      if (
        latest?.sessionId !== parentEntry.sessionId ||
        latest.lifecycleRevision !== parentEntry.lifecycleRevision
      ) {
        throw new Error(PARENT_CHANGED_ERROR);
      }
    },
  };
}
