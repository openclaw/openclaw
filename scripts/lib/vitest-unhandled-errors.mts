const ANSI_CSI_PREFIX = `${String.fromCharCode(27)}[`;
const ANSI_CSI_SUFFIX_RE = /^[0-?]*[ -/]*[@-~]/u;
const UNHANDLED_COUNT_RE = /Vitest caught (\d+) unhandled errors? during the test run\./u;
const UNHANDLED_ORIGIN_RE = /This error originated in "([^"\r\n]+)" test file\./u;

type VitestUnhandledErrors = {
  count: number;
  errorFirstLine?: string;
  origin?: string;
};

export function stripVitestAnsi(value: string): string {
  return value
    .split(ANSI_CSI_PREFIX)
    .map((segment, index) => (index === 0 ? segment : segment.replace(ANSI_CSI_SUFFIX_RE, "")))
    .join("");
}

function isVitestErrorBanner(line: string): boolean {
  if (!line.includes("⎯")) {
    return false;
  }
  const label = line.replaceAll("⎯", "").trim();
  return label.length > 0 && label !== "Unhandled Errors";
}

function escapeWorkflowCommandData(value: string): string {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

export function createVitestUnhandledErrorDetector() {
  let sawUnhandledBanner = false;
  let count: number | undefined;
  let awaitingErrorFirstLine = false;
  let errorFirstLine: string | undefined;
  let origin: string | undefined;

  // The output forwarder owns framing separately for each stream, including EOF tails.
  // Buffering again would join an unterminated stdout tail to a later stderr line.
  const observeLine = (rawLine: string) => {
    const line = stripVitestAnsi(rawLine).trim();
    if (!sawUnhandledBanner) {
      sawUnhandledBanner = line.includes("Unhandled Errors");
      return;
    }

    if (count === undefined) {
      const match = UNHANDLED_COUNT_RE.exec(line);
      const parsed = match?.[1] ? Number(match[1]) : Number.NaN;
      if (Number.isSafeInteger(parsed) && parsed > 0) {
        count = parsed;
      }
      return;
    }

    if (errorFirstLine === undefined) {
      if (isVitestErrorBanner(line)) {
        awaitingErrorFirstLine = true;
        return;
      }
      if (awaitingErrorFirstLine && line.length > 0) {
        errorFirstLine = line;
      }
    }

    origin ??= UNHANDLED_ORIGIN_RE.exec(line)?.[1];
  };

  return {
    observeLine,
    finish: (): VitestUnhandledErrors | null =>
      count === undefined ? null : { count, errorFirstLine, origin },
  };
}

function formatVitestUnhandledErrorSummary(result: VitestUnhandledErrors): string {
  const details = [result.origin, result.errorFirstLine].filter((value) => value !== undefined);
  const suffix = details.length > 0 ? `: ${details.join(" — ")}` : "";
  return `[vitest] UNHANDLED ERRORS (${result.count})${suffix}`;
}

export function writeVitestUnhandledErrorSummary(
  result: VitestUnhandledErrors,
  env: NodeJS.ProcessEnv = process.env,
  log: (message: string) => void = console.error,
): void {
  const summary = formatVitestUnhandledErrorSummary(result);
  if (env.GITHUB_ACTIONS === "true") {
    log(`::error::${escapeWorkflowCommandData(summary)}`);
  }
  log(summary);
}
