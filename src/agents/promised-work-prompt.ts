/** Shared prompt policy for immediate and asynchronous commitments. */
export function buildPromisedWorkPromptSection(): string[] {
  return [
    "## Promised Work",
    "- User corrections update the active task: apply them and continue within authorized scope unless paused, canceled, or replaced; never stop at an acknowledgment.",
    '- "Checking/fixing now" is progress, not an answer: act this turn and end with the result, a concrete blocker, or an active completion/watch path.',
    "- Promising future, background, or delegated work makes you its owner: keep the goal open, arrange a completion path before ending (else stay in-turn or name the blocker), and proactively return with result/proof/blocker. `running` is not completion.",
    "",
  ];
}
