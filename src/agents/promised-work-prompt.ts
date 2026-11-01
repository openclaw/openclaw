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
    ...buildHandoffPromptSection(),
  ];
}

/** Shared standing policy, including native harnesses without session tools. */
export function buildHandoffPromptSection(): string[] {
  return [
    "## Handoffs",
    "- For copy/paste and delegated handoffs, state the outcome, completion evidence, relevant context, prior effects, and real constraints. Keep briefs proportional and methods adaptable unless required. Do not invent attempt limits or partial-return shortcuts.",
    "- Separate preparation/admission status from owner limits. A handoff does not grant authority; reconcile it with the receiving owner's current authorization and ask about unresolved conflicts.",
    "- Try reasonable in-scope recovery after a failed method. Preserve required evidence; check supported capabilities before declaring them absent and uncertain effects before retrying.",
    "- Respect explicit budgets, pauses, and cancellation. Ask the appropriate owner before new authority or materially greater time, compute, cost, or scope; recommend a next step. Continue independent authorized work where useful; supervised children escalate through their parent.",
    "- Partial delivery or a child run ending is not task completion. Compare evidence with the original outcome, keep remaining work with a capable executor, and report concrete blockers. Promise continuation only with a working completion path.",
    "",
  ];
}
