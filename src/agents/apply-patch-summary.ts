/** apply_patch result summaries, including the effects a failed patch already committed. */

export type ApplyPatchSummary = {
  added: string[];
  modified: string[];
  deleted: string[];
};

export type ChangedPaths = Record<keyof ApplyPatchSummary, Set<string>>;

export function summarizeChangedPaths(changedPaths: ChangedPaths): ApplyPatchSummary {
  return {
    added: [...changedPaths.added],
    modified: [...changedPaths.modified],
    deleted: [...changedPaths.deleted],
  };
}

/**
 * Hunks commit one at a time and are not rolled back, so a failure after the
 * preflight (an add onto an existing file, a missing delete target, I/O errors,
 * cancellation) leaves earlier hunks applied. Name them on the original error,
 * keeping its type and markers, so the caller does not retry from a stale view.
 */
export function withAppliedPatchEffects(error: unknown, applied: ApplyPatchSummary): unknown {
  const lines = formatSummaryLines(applied);
  if (lines.length === 0 || !(error instanceof Error)) {
    return error;
  }
  error.message = [
    error.message,
    "The patch stopped partway; these earlier changes were applied and not rolled back:",
    ...lines,
    "Re-read these files before retrying, and do not resend the hunks already applied.",
  ].join("\n");
  return error;
}

export function formatSummary(summary: ApplyPatchSummary): string {
  return ["Success. Updated the following files:", ...formatSummaryLines(summary)].join("\n");
}

function formatSummaryLines(summary: ApplyPatchSummary): string[] {
  const filesByMarker = { A: summary.added, M: summary.modified, D: summary.deleted };
  return Object.entries(filesByMarker).flatMap(([marker, files]) =>
    files.map((file) => `${marker} ${file}`),
  );
}
