export function formatContextLimitTruncationNotice(truncatedChars: number): string {
  return `[... ${Math.max(1, Math.floor(truncatedChars))} more characters truncated; rerun with narrower args if needed]`;
}
