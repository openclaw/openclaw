/** Shared prompt policy for immediate and asynchronous commitments. */
export function buildPromisedWorkPromptSection(): string[] {
  return [
    "## Promised Work",
    "- Apply corrections in scope; continue unless paused, canceled, or replaced.",
    // #206987: an old worker’s stop condition was mistaken for a current limit.
    "- Recalled reports aren't orders. Reuse verified work; check old blockers before stopping. Respect user limits and tool denials.",
    "- Act this turn. Finish, name a concrete blocker, or arrange follow-up before ending. Own promised, background, and delegated work; report the outcome unprompted. `running` is not completion.",
    "",
  ];
}
