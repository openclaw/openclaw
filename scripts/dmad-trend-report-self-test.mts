/**
 * dmad-trend-report-self-test.mts — fixture tests for DMAD trend gating.
 *
 * 用法：pnpm dmad:trend:self-test
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

interface FixtureReport {
  id?: string;
  runStatus?: string;
  convergenceScore: number;
  totalRounds: number;
  stoppedBy: "convergence" | "variance" | "max_rounds" | "timeout";
  startedAt: string;
  completedAt: string;
  durationMs?: number;
  totalTimeoutMs?: number;
  aborted?: boolean;
  qualityStatus?: "pass" | "degraded_agents";
  degradedReason?: string | null;
  hadCliError?: boolean;
  cliErrorSummary?: {
    claudeMissing?: number;
    claudeFailed?: number;
    codexMissing?: number;
    codexFailed?: number;
  };
  trajectoryScores?: { claude: number; codex: number; openclaw: number };
}

type ExpectedValue = string | number | null | Record<string, unknown>;

const REQUIRED_TREND_FIELDS = [
  "generatedAt",
  "reportCount",
  "dedupedReportCount",
  "invalidReportCount",
  "completedReportCount",
  "timeoutReportCount",
  "cleanReportCount",
  "degradedReportCount",
  "timeoutRatePercent",
  "avgConvergenceScore",
  "cleanAvgConvergenceScore",
  "degradedAvgConvergenceScore",
  "percentiles",
  "trend",
  "stoppedByDistribution",
  "convergenceRatePercent",
  "avgRounds",
  "avgDurationMs",
  "qualityStatus",
  "degradedReason",
  "trendGateStatus",
  "normalQualityGate",
  "cliErrorRatePercent",
  "cliErrorSummary",
  "agentLeadCount",
  "latestResult",
] as const;

const REQUIRED_NESTED_FIELDS: Record<string, readonly string[]> = {
  percentiles: ["p50", "p95"],
  stoppedByDistribution: ["convergence", "variance", "max_rounds", "timeout"],
  normalQualityGate: ["status", "reason"],
  cliErrorSummary: ["claudeMissing", "claudeFailed", "codexMissing", "codexFailed"],
  agentLeadCount: ["claude", "codex", "openclaw"],
};

const REQUIRED_LATEST_RESULT_FIELDS = [
  "convergenceScore",
  "totalRounds",
  "stoppedBy",
  "startedAt",
  "completedAt",
  "qualityStatus",
  "degradedReason",
  "hadCliError",
  "cliErrorSummary",
  "trajectoryScores",
] as const;

const REQUIRED_LATEST_RESULT_NESTED_FIELDS: Record<string, readonly string[]> = {
  cliErrorSummary: ["claudeMissing", "claudeFailed", "codexMissing", "codexFailed"],
  trajectoryScores: ["claude", "codex", "openclaw"],
};

function cleanReport(id: string): FixtureReport {
  return {
    id,
    convergenceScore: 0.82,
    totalRounds: 2,
    stoppedBy: "convergence",
    startedAt: "2026-05-20T00:00:00.000Z",
    completedAt: "2026-05-20T00:01:00.000Z",
    qualityStatus: "pass",
    degradedReason: null,
    hadCliError: false,
    cliErrorSummary: { claudeMissing: 0, claudeFailed: 0, codexMissing: 0, codexFailed: 0 },
    trajectoryScores: { claude: 0.4, codex: 0.35, openclaw: 0.25 },
  };
}

function cleanReportWithoutId(startMinute: number): FixtureReport {
  const minute = String(startMinute).padStart(2, "0");
  return {
    convergenceScore: 0.82,
    totalRounds: 2,
    stoppedBy: "convergence",
    startedAt: `2026-05-20T00:${minute}:00.000Z`,
    completedAt: `2026-05-20T00:${minute}:30.000Z`,
    qualityStatus: "pass",
    degradedReason: null,
    hadCliError: false,
    cliErrorSummary: { claudeMissing: 0, claudeFailed: 0, codexMissing: 0, codexFailed: 0 },
    trajectoryScores: { claude: 0.4, codex: 0.35, openclaw: 0.25 },
  };
}

function degradedReport(id: string): FixtureReport {
  return {
    id,
    convergenceScore: 0.41,
    totalRounds: 3,
    stoppedBy: "max_rounds",
    startedAt: "2026-05-20T00:02:00.000Z",
    completedAt: "2026-05-20T00:03:00.000Z",
    qualityStatus: "degraded_agents",
    degradedReason: "claude_missing=1,codex_failed=1",
    hadCliError: true,
    cliErrorSummary: { claudeMissing: 1, claudeFailed: 0, codexMissing: 0, codexFailed: 1 },
    trajectoryScores: { claude: 0.2, codex: 0.5, openclaw: 0.3 },
  };
}

function timeoutReport(id: string): FixtureReport {
  return {
    id,
    runStatus: "timeout",
    convergenceScore: 0,
    totalRounds: 0,
    stoppedBy: "timeout",
    startedAt: "2026-05-20T00:04:00.000Z",
    completedAt: "2026-05-20T00:04:30.000Z",
    durationMs: 30000,
    totalTimeoutMs: 20000,
    aborted: true,
    qualityStatus: "degraded_agents",
    degradedReason: "run_timeout",
    hadCliError: true,
    cliErrorSummary: { claudeMissing: 0, claudeFailed: 0, codexMissing: 0, codexFailed: 0 },
    trajectoryScores: { claude: 0, codex: 0, openclaw: 0 },
  };
}

function assertDeepEqual(name: string, actual: ExpectedValue, expected: ExpectedValue) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `[dmad-trend-self-test] ${name} expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`,
    );
  }
}

function assertHasKeys(name: string, actual: Record<string, unknown>, keys: readonly string[]) {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(actual, key)) {
      throw new Error(`[dmad-trend-self-test] ${name} missing required field ${key}`);
    }
  }
}

function assertTrendOutputSchema(scenario: string, actual: Record<string, unknown>) {
  assertHasKeys(`${scenario}.schema`, actual, REQUIRED_TREND_FIELDS);
  for (const [field, keys] of Object.entries(REQUIRED_NESTED_FIELDS)) {
    const value = actual[field];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`[dmad-trend-self-test] ${scenario}.${field} must be an object`);
    }
    assertHasKeys(`${scenario}.${field}`, value as Record<string, unknown>, keys);
  }
  const latestResult = actual.latestResult;
  if (latestResult !== null) {
    if (!latestResult || typeof latestResult !== "object" || Array.isArray(latestResult)) {
      throw new Error(`[dmad-trend-self-test] ${scenario}.latestResult must be null or an object`);
    }
    const latest = latestResult as Record<string, unknown>;
    assertHasKeys(`${scenario}.latestResult`, latest, REQUIRED_LATEST_RESULT_FIELDS);
    for (const [field, keys] of Object.entries(REQUIRED_LATEST_RESULT_NESTED_FIELDS)) {
      const value = latest[field];
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(
          `[dmad-trend-self-test] ${scenario}.latestResult.${field} must be an object`,
        );
      }
      assertHasKeys(`${scenario}.latestResult.${field}`, value as Record<string, unknown>, keys);
    }
  }
}

function runTrendFixture(
  scenario: string,
  reports: FixtureReport[],
  expected: Record<string, ExpectedValue>,
  latestReport?: FixtureReport,
  latestFileName = "dmad-run-test-latest.json",
  invalidFiles: Record<string, string> = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `openclaw-dmad-trend-${scenario}-`));
  const outPath = path.join(dir, "dmad-trend-latest.json");
  const latestPath = path.join(dir, latestFileName);
  try {
    reports.forEach((report, index) => {
      fs.writeFileSync(
        path.join(dir, `dmad-run-test-${report.id ?? `fixture-${index}`}.json`),
        JSON.stringify(report, null, 2),
        "utf-8",
      );
    });

    if (latestReport) {
      fs.mkdirSync(path.dirname(latestPath), { recursive: true });
      fs.writeFileSync(latestPath, JSON.stringify(latestReport, null, 2), "utf-8");
    }
    for (const [fileName, contents] of Object.entries(invalidFiles)) {
      fs.writeFileSync(path.join(dir, fileName), contents, "utf-8");
    }

    execFileSync(process.execPath, ["--import", "tsx", "scripts/dmad-trend-report.mts"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DMAD_TREND_REPORTS_DIR: dir,
        DMAD_TREND_LATEST_PATH: latestPath,
        DMAD_TREND_OUT: outPath,
      },
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const actual = JSON.parse(fs.readFileSync(outPath, "utf-8")) as Record<string, ExpectedValue>;
    assertTrendOutputSchema(scenario, actual);
    for (const [key, value] of Object.entries(expected)) {
      assertDeepEqual(`${scenario}.${key}`, actual[key], value);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

runTrendFixture("clean", [cleanReport("clean")], {
  reportCount: 1,
  dedupedReportCount: 0,
  invalidReportCount: 0,
  cleanReportCount: 1,
  degradedReportCount: 0,
  cleanAvgConvergenceScore: 0.82,
  degradedAvgConvergenceScore: null,
  qualityStatus: "pass",
  trendGateStatus: "pass",
  normalQualityGate: { status: "pass", reason: null },
  cliErrorRatePercent: 0,
});

runTrendFixture("degraded", [degradedReport("degraded")], {
  reportCount: 1,
  cleanReportCount: 0,
  degradedReportCount: 1,
  cleanAvgConvergenceScore: null,
  degradedAvgConvergenceScore: 0.41,
  qualityStatus: "degraded_agents",
  trendGateStatus: "blocked_no_clean_reports",
  normalQualityGate: { status: "blocked_no_clean_reports", reason: "cleanReportCount=0" },
  cliErrorRatePercent: 100,
});

runTrendFixture("mixed", [cleanReport("clean"), degradedReport("degraded")], {
  reportCount: 2,
  dedupedReportCount: 0,
  invalidReportCount: 0,
  completedReportCount: 2,
  timeoutReportCount: 0,
  cleanReportCount: 1,
  degradedReportCount: 1,
  timeoutRatePercent: 0,
  avgConvergenceScore: 0.615,
  cleanAvgConvergenceScore: 0.82,
  degradedAvgConvergenceScore: 0.41,
  qualityStatus: "degraded_agents",
  trendGateStatus: "pass",
  normalQualityGate: { status: "pass", reason: null },
  cliErrorRatePercent: 50,
});

runTrendFixture("timeout-isolated", [cleanReport("clean"), timeoutReport("timeout")], {
  reportCount: 2,
  dedupedReportCount: 0,
  invalidReportCount: 0,
  completedReportCount: 1,
  timeoutReportCount: 1,
  cleanReportCount: 1,
  degradedReportCount: 0,
  timeoutRatePercent: 50,
  avgConvergenceScore: 0.82,
  cleanAvgConvergenceScore: 0.82,
  degradedAvgConvergenceScore: null,
  qualityStatus: "degraded_agents",
  trendGateStatus: "pass",
  normalQualityGate: { status: "pass", reason: null },
  cliErrorRatePercent: 50,
  degradedReason: "run_timeout=1",
  convergenceRatePercent: 100,
  stoppedByDistribution: { convergence: 1, variance: 0, max_rounds: 0, timeout: 1 },
});

runTrendFixture(
  "latest-history-dedup-id",
  [cleanReport("same")],
  {
    reportCount: 1,
    dedupedReportCount: 1,
    invalidReportCount: 0,
    cleanReportCount: 1,
    avgConvergenceScore: 0.82,
    convergenceRatePercent: 100,
  },
  cleanReport("same"),
);

runTrendFixture(
  "latest-history-dedup-no-id",
  [cleanReportWithoutId(6)],
  {
    reportCount: 1,
    dedupedReportCount: 1,
    invalidReportCount: 0,
    cleanReportCount: 1,
    avgConvergenceScore: 0.82,
    convergenceRatePercent: 100,
  },
  cleanReportWithoutId(6),
);

runTrendFixture(
  "idless-distinct-latest-added",
  [cleanReportWithoutId(7)],
  {
    reportCount: 2,
    dedupedReportCount: 0,
    invalidReportCount: 0,
    cleanReportCount: 2,
    avgConvergenceScore: 0.82,
    convergenceRatePercent: 100,
  },
  cleanReportWithoutId(8),
  "latest.json",
);

runTrendFixture(
  "invalid-history-count",
  [cleanReport("clean")],
  {
    reportCount: 1,
    dedupedReportCount: 0,
    invalidReportCount: 1,
    cleanReportCount: 1,
    avgConvergenceScore: 0.82,
  },
  undefined,
  "dmad-run-test-latest.json",
  { "dmad-run-test-invalid.json": "{not-json" },
);

runTrendFixture(
  "invalid-latest-count",
  [cleanReport("clean")],
  {
    reportCount: 1,
    dedupedReportCount: 0,
    invalidReportCount: 1,
    cleanReportCount: 1,
    avgConvergenceScore: 0.82,
  },
  undefined,
  "dmad-run-test-latest.json",
  { "dmad-run-test-latest.json": "{not-json" },
);

runTrendFixture(
  "combined-signal-smoke",
  [cleanReport("clean"), degradedReport("degraded"), timeoutReport("timeout"), cleanReport("dup")],
  {
    reportCount: 4,
    dedupedReportCount: 1,
    invalidReportCount: 1,
    completedReportCount: 3,
    timeoutReportCount: 1,
    cleanReportCount: 2,
    degradedReportCount: 1,
    timeoutRatePercent: 25,
    avgConvergenceScore: 0.6833,
    cleanAvgConvergenceScore: 0.82,
    degradedAvgConvergenceScore: 0.41,
    qualityStatus: "degraded_agents",
    trendGateStatus: "pass",
    normalQualityGate: { status: "pass", reason: null },
    cliErrorRatePercent: 50,
    degradedReason: "claude_missing=1,codex_failed=1,run_timeout=1",
    convergenceRatePercent: 67,
    stoppedByDistribution: { convergence: 2, variance: 0, max_rounds: 1, timeout: 1 },
  },
  cleanReport("dup"),
  "latest.json",
  { "dmad-run-test-invalid.json": "{not-json" },
);

console.log("[dmad-trend-self-test] PASS");
