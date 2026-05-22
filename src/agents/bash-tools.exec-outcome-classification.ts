export type ExecOutcomeClassification = "success" | "benign_no_result" | "failure";

export type ExecOutcomeClassificationInput = {
  command?: string;
  status?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  aggregated?: string;
};

const EXIT_FOOTER_RE = /\n*\(Command exited with code \d+\)\s*$/u;
const RG_TOKEN_RE = /(?:^|[\s|;&()])rg(?:\s|$)/iu;
const XARGS_TOKEN_RE = /(?:^|[\s|;&()])xargs(?:\s|$)/iu;

function cleanAggregateOutput(value: string | undefined): string {
  return (value ?? "").replace(EXIT_FOOTER_RE, "").trim();
}

function isDirectRgNoMatch(params: { command: string; exitCode: number }): boolean {
  return params.exitCode === 1 && RG_TOKEN_RE.test(params.command);
}

function isXargsRgNoMatch(params: { command: string; exitCode: number }): boolean {
  return (
    params.exitCode === 123 &&
    XARGS_TOKEN_RE.test(params.command) &&
    RG_TOKEN_RE.test(params.command)
  );
}

export function classifyExecOutcome(
  params: ExecOutcomeClassificationInput,
): ExecOutcomeClassification {
  if (params.timedOut === true || params.status === "failed") {
    return "failure";
  }
  if (params.exitCode === 0) {
    return "success";
  }
  if (typeof params.exitCode !== "number") {
    return "failure";
  }

  const command = params.command?.trim();
  if (!command) {
    return "failure";
  }
  if (cleanAggregateOutput(params.aggregated)) {
    return "failure";
  }

  if (
    isDirectRgNoMatch({ command, exitCode: params.exitCode }) ||
    isXargsRgNoMatch({ command, exitCode: params.exitCode })
  ) {
    return "benign_no_result";
  }

  return "failure";
}

export function execOutcomeStatusLabel(
  classification: ExecOutcomeClassification,
): string | undefined {
  return classification === "benign_no_result" ? "No matches found" : undefined;
}
