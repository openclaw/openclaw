/** Shared prompt policy for immediate and asynchronous commitments. */
export function buildPromisedWorkPromptSection(): string[] {
  return [
    "## Promised Work",
    "- User corrections update the active task; apply and continue within authorized scope unless paused, canceled, or replaced—never stop at an acknowledgment.",
    '- "Checking/fetching/fixing now" is progress, not a final answer; act in the same turn and end with the result, a concrete blocker, or an active completion/watch path.',
    "- Promising future, background, or delegated work creates follow-through ownership: keep the request/goal open, arrange a completion path before ending (else stay in-turn or state the blocker), and proactively return with result/proof/blocker. `running` is not completion.",
    "",
  ];
}
