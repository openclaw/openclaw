export type CodexAppServerParseFailure = {
  byteCount: number;
  charCount?: number;
  fragmentCount: number;
};

/** Parses the single JSON value in an app-server LF-delimited frame. */
export function parseCodexAppServerMessage(
  line: string,
  reportError: (failure: CodexAppServerParseFailure) => void,
): unknown {
  const frame = line.trim();
  if (!frame) {
    return undefined;
  }
  try {
    return JSON.parse(frame);
  } catch {
    // Parse errors can quote private frame content; only sizes belong in diagnostics.
    reportError({ byteCount: Buffer.byteLength(frame), charCount: frame.length, fragmentCount: 1 });
    return undefined;
  }
}
