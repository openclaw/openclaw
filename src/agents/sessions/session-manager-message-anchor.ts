import type { TranscriptEntryAnchor } from "../../config/sessions/transcript-entry-anchor.js";
import type { SessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import { captureOwnedTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";

/** @internal The last message append's immutable postimage, never current authority. */
export const sessionManagerReadMessageAnchor: unique symbol = Symbol.for(
  "openclaw.session-manager.read-message-anchor",
);

/** @internal Completed-turn consumers validate this historical selector at their own boundary. */
export const completedTurnMessageAnchor: unique symbol = Symbol.for(
  "openclaw.completed-turn.message-anchor",
);

export type CompletedTurnMessageAnchor = Readonly<{
  anchor: TranscriptEntryAnchor;
  assertCurrent: () => void;
}>;

/** Preserve the producer's original locator and owner instead of rebinding the normalized anchor. */
export function captureCompletedTurnMessageAnchor(
  manager: {
    getSessionTarget(): SessionTranscriptTargetBinding | undefined;
    [sessionManagerReadMessageAnchor](
      entryId: string | null | undefined,
    ): TranscriptEntryAnchor | undefined;
  },
  entryId: string | null | undefined,
): CompletedTurnMessageAnchor | undefined {
  const anchor = manager[sessionManagerReadMessageAnchor](entryId);
  const target = manager.getSessionTarget();
  return anchor && target
    ? Object.freeze({ anchor, assertCurrent: captureOwnedTranscriptWriteAssertion(target) })
    : undefined;
}
