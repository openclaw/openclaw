const DEFAULT_MAX_OUTPUT_CHARS = 16_384;

export type BoundedChildOutput = {
  /** Retained output tail, kept within the configured character limit. */
  text: string;
  /** True once older output has been dropped from the accumulator. */
  truncated: boolean;
};

/** Creates an empty accumulator for bounded child-process output capture. */
export function emptyBoundedChildOutput(): BoundedChildOutput {
  return { text: "", truncated: false };
}

/** Appends output while retaining only the newest maxChars so diagnostics stay bounded. */
export function appendBoundedChildOutput(
  current: BoundedChildOutput,
  chunk: string,
  maxChars = DEFAULT_MAX_OUTPUT_CHARS,
): BoundedChildOutput {
  const appended = current.text + chunk;
  if (appended.length <= maxChars) {
    return { text: appended, truncated: current.truncated };
  }
  return {
    // Keep the tail because child-process failures usually print the actionable error last.
    text: appended.slice(-maxChars),
    truncated: true,
  };
}

/** Prefixes retained output with an explicit truncation marker when older text was dropped. */
export function formatBoundedChildOutput(output: BoundedChildOutput): string {
  return output.truncated ? `[output truncated]\n${output.text}` : output.text;
}
