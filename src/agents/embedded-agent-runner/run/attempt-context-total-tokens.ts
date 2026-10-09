import { persistSessionContextTotalTokens } from "../../../auto-reply/reply/session-usage.js";
import { isIncognitoSessionKey } from "../../../routing/session-key.js";
import { shouldPreserveUserFacingSessionStateForInputProvenance } from "../../../sessions/input-provenance.js";
import { deriveSessionTotalTokens, type NormalizedUsage } from "../../usage.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type ContextTotalTokensWriter = {
  /** Offers a settled model call's usage. Never awaits; safe on the event hot path. */
  offer: (usage: NormalizedUsage | undefined) => void;
  /** Stops accepting offers and waits until the latest accepted offer is written. */
  close: () => Promise<void>;
  /** Stops accepting offers, drops any pending one, and waits for the write in flight. */
  abandon: () => Promise<void>;
};

const DISABLED: ContextTotalTokensWriter = {
  offer: () => {},
  close: async () => {},
  abandon: async () => {},
};

/**
 * Publishes the session's context total after each settled model call of an
 * attempt, before turn-completion accounting lands. One write is in flight at a
 * time and the latest offer wins, so a fast tool loop never queues store writes.
 * Every write is fenced on the session, writer claim and lifecycle revision the
 * run was admitted under, and turn-completion and compaction accounting land
 * only after every attempt has closed its writer.
 */
export function createContextTotalTokensWriter(
  attempt: Pick<
    EmbeddedRunAttemptParams,
    "runId" | "sessionId" | "sessionTarget" | "sessionPersistence" | "inputProvenance"
  >,
): ContextTotalTokensWriter {
  const target = attempt.sessionTarget;
  if (
    attempt.sessionPersistence === "detached" ||
    !target?.storePath ||
    !target.sessionKey ||
    // Incognito stores have no worker path; keep their writes at turn completion.
    isIncognitoSessionKey(target.sessionKey) ||
    // Turn-completion accounting leaves these runs' context total untouched too.
    shouldPreserveUserFacingSessionStateForInputProvenance(attempt.inputProvenance)
  ) {
    return DISABLED;
  }
  const scope = {
    agentId: target.agentId,
    storePath: target.storePath,
    sessionKey: target.sessionKey,
    expectedSession: {
      sessionId: attempt.sessionId,
      lifecycleRevision: target.expectedLifecycleRevision,
      // A run that created its row is admitted before the row exists, so it has
      // no claim fact yet; the row it creates carries this run as its writer.
      activeWriterRunId: target.expectedWriterRunId ?? attempt.runId,
    },
  };
  let closed = false;
  let next: number | undefined;
  let inFlight: Promise<void> | undefined;

  const pump = () => {
    if (inFlight || next === undefined) {
      return;
    }
    const totalTokens = next;
    next = undefined;
    // The primitive logs and absorbs its own write failures.
    inFlight = persistSessionContextTotalTokens({ ...scope, totalTokens }).finally(() => {
      inFlight = undefined;
      pump();
    });
  };

  const drain = async (): Promise<void> => {
    // Each settled write re-pumps the latest pending offer before it resolves,
    // so wait again until no write is left in flight.
    const current = inFlight;
    if (current) {
      await current;
      await drain();
    }
  };

  return {
    offer: (usage) => {
      if (closed) {
        return;
      }
      // Prompt tokens only, as turn-completion accounting derives a call's total;
      // an explicitly unavailable context snapshot stays unknown.
      const totalTokens = deriveSessionTotalTokens({ lastCallUsage: usage });
      if (totalTokens === undefined) {
        return;
      }
      next = totalTokens;
      pump();
    },
    close: async () => {
      closed = true;
      await drain();
    },
    abandon: async () => {
      closed = true;
      next = undefined;
      await drain();
    },
  };
}
