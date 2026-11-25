type FailureCoordinates = {
  phase: string;
  outcome: "failed";
  exitStatus: number;
  signal: string | null;
};
type Redactor = (text: string, options: { mode: "tools" }) => string;
export function recordSuccessfulUpdateCheck(
  artifactRoot: string | undefined,
  result: unknown,
): void;
export function readPostCoreSnapshot(artifactRoot: string): {
  childExitCode: number;
  result: Record<string, unknown>;
} | null;
export function publishDiagnostics(
  artifactRoot: string,
  destination: string,
  redact: Redactor,
  outcome?: string,
): Omit<FailureCoordinates, "outcome"> | undefined;
