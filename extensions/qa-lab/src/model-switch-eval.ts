export function hasModelSwitchContinuityEvidence(text: string) {
  const lower = text.toLowerCase();
  const mentionsHandoff =
    lower.includes("handoff") || lower.includes("model switch") || lower.includes("switched");
  const mentionsKickoffTask =
    lower.includes("qa_kickoff_task") ||
    lower.includes("kickoff task") ||
    lower.includes("qa mission");
  const hasScopeLeak =
    lower.includes("subagent-handoff") ||
    lower.includes("delegated task") ||
    lower.includes("final qa tally") ||
    lower.includes("qa run complete") ||
    lower.includes("all mandatory scenarios");
  const looksOverlong =
    text.length > 280 || text.includes("\n\n") || text.includes("|---") || text.includes("### ");
  return mentionsHandoff && mentionsKickoffTask && !hasScopeLeak && !looksOverlong;
}
