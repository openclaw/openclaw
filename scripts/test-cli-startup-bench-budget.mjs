import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { floatFlag, intFlag, parseFlagArgs, readEnvNumber, stringFlag } from "./lib/arg-utils.mjs";
import { readJsonFile } from "./test-report-utils.mjs";

const CLI_STARTUP_BENCH_FIXTURE_PATH = "test/fixtures/cli-startup-bench.json";

function formatMs(value) {
  return `${value.toFixed(1)}ms`;
}

function formatMb(value) {
  return `${value.toFixed(1)}MB`;
}

if (process.argv.slice(2).includes("--help")) {
  console.log(
    [
      "Usage: node scripts/test-cli-startup-bench-budget.mjs [options]",
      "",
      "Compare current CLI benchmark results against the checked-in fixture.",
      "",
      "Options:",
      "  --baseline <path>             Baseline fixture path",
      "  --report <path>               Reuse an existing current benchmark report",
      "  --entry <path>                CLI entry to benchmark when report is omitted",
      "  --preset <name>               startup | real | all (default: all)",
      "  --runs <n>                    Measured runs per case (default: 1)",
      "  --warmup <n>                  Warmup runs per case (default: 0)",
      "  --timeout-ms <ms>             Per-run timeout (default: 30000)",
      "  --max-duration-regression-pct <n>",
      "                                Fail if avg duration regresses more than this percent",
      "  --max-rss-regression-pct <n>  Fail if avg RSS regresses more than this percent",
      "  --help                        Show this help text",
      "",
      "Example:",
      "  node scripts/test-cli-startup-bench-budget.mjs --preset real --max-duration-regression-pct 15",
    ].join("\n"),
  );
  process.exit(0);
}

const opts = parseFlagArgs(
  process.argv.slice(2),
  {
    baseline: CLI_STARTUP_BENCH_FIXTURE_PATH,
    report: "",
    entry: "openclaw.mjs",
    preset: "all",
    runs: 1,
    warmup: 0,
    timeoutMs: 30_000,
    maxDurationRegressionPct:
      readEnvNumber("OPENCLAW_STARTUP_BENCH_MAX_DURATION_REGRESSION_PCT") ?? 20,
    maxRssRegressionPct: readEnvNumber("OPENCLAW_STARTUP_BENCH_MAX_RSS_REGRESSION_PCT") ?? 20,
  },
  [
    stringFlag("--baseline", "baseline"),
    stringFlag("--report", "report"),
    stringFlag("--entry", "entry"),
    stringFlag("--preset", "preset"),
    intFlag("--runs", "runs", { min: 1 }),
    intFlag("--warmup", "warmup", { min: 0 }),
    intFlag("--timeout-ms", "timeoutMs", { min: 1 }),
    floatFlag("--max-duration-regression-pct", "maxDurationRegressionPct", { min: 0 }),
    floatFlag("--max-rss-regression-pct", "maxRssRegressionPct", { min: 0 }),
  ],
);

function resolveCurrentReportPath() {
  if (opts.report) {
    return opts.report;
  }
  const reportPath = `.artifacts/cli-startup-bench.current.json`;
  fs.mkdirSync(".artifacts", { recursive: true });
  const args = [
    "--import",
    "tsx",
    "scripts/bench-cli-startup.ts",
    "--entry",
    opts.entry,
    "--preset",
    opts.preset,
    "--runs",
    String(opts.runs),
    "--warmup",
    String(opts.warmup),
    "--timeout-ms",
    String(opts.timeoutMs),
    "--output",
    reportPath,
  ];
  const run = spawnSync("node", args, {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
  });
  if (run.status !== 0) {
    process.exit(run.status ?? 1);
  }
  return reportPath;
}

function indexCases(report) {
  return new Map((report?.primary?.cases ?? []).map((entry) => [entry.id, entry]));
}

const baseline = readJsonFile(opts.baseline);
const current = readJsonFile(resolveCurrentReportPath());
const baselineCases = indexCases(baseline);
const currentCases = indexCases(current);

let failed = false;

for (const [id, baselineCase] of baselineCases) {
  const currentCase = currentCases.get(id);
  if (!currentCase) {
    console.error(`[test-cli-startup-bench-budget] missing current case ${String(id)}`);
    failed = true;
    continue;
  }

  const baselineDuration = baselineCase.summary?.durationMs?.avg;
  const currentDuration = currentCase.summary?.durationMs?.avg;
  if (
    Number.isFinite(baselineDuration) &&
    Number.isFinite(currentDuration) &&
    baselineDuration > 0
  ) {
    const allowedDuration = baselineDuration * (1 + opts.maxDurationRegressionPct / 100);
    if (currentDuration > allowedDuration) {
      console.error(
        `[test-cli-startup-bench-budget] ${baselineCase.name} avg duration ${formatMs(
          currentDuration,
        )} exceeded ${formatMs(allowedDuration)} (baseline ${formatMs(
          baselineDuration,
        )}, +${String(opts.maxDurationRegressionPct)}%).`,
      );
      failed = true;
    }
  }

  const baselineRss = baselineCase.summary?.maxRssMb?.avg;
  const currentRss = currentCase.summary?.maxRssMb?.avg;
  if (Number.isFinite(baselineRss) && Number.isFinite(currentRss) && baselineRss > 0) {
    const allowedRss = baselineRss * (1 + opts.maxRssRegressionPct / 100);
    if (currentRss > allowedRss) {
      console.error(
        `[test-cli-startup-bench-budget] ${baselineCase.name} avg RSS ${formatMb(
          currentRss,
        )} exceeded ${formatMb(allowedRss)} (baseline ${formatMb(
          baselineRss,
        )}, +${String(opts.maxRssRegressionPct)}%).`,
      );
      failed = true;
    }
  }

  console.log(
    `[test-cli-startup-bench-budget] ${baselineCase.name} duration=${formatMs(
      currentDuration,
    )} baseline=${formatMs(baselineDuration)} rss=${
      Number.isFinite(currentRss) ? formatMb(currentRss) : "n/a"
    } baselineRss=${Number.isFinite(baselineRss) ? formatMb(baselineRss) : "n/a"}`,
  );
}

if (failed) {
  process.exit(1);
}
