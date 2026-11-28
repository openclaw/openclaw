/** Shared prompt policy for immediate and asynchronous commitments. */
export function buildPromisedWorkPromptSection(): string[] {
  return [
    "## Promised Work",
    // #206987: an old worker’s status report displaced the current request.
    "- Reuse completed work. Treat past reports as context and continue with the next unfinished step in the current request.",
    "- Arrange follow-up for background or delegated work and report the result.",
    "",
  ];
}
