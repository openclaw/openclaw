/**
 * Shared contract for review-owned preflight overflow errors.
 *
 * The embedded runner produces the terminal error text and the skill workshop
 * review outcome parser reconstructs the measured numbers from it, so
 * formatting and parsing must live in one module and cannot drift apart.
 */

const OVERSIZED_REVIEW_PROMPT_RE =
  /^Skill experience review prompt exceeds effective budget: estimatedPromptTokens=(\d+) promptBudgetBeforeReserve=(\d+)$/;

export type ReviewPreflightOverflow = {
  estimatedPromptTokens: number;
  promptBudgetBeforeReserve: number;
};

export function formatReviewPreflightOverflowMessage(overflow: ReviewPreflightOverflow): string {
  return (
    `Skill experience review prompt exceeds effective budget: ` +
    `estimatedPromptTokens=${overflow.estimatedPromptTokens} ` +
    `promptBudgetBeforeReserve=${overflow.promptBudgetBeforeReserve}`
  );
}

export function parseReviewPreflightOverflowMessage(
  message: string,
): ReviewPreflightOverflow | null {
  const match = OVERSIZED_REVIEW_PROMPT_RE.exec(message.trim());
  return match
    ? { estimatedPromptTokens: Number(match[1]), promptBudgetBeforeReserve: Number(match[2]) }
    : null;
}
