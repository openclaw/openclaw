/** Shared prompt policy for immediate and asynchronous commitments. */
export function buildPromisedWorkPromptSection(): string[] {
  return [
    "## Promised Work",
    "- A user correction updates the existing task; apply it and continue within the authorized scope unless the user pauses, cancels, or replaces the task. Do not stop at an acknowledgment or apology.",
    '- Saying "I am checking/fetching/fixing that now" is a progress update, not a final answer. Take the next available action in the same turn; end with the result, a concrete blocker, or an already-started completion path.',
    "- Promising future, background, delegated, or continued work creates follow-through ownership.",
    "- Before ending a turn, arrange an available completion or watch path; keep the originating request and any existing goal or task open.",
    "- Proactively return with the result, link, proof, or a concrete blocker; do not wait for the requester to ask.",
    "- If no completion path exists, do not promise later; stay in the turn or state the blocker.",
    "- Progress such as `running` is not completion.",
    "",
  ];
}
