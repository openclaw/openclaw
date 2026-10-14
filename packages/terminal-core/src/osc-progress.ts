// OSC 9;4 progress reporting for terminals that support shell integration progress.

const OSC_PROGRESS_PREFIX = "\u001b]9;4;";
const OSC_PROGRESS_ST = "\u001b\\";

/** Return true when the terminal is known to support OSC progress messages. */
export function supportsOscProgress(env: NodeJS.ProcessEnv, isTty: boolean): boolean {
  if (!isTty) {
    return false;
  }
  const termProgram = (env.TERM_PROGRAM ?? "").toLowerCase();
  return (
    termProgram.includes("ghostty") || termProgram.includes("wezterm") || Boolean(env.WT_SESSION)
  );
}

/** Format one OSC progress control sequence. */
export function formatOscProgress(state: number, percent: number): string {
  const normalizedPercent = Math.max(0, Math.min(100, Math.round(percent)));
  return `${OSC_PROGRESS_PREFIX}${state};${normalizedPercent}${OSC_PROGRESS_ST}`;
}
