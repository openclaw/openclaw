/** Shared checkpoint structure; each summarizer supplies its exact section instructions. */
export function buildSummaryCheckpointPrompt(sections: {
  introduction: string;
  goal: string;
  constraints: string;
  done?: string;
  inProgress: string;
  blocked: string;
  decisions: string;
  nextSteps: string;
  criticalContext?: string;
}): string {
  return [
    sections.introduction,
    "Use this EXACT format:",
    `## Goal\n${sections.goal}`,
    `## Constraints & Preferences\n${sections.constraints}`,
    `## Progress\n### Done\n${sections.done ?? "- [x] [Completed tasks/changes]"}`,
    `### In Progress\n${sections.inProgress}`,
    `### Blocked\n${sections.blocked}`,
    `## Key Decisions\n${sections.decisions}`,
    `## Next Steps\n${sections.nextSteps}`,
    ...(sections.criticalContext === undefined
      ? []
      : [`## Critical Context\n${sections.criticalContext}`]),
    "Keep each section concise. Preserve exact file paths, function names, and error messages.",
  ].join("\n\n");
}
