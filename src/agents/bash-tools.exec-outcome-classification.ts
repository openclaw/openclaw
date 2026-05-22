/**
 * Classifies exec tool outcomes into three categories:
 * - "success": command completed with a result
 * - "benign_no_result": command completed normally but found nothing (rg exit 1, xargs-rg exit 123)
 * - "failure": command failed, timed out, or produced error output
 */
export type ExecOutcomeClassification = "success" | "benign_no_result" | "failure";

export interface ClassifyExecOutcomeInput {
  command?: string;
  status?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  aggregated?: string;
}

const EXEC_SUFFIX_PATTERN = /^\n*\(Command exited with code \d+\)\n*$/;

/**
 * Returns true if the aggregated output looks like clean output with no error signals.
 * Matches the exec tool's standard "no output" format: blank lines + "(Command exited with code N)".
 */
function outputLooksClean(aggregated: string | undefined): boolean {
  if (!aggregated) return true;
  if (EXEC_SUFFIX_PATTERN.test(aggregated)) return true;
  // If it contains only whitespace, it's clean.
  if (/^\s*$/.test(aggregated)) return true;
  return false;
}

export function classifyExecOutcome(input: ClassifyExecOutcomeInput): ExecOutcomeClassification {
  const { command, exitCode, timedOut, aggregated } = input;

  // Real failures are never benign.
  if (timedOut) return "failure";
  if (command === undefined) return "failure";

  // Success exit codes are always successes.
  if (exitCode === 0) return "success";

  // Null exit code means the command didn't run at all.
  if (exitCode === null) return "failure";
  if (exitCode === undefined) return "failure";

  // ── Benign no-result patterns (narrow cases only) ─────────────────────────

  // Pattern 1: Direct ripgrep with exit 1 and clean empty output.
  // rg exits 1 when it finds no matches — this is normal, not an error.
  if (exitCode === 1 && outputLooksClean(aggregated)) {
    return "benign_no_result";
  }

  // Pattern 2: xargs-wrapped ripgrep with exit 123 and clean empty output.
  // xargs exits 123 when all calls to the utility exited with status 1,
  // which happens when ripgrep found nothing. This is normal, not an error.
  if (exitCode === 123 && outputLooksClean(aggregated)) {
    // Confirm it's a ripgrep invocation by checking for rg in the command.
    if (command && /\brg\b/.test(command)) {
      return "benign_no_result";
    }
    // Otherwise be conservative — only rg exit 123 is known benign.
    return "failure";
  }

  // Any other non-zero exit code is a real failure.
  return "failure";
}

/** Returns a human-readable label for a classification, used in status rendering. */
export function execOutcomeStatusLabel(classification: ExecOutcomeClassification): string {
  switch (classification) {
    case "success":
      return "completed";
    case "benign_no_result":
      return "No matches found";
    case "failure":
      return "failed";
  }
}
