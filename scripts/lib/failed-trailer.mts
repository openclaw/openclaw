// Keeps wrapper failures visible even when preceding diagnostics are truncated,
// and marks every terminal exit so a truncated log cannot be read as a clean run.
export function writeFailedTrailer(
  tool: string,
  exitCode: number | string | null | undefined,
  log: (value: unknown) => void = console.error,
): void {
  if (typeof exitCode === "number" && exitCode !== 0) {
    log(`[${tool}] FAILED (exit ${exitCode})`);
  }
}

function normalizeExitCode(exitCode: number | string | null | undefined): number {
  if (typeof exitCode === "number") {
    return exitCode;
  }
  if (exitCode === null || exitCode === undefined || exitCode === "") {
    return 0;
  }
  const parsed = Number(exitCode);
  // An unparseable exit code still describes a run that ended: report it as a
  // failure rather than dropping the marker that says the run reached an end.
  return Number.isFinite(parsed) ? parsed : 1;
}

/**
 * Write the fixed-shape terminal marker, then the human failure line.
 * The marker is unconditional: a killed run leaves no marker at all, so its
 * presence — not the log's length — is what says the run reached an end.
 * The `FAILED` line stays last so a reader still ends on the failure text.
 */
export function writeExitTrailer(
  tool: string,
  exitCode: number | string | null | undefined,
  log: (value: unknown) => void = console.error,
): void {
  const code = normalizeExitCode(exitCode);
  log(`[${tool}] EXIT ${code}`);
  writeFailedTrailer(tool, code, log);
}

export async function runWithFailedTrailer(
  tool: string,
  run: () => void | Promise<void>,
  log: (value: unknown) => void = console.error,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    log(error);
    process.exitCode = 1;
  }
  writeExitTrailer(tool, process.exitCode, log);
}
