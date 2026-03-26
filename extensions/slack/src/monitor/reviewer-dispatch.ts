/**
 * Reviewer dispatch — allows the steerer hook to inject reviewer feedback
 * directly into the Slack message handler pipeline, bypassing Slack's event
 * system (which does not fire events for a bot's own messages).
 *
 * The hook handler calls `dispatchReviewerFeedback()` after GPT-5.4 decides
 * "continue". This constructs a synthetic Slack message and runs it through
 * prepareSlackMessage → dispatchPreparedSlackMessage, so the agent picks it
 * up as a normal inbound message.
 */

export type ReviewerDispatchFn = (params: {
  channelId: string;
  threadTs: string;
  text: string;
}) => Promise<boolean>;

const REVIEWER_DISPATCH_KEY = Symbol.for("openclaw.reviewerDispatch");

/**
 * Call from the steerer hook handler to inject reviewer feedback into the
 * agent processing pipeline without going through Slack.
 *
 * Returns true if dispatch was successful, false otherwise.
 */
export function dispatchReviewerFeedback(params: {
  channelId: string;
  threadTs: string;
  text: string;
}): Promise<boolean> {
  const fn = (globalThis as Record<symbol, ReviewerDispatchFn | undefined>)[REVIEWER_DISPATCH_KEY];
  if (!fn) {
    console.error(
      "[reviewer-dispatch] no dispatch function registered — is the Slack provider running?",
    );
    return Promise.resolve(false);
  }
  return fn(params);
}

/**
 * Called from the Slack provider during startup to register the dispatch
 * function. The function captures the provider's ctx and account references
 * so synthetic messages go through the same pipeline as real Slack events.
 */
export function registerReviewerDispatch(fn: ReviewerDispatchFn): void {
  (globalThis as Record<symbol, ReviewerDispatchFn>)[REVIEWER_DISPATCH_KEY] = fn;
}
