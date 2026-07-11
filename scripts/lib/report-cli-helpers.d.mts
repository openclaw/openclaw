export function parseReportCliArgs(argv: unknown): {
  rootDir: string;
  jsonPath: null;
  markdownPath: null;
};
/**
 * Writes an optional report artifact, creating its parent directory first.
 */
export function writeReportArtifact(filePath: unknown, content: unknown): Promise<void>;
