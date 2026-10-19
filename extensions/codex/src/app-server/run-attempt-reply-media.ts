import type { EmbeddedRunAttemptResult } from "./attempt-terminal.js";
import type { CodexAttemptActiveTurn } from "./run-attempt-active-turn.js";
import type { CodexAttemptTurnState } from "./run-attempt-turn-state.js";

export async function settleReplyMedia(
  activeTurn: CodexAttemptActiveTurn,
  result: EmbeddedRunAttemptResult,
  { state, settlementExpired }: CodexAttemptTurnState,
  signal: AbortSignal,
): Promise<void> {
  if (activeTurn.prepareReplyMedia && !signal.aborted) {
    state.pendingSettlementStage = "reply/media";
    const transferAbort = new AbortController();
    void settlementExpired.then(() =>
      transferAbort.abort(new Error("Reply media settlement expired")),
    );
    try {
      const prepared = await activeTurn.prepareReplyMedia(
        { kind: "attempt", attempt: result },
        transferAbort.signal,
      );
      if (prepared.kind !== "attempt") {
        throw new Error("Reply media preparation returned the wrong result kind");
      }
      result.preparedReplyMedia = prepared.preparedMedia;
    } catch (error) {
      // Cancellation still returns this attempt's terminal outcome and completed
      // effects. Media preparation must not turn it into a retryable exception.
      if (!signal.aborted) {
        throw error;
      }
    } finally {
      transferAbort.abort();
    }
  }
  if (signal.aborted) {
    await state.abortCleanup;
  }
}
