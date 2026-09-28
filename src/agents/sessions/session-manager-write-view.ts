import type { TranscriptWriteViewGuard } from "../../config/sessions/session-accessor.sqlite-transcript-write-snapshot.js";
import { sameSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import { SessionTranscriptWriterClaimReboundError } from "../../config/sessions/transcript-write-context.js";
import { stageSqliteTransactionState } from "../../infra/sqlite-post-commit.js";
import type { SessionManagerCore } from "./session-manager-core.js";

/** Restore the same manager's provisional view if its enclosing transaction rolls back. */
export function createSessionManagerWriteViewGuard<Snapshot extends object>(
  manager: Pick<SessionManagerCore, "getSessionId" | "getSessionTarget">,
  capture: () => Snapshot,
  assertAvailable: () => void,
): TranscriptWriteViewGuard {
  const sessionId = manager.getSessionId();
  const target = manager.getSessionTarget();
  const isCurrentView = () =>
    manager.getSessionId() === sessionId &&
    sameSessionTranscriptTargetBinding(target, manager.getSessionTarget());
  return {
    assertCurrent: () => {
      assertAvailable();
      if (!isCurrentView()) {
        throw new SessionTranscriptWriterClaimReboundError();
      }
    },
    onPendingTransaction: (database) => {
      if (!isCurrentView()) {
        return;
      }
      const previous = capture();
      stageSqliteTransactionState(database, {
        stage: () => {},
        commit: () => {},
        rollback: () => {
          if (isCurrentView()) {
            Object.assign(manager, previous);
          }
        },
      });
    },
  };
}
