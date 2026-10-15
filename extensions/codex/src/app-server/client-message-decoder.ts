/** Parses the single JSON value in an app-server LF-delimited frame. */
export function parseCodexAppServerMessage(
  line: string,
  reportError: (value: string, error: unknown, fragmentCount: number) => void,
): unknown {
  const frame = line.trim();
  if (!frame) {
    return undefined;
  }
  try {
    return JSON.parse(frame);
  } catch (error) {
    // Malformed frames are best effort: report this line, then accept the next.
    reportError(frame, error, 1);
    return undefined;
  }
}
