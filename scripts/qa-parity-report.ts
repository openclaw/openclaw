// Qa Parity Report script supports OpenClaw repository automation.
import { booleanFlag, parseFlagArgs, stringFlag } from "./lib/arg-utils.mts";

type Options = Parameters<
  typeof import("../extensions/qa-lab/src/cli.runtime.ts").runQaParityReportCommand
>[0];

function parseArgs(args: string[]): Options {
  return parseFlagArgs<Options>(
    args,
    {},
    [
      stringFlag("--baseline-label", "baselineLabel", { rejectShortOptions: true }),
      stringFlag("--baseline-summary", "baselineSummary", { rejectShortOptions: true }),
      stringFlag("--candidate-label", "candidateLabel", { rejectShortOptions: true }),
      stringFlag("--candidate-summary", "candidateSummary", { rejectShortOptions: true }),
      stringFlag("--output-dir", "outputDir", { rejectShortOptions: true }),
      stringFlag("--repo-root", "repoRoot", { rejectShortOptions: true }),
      booleanFlag("--runtime-axis", "runtimeAxis"),
      stringFlag("--summary", "summary", { rejectShortOptions: true }),
      booleanFlag("--token-efficiency", "tokenEfficiency"),
    ],
    {
      onUnhandledArg(arg: string) {
        if (arg !== "--help" && arg !== "-h") {
          throw new Error(`Unknown qa parity-report option: ${arg}`);
        }
        process.stdout.write(`Usage: openclaw qa parity-report [options]

Options:
  --candidate-summary <path>  Candidate qa-suite-summary.json path
  --baseline-summary <path>   Baseline qa-suite-summary.json path
  --candidate-label <label>   Candidate display label
  --baseline-label <label>    Baseline display label
  --runtime-axis              Interpret --summary as a runtime-pair summary
  --summary <path>            Runtime-axis qa-suite-summary.json path
  --token-efficiency          Also write the runtime token-efficiency report
  --repo-root <path>          Repository root to target
  --output-dir <path>         Artifact directory for the parity report
  -h, --help                  Display help
`);
        process.exit(0);
      },
    },
  );
}

try {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.runtimeAxis) {
    if (!opts.summary) {
      throw new Error("--summary is required when --runtime-axis is set.");
    }
  } else {
    if (!opts.candidateSummary) {
      throw new Error("--candidate-summary is required.");
    }
    if (!opts.baselineSummary) {
      throw new Error("--baseline-summary is required.");
    }
  }

  const { runQaParityReportCommand } = await import("../extensions/qa-lab/src/cli.runtime.ts");
  await runQaParityReportCommand(opts);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
