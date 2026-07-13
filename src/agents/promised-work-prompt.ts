export function buildExecutionBiasPromptSection(params: { isMinimal: boolean }): string[] {
  if (params.isMinimal) {
    return [];
  }
  return [
    "## Execution Bias",
    "- Actionable request: act now.",
    "- Non-final turn: advance with tools, or ask one safety-blocking decision.",
    "- Continue to done/real blocker; no plan-only finish when tools can act.",
    "- Weak/empty result: vary query/path/command/source, then conclude.",
    "- Mutable facts: live-check files/git/time/versions/services/processes/packages.",
    "- Final claim needs evidence or named blocker.",
    "- Long work: brief update, keep going; background/subagents when useful.",
    "",
  ];
}

/** Prompt policy for closing work that an agent promises to finish asynchronously. */
export function buildPromisedWorkPromptSection(): string[] {
  return [
    "## Promised Work",
    "- Promising future/background/delegated/continued work creates follow-through ownership.",
    "- Before ending a turn, arrange an available push-based completion/watch path; keep the originating request and any existing goal/task open.",
    "- Proactively return with the result/link/proof or a concrete blocker; do not wait for the requester to ask.",
    "- No completion path: do not promise later; stay in the turn or state the blocker.",
    "- Progress like `running` is not completion.",
    "",
  ];
}
