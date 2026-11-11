/** Mock compaction-summary bodies keyed by markers in the summarizer input. */

export const QA_COMPACTION_EMPTY_OUTPUT_ONCE_MARKER_RE =
  /\bQA-COMPACTION-EMPTY-OUTPUT-ONCE-[A-Za-z0-9_-]+\b/u;
export const QA_COMPACTION_REASONING_ONLY_OUTPUT_ONCE_MARKER_RE =
  /\bQA-COMPACTION-REASONING-ONLY-OUTPUT-ONCE-[A-Za-z0-9_-]+\b/u;
const QA_COMPACTION_EMPTY_RECOVERY_SUMMARY_MARKER = "QA-COMPACTION-EMPTY-RECOVERED-SUMMARY";
const QA_COMPACTION_REASONING_RECOVERY_SUMMARY_MARKER = "QA-COMPACTION-REASONING-RECOVERED-SUMMARY";
const QA_COMPACTION_SUMMARY_PRIORITY_MARKER = "QA-COMPACTION-SUMMARY-PRIORITY";
const QA_COMPACTION_SUMMARY_PRIORITY_BODY_END = "QA-SUMMARY-PRIORITY-BODY-END";
const QA_COMPACTION_SUMMARY_PRIORITY_DECISIONS = 110;

const QA_GENERIC_COMPACTION_SUMMARY = `## Decisions
- Continue from the summary without restarting completed work.

## Open TODOs
- Continue the active task.

## Constraints/Rules
- Keep current requirements and identifiers.

## Pending user asks
- Continue the active task from the retained context.

## Exact identifiers
- None captured.`;
const QA_COMPACTION_OUTPUT_RECOVERY_SUMMARY = `## Decisions
- Retry the typed compaction-summary fault at the compaction owner.

## Open TODOs
- Continue the active task after compaction.

## Constraints/Rules
- Preserve the historical recovery user block and current continuation.

## Pending user asks
- Retain the historical recovery user block context.

## Exact identifiers`;

export function resolveCompactionRecoverySummary(allInputText: string) {
  if (allInputText.includes(QA_COMPACTION_SUMMARY_PRIORITY_MARKER)) {
    return buildSummaryPrioritySummary();
  }
  const faultMarker =
    QA_COMPACTION_EMPTY_OUTPUT_ONCE_MARKER_RE.exec(allInputText)?.[0] ??
    QA_COMPACTION_REASONING_ONLY_OUTPUT_ONCE_MARKER_RE.exec(allInputText)?.[0];
  const recoveryMarker = faultMarker?.startsWith("QA-COMPACTION-EMPTY-")
    ? QA_COMPACTION_EMPTY_RECOVERY_SUMMARY_MARKER
    : faultMarker
      ? QA_COMPACTION_REASONING_RECOVERY_SUMMARY_MARKER
      : undefined;
  return recoveryMarker && faultMarker
    ? `${QA_COMPACTION_OUTPUT_RECOVERY_SUMMARY}\n- ${recoveryMarker}\n- ${faultMarker}`
    : QA_GENERIC_COMPACTION_SUMMARY;
}

/** Recovery scenarios overflow at a smaller request size and own their summary body. */
export function hasCompactionOutputRecoveryMarker(allInputText: string) {
  return (
    QA_COMPACTION_EMPTY_OUTPUT_ONCE_MARKER_RE.test(allInputText) ||
    QA_COMPACTION_REASONING_ONLY_OUTPUT_ONCE_MARKER_RE.test(allInputText) ||
    allInputText.includes(QA_COMPACTION_SUMMARY_PRIORITY_MARKER)
  );
}

// A generated body near 10k chars: large enough that verbatim preserved turns
// must yield for the whole body to fit the 16k persisted-summary cap.
function buildSummaryPrioritySummary(): string {
  const decisions = Array.from(
    { length: QA_COMPACTION_SUMMARY_PRIORITY_DECISIONS },
    (_, index) =>
      `- Priority decision ${String(index).padStart(3, "0")}: keep the generated summary ahead of verbatim turns.`,
  );
  return [
    "## Decisions",
    ...decisions,
    `- ${QA_COMPACTION_SUMMARY_PRIORITY_BODY_END}`,
    "",
    "## Open TODOs",
    "- Continue the summary priority check.",
    "",
    "## Constraints/Rules",
    "- Keep the generated summary whole.",
    "",
    "## Pending user asks",
    "- Finish the summary priority check.",
    "",
    "## Exact identifiers",
    "- None captured.",
  ].join("\n");
}
