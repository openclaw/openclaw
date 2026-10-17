// Model-declared outcome for automatic replies to X mentions. Public posting is the
// risky effect, so only an explicit success is posted; failures and untagged
// replies are withheld. Kept dependency-free: the channel entry imports it eagerly.
const OUTCOME_TAG = /\[\[\s*x_(success|failure)\s*\]\]/giu;

export const xReplyOutcomeGuidance =
  "Start every reply to an X mention with an outcome tag. Use [[x_success]] only when you completed the request: you answered it, or the requested work session or action actually started. Use [[x_failure]] when anything failed or blocked you, including tool or session errors, missing access, or asking the author to retry or resend. Only [[x_success]] replies are posted to X, without the tag; failure and untagged replies are withheld from X.";

export type XReplyOutcome = "success" | "failure" | "unclassified";

/** Reads and removes outcome tags; any failure tag wins over a success tag. */
export function readXReplyOutcome(text: string): { outcome: XReplyOutcome; text: string } {
  let outcome: XReplyOutcome = "unclassified";
  const stripped = text.replace(OUTCOME_TAG, (_match, kind: string) => {
    outcome = outcome === "failure" || kind.toLowerCase() === "failure" ? "failure" : "success";
    return "";
  });
  return { outcome, text: stripped.trim() };
}
