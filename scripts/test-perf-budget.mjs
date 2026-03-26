import { floatFlag, parseFlagArgs, readEnvNumber, stringFlag } from "./lib/arg-utils.mjs";
import { formatMs } from "./lib/vitest-report-cli-utils.mjs";
import { readJsonFile, runVitestJsonReport } from "./test-report-utils.mjs";

function parseArgs(argv) {
  return parseFlagArgs(
    argv,
    {
      config: "vitest.unit.config.ts",
      maxWallMs: readEnvNumber("OPENCLAW_TEST_PERF_MAX_WALL_MS"),
      baselineWallMs: readEnvNumber("OPENCLAW_TEST_PERF_BASELINE_WALL_MS"),
      maxRegressionPct: readEnvNumber("OPENCLAW_TEST_PERF_MAX_REGRESSION_PCT") ?? 10,
    },
    [
      stringFlag("--config", "config"),
      floatFlag("--max-wall-ms", "maxWallMs"),
      floatFlag("--baseline-wall-ms", "baselineWallMs"),
      floatFlag("--max-regression-pct", "maxRegressionPct"),
    ],
  );
}

const opts = parseArgs(process.argv.slice(2));
const startedAt = process.hrtime.bigint();
const reportPath = runVitestJsonReport({
  config: opts.config,
  prefix: "openclaw-vitest-perf",
});
const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

let totalFileDurationMs = 0;
let fileCount = 0;
try {
  const report = readJsonFile(reportPath);
  for (const result of report.testResults ?? []) {
    if (typeof result.startTime === "number" && typeof result.endTime === "number") {
      totalFileDurationMs += Math.max(0, result.endTime - result.startTime);
      fileCount += 1;
    }
  }
} catch {
  // Keep budget checks based on wall time when JSON parsing fails.
}

const allowedByBaseline =
  opts.baselineWallMs !== null
    ? opts.baselineWallMs * (1 + (opts.maxRegressionPct ?? 0) / 100)
    : null;

let failed = false;
if (opts.maxWallMs !== null && elapsedMs > opts.maxWallMs) {
  console.error(
    `[test-perf-budget] wall time ${formatMs(elapsedMs)} exceeded max ${formatMs(opts.maxWallMs)}.`,
  );
  failed = true;
}
if (allowedByBaseline !== null && elapsedMs > allowedByBaseline) {
  console.error(
    `[test-perf-budget] wall time ${formatMs(elapsedMs)} exceeded baseline budget ${formatMs(
      allowedByBaseline,
    )} (baseline ${formatMs(opts.baselineWallMs ?? 0)}, +${String(opts.maxRegressionPct)}%).`,
  );
  failed = true;
}

console.log(
  `[test-perf-budget] config=${opts.config} wall=${formatMs(elapsedMs)} file-sum=${formatMs(
    totalFileDurationMs,
  )} files=${String(fileCount)}`,
);

if (failed) {
  process.exit(1);
}
