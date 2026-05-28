/**
 * dmad-run-test-self-test.mts — cheap policy checks for dmad-run-test flags.
 *
 * This does not open nuwa.db and does not call Claude/Codex.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildDmadRunReportWithConfig,
  buildDmadRunSuccessStdoutSummary,
  buildDmadRunTimeoutStdoutSummary,
  buildDmadRunTimeoutReport,
  buildRunConfigSummary,
  createDmadRunProgressTracker,
  defaultDmadRunTestMoaTimeoutMs,
  defaultDmadRunTestVerificationTimeoutMs,
  DmadRunTestTimeoutError,
  getDmadRunTestExitCode,
  parseDmadRunTestAgentTimeoutMs,
  parseDmadRunTestConvergenceThreshold,
  parseDmadRunTestMaxRounds,
  parseDmadRunTestVarianceThreshold,
  parseDmadRunTestFlags,
  parseDmadRunTestStageTimeoutMs,
  parseDmadRunTestTotalTimeoutMs,
  resolveDmadRunTestReportPath,
  withDmadRunTimeout,
  writeDmadRunReport,
} from "./dmad-run-test.mts";

function isDmadRunTestTimeoutError(
  err: unknown,
  totalTimeoutMs: number,
): err is DmadRunTestTimeoutError {
  return (
    err instanceof DmadRunTestTimeoutError &&
    err.totalTimeoutMs === totalTimeoutMs &&
    err.name === "DmadRunTestTimeoutError" &&
    err.message === `DMAD run-test exceeded total timeout ${totalTimeoutMs}ms`
  );
}

const cases = [
  {
    name: "default degraded reports but does not fail",
    args: [],
    qualityStatus: "degraded_agents",
    expectedExitCode: 0,
  },
  {
    name: "fail-on-degraded fails degraded reports",
    args: ["--fail-on-degraded"],
    qualityStatus: "degraded_agents",
    expectedExitCode: 2,
  },
  {
    name: "fail-on-degraded allows clean reports",
    args: ["--fail-on-degraded"],
    qualityStatus: "pass",
    expectedExitCode: 0,
  },
  {
    name: "unrelated flags do not enable degraded failure",
    args: ["--json"],
    qualityStatus: "degraded_agents",
    expectedExitCode: 0,
  },
] as const;

for (const c of cases) {
  const flags = parseDmadRunTestFlags(c.args);
  const actualExitCode = getDmadRunTestExitCode({
    failOnDegraded: flags.failOnDegraded,
    qualityStatus: c.qualityStatus,
  });
  assert.equal(actualExitCode, c.expectedExitCode, c.name);
}

assert.equal(parseDmadRunTestTotalTimeoutMs(undefined, 1234), 1234);
assert.equal(parseDmadRunTestTotalTimeoutMs("", 1234), 1234);
assert.equal(parseDmadRunTestTotalTimeoutMs(undefined), 360_000);
assert.equal(parseDmadRunTestTotalTimeoutMs("0", 1234), 0);
assert.equal(parseDmadRunTestTotalTimeoutMs("50.9", 1234), 50);
assert.equal(parseDmadRunTestTotalTimeoutMs("-1", 1234), 1234);
assert.equal(parseDmadRunTestTotalTimeoutMs("not-a-number", 1234), 1234);
assert.equal(parseDmadRunTestAgentTimeoutMs(undefined, 1234), 1234);
assert.equal(parseDmadRunTestAgentTimeoutMs("", 1234), 1234);
assert.equal(parseDmadRunTestAgentTimeoutMs(undefined), 90_000);
assert.equal(parseDmadRunTestAgentTimeoutMs("90123", 1234), 90123);
assert.equal(parseDmadRunTestAgentTimeoutMs("0", 1234), 1234);
assert.equal(parseDmadRunTestAgentTimeoutMs("-1", 1234), 1234);
assert.equal(parseDmadRunTestAgentTimeoutMs("bad", 1234), 1234);
assert.equal(parseDmadRunTestStageTimeoutMs(undefined, 60000), 60000);
assert.equal(parseDmadRunTestStageTimeoutMs("", 60000), 60000);
assert.equal(parseDmadRunTestStageTimeoutMs("999", 60000), 1000);
assert.equal(parseDmadRunTestStageTimeoutMs("12345.9", 60000), 12345);
assert.equal(parseDmadRunTestStageTimeoutMs("0", 60000), 60000);
assert.equal(parseDmadRunTestStageTimeoutMs("-1", 60000), 60000);
assert.equal(parseDmadRunTestStageTimeoutMs("bad", 60000), 60000);
assert.equal(resolveDmadRunTestReportPath(), path.resolve("reports/dmad-run-test-latest.json"));
assert.equal(
  resolveDmadRunTestReportPath("   "),
  path.resolve("reports/dmad-run-test-latest.json"),
);
assert.equal(
  resolveDmadRunTestReportPath("reports/custom-dmad-run.json"),
  path.resolve("reports/custom-dmad-run.json"),
);
assert.equal(
  resolveDmadRunTestReportPath("  reports/custom-dmad-run.json  "),
  path.resolve("reports/custom-dmad-run.json"),
);
assert.equal(
  resolveDmadRunTestReportPath(path.join(os.tmpdir(), "dmad-run.json")),
  path.join(os.tmpdir(), "dmad-run.json"),
);
assert.equal(defaultDmadRunTestMoaTimeoutMs(90_000), 60_000);
assert.equal(defaultDmadRunTestMoaTimeoutMs(45_000), 45_000);
assert.equal(defaultDmadRunTestVerificationTimeoutMs(90_000), 20_000);
assert.equal(defaultDmadRunTestVerificationTimeoutMs(15_000), 15_000);
assert.deepEqual(
  buildRunConfigSummary({
    totalTimeoutMs: 360_000,
    agentTimeoutMs: 90_000,
    moaTimeoutMs: 60_000,
    verificationTimeoutMs: 20_000,
    maxRounds: 3,
    convergenceThreshold: 0.69,
    varianceThreshold: 0.05,
  }),
  {
    totalTimeoutMs: 360_000,
    agentTimeoutMs: 90_000,
    moaTimeoutMs: 60_000,
    verificationTimeoutMs: 20_000,
    maxRounds: 3,
    convergenceThreshold: "0.6900",
    varianceThreshold: "0.0500",
  },
);
assert.equal(parseDmadRunTestMaxRounds(undefined, 3), 3);
assert.equal(parseDmadRunTestMaxRounds("", 3), 3);
assert.equal(parseDmadRunTestMaxRounds(undefined), 3);
assert.equal(parseDmadRunTestMaxRounds("2", 3), 2);
assert.equal(parseDmadRunTestMaxRounds("0", 3), 3);
assert.equal(parseDmadRunTestMaxRounds("-1", 3), 3);
assert.equal(parseDmadRunTestMaxRounds("11", 3), 3);
assert.equal(parseDmadRunTestMaxRounds("abc", 3), 3);
assert.equal(parseDmadRunTestConvergenceThreshold(undefined, 0.7), 0.7);
assert.equal(parseDmadRunTestConvergenceThreshold("", 0.7), 0.7);
assert.equal(parseDmadRunTestConvergenceThreshold(undefined), 0.69);
assert.equal(parseDmadRunTestConvergenceThreshold("0.62", 0.7), 0.62);
assert.equal(parseDmadRunTestConvergenceThreshold("0", 0.7), 0.7);
assert.equal(parseDmadRunTestConvergenceThreshold("1", 0.7), 0.7);
assert.equal(parseDmadRunTestConvergenceThreshold("-0.2", 0.7), 0.7);
assert.equal(parseDmadRunTestConvergenceThreshold("bad", 0.7), 0.7);
assert.equal(parseDmadRunTestVarianceThreshold(undefined, 0.05), 0.05);
assert.equal(parseDmadRunTestVarianceThreshold("", 0.05), 0.05);
assert.equal(parseDmadRunTestVarianceThreshold(undefined), 0.05);
assert.equal(parseDmadRunTestVarianceThreshold("0.3", 0.05), 0.3);
assert.equal(parseDmadRunTestVarianceThreshold("0", 0.05), 0.05);
assert.equal(parseDmadRunTestVarianceThreshold("1", 0.05), 0.05);
assert.equal(parseDmadRunTestVarianceThreshold("-0.1", 0.05), 0.05);
assert.equal(parseDmadRunTestVarianceThreshold("bad", 0.05), 0.05);

const timeoutReport = buildDmadRunTimeoutReport({
  task: "timeout smoke",
  startedAt: "2026-05-20T00:00:00.000Z",
  completedAt: "2026-05-20T00:00:01.000Z",
  durationMs: 1000,
  totalTimeoutMs: 500,
  aborted: true,
  activePhase: "runDMAD",
  activeAgents: [{ agent: "codex", phase: "agent", round: 1, startedAt: "2026-05-20T00:00:00Z" }],
  latestProgress: {
    phase: "agent",
    status: "start",
    agent: "codex",
    round: 1,
    at: "2026-05-20T00:00:00Z",
  },
  phaseTimingsMs: { runDMAD: 1000, total: 1000 },
});
assert.equal(timeoutReport.ok, false);
assert.equal(timeoutReport.runStatus, "timeout");
assert.equal(timeoutReport.qualityStatus, "degraded_agents");
assert.equal(timeoutReport.degradedReason, "run_timeout");
assert.equal(timeoutReport.stoppedBy, "timeout");
assert.equal(timeoutReport.totalTimeoutMs, 500);
assert.equal(timeoutReport.durationMs, 1000);
assert.equal(timeoutReport.aborted, true);
assert.equal(timeoutReport.timeoutPhase, "runDMAD");
assert.deepEqual(timeoutReport.activeAgents, [
  { agent: "codex", phase: "agent", round: 1, startedAt: "2026-05-20T00:00:00Z" },
]);
assert.deepEqual(timeoutReport.phaseTimingsMs, { runDMAD: 1000, total: 1000 });
assert.deepEqual(timeoutReport.rounds, []);
const timeoutRunConfig = {
  totalTimeoutMs: 500,
  agentTimeoutMs: 90000,
  moaTimeoutMs: 60000,
  verificationTimeoutMs: 20000,
  maxRounds: 3,
  convergenceThreshold: "0.6900",
  varianceThreshold: "0.0500",
};
const timeoutStdout = buildDmadRunTimeoutStdoutSummary(timeoutReport, true, timeoutRunConfig);
assert.deepEqual(Object.keys(timeoutStdout), [
  "ok",
  "failOnDegraded",
  "runConfig",
  "runStatus",
  "qualityStatus",
  "degradedReason",
  "durationMs",
  "totalTimeoutMs",
  "aborted",
  "timeoutPhase",
  "activeAgents",
  "latestProgress",
  "phaseTimingsMs",
]);
assert.equal(timeoutStdout.ok, false);
assert.equal(timeoutStdout.failOnDegraded, true);
assert.deepEqual(timeoutStdout.runConfig, timeoutRunConfig);
assert.equal(timeoutStdout.totalTimeoutMs, 500);
assert.equal(timeoutStdout.timeoutPhase, "runDMAD");
const successStdout = buildDmadRunSuccessStdoutSummary(
  {
    qualityStatus: "pass",
    degradedReason: null,
    totalRounds: 2,
    stoppedBy: "variance",
    convergenceScore: 0.7321,
    stabilityScores: [0, 0.91],
    hadCliError: false,
    cliErrorSummary: {
      claudeMissing: 0,
      claudeFailed: 0,
      codexMissing: 0,
      codexFailed: 0,
    },
    patternSlugsUsed: ["strict-cto", "pragmatic-engineer"],
    trajectoryScores: {
      claude: 1.25,
      codex: 1.1,
      openclaw: 1.3,
    },
    phaseTimingsMs: { round1: 1000, round2: 1100, total: 2100 },
    roundTimingsMs: [{ total: 1000 }, { total: 1100 }],
  },
  false,
  timeoutRunConfig,
  {
    phase: "finalize",
    status: "complete",
    at: "2026-05-20T00:00:04Z",
  },
  2100,
);
assert.deepEqual(Object.keys(successStdout), [
  "ok",
  "failOnDegraded",
  "runConfig",
  "qualityStatus",
  "degradedReason",
  "rounds",
  "stoppedBy",
  "convergenceScore",
  "stabilityScores",
  "hadCliError",
  "cliErrorSummary",
  "patternsUsed",
  "trajectoryScores",
  "phaseTimingsMs",
  "roundTimingsMs",
  "latestProgress",
  "durationMs",
]);
assert.equal(successStdout.ok, true);
assert.equal(successStdout.failOnDegraded, false);
assert.equal(successStdout.rounds, 2);
assert.equal(successStdout.stoppedBy, "variance");
assert.deepEqual(successStdout.runConfig, timeoutRunConfig);
assert.equal(successStdout.durationMs, 2100);
assert.equal(successStdout.latestProgress?.phase, "finalize");
const mergedReport = buildDmadRunReportWithConfig({ marker: "ok", ok: true }, timeoutRunConfig);
assert.equal(mergedReport.marker, "ok");
assert.deepEqual(mergedReport.runConfig, timeoutRunConfig);
const canonicalReport = buildDmadRunReportWithConfig(
  {
    marker: "stale-run-config",
    ok: true,
    runConfig: { stale: true },
  },
  timeoutRunConfig,
);
assert.deepEqual(canonicalReport.runConfig, timeoutRunConfig);

const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), "dmad-run-test-"));
try {
  const reportPath = path.join(reportDir, "timeout-report.json");
  const nestedReportPath = path.join(reportDir, "nested", "reports", "timeout-report.json");
  const timeoutConsistencyPath = path.join(reportDir, "timeout-report-consistency.json");
  const successConsistencyPath = path.join(reportDir, "success-report-consistency.json");
  const report = buildDmadRunTimeoutReport({
    task: "timeout report roundtrip",
    startedAt: "2026-05-20T00:00:00.000Z",
    completedAt: "2026-05-20T00:00:02.500Z",
    durationMs: 2500,
    totalTimeoutMs: 2000,
    aborted: true,
    activePhase: "agent",
    activeAgents: [
      {
        agent: "codex",
        phase: "agent",
        round: 3,
        startedAt: "2026-05-20T00:00:01Z",
      },
    ],
    latestProgress: {
      phase: "agent",
      status: "start",
      agent: "codex",
      round: 3,
      at: "2026-05-20T00:00:01Z",
    },
    phaseTimingsMs: { "round3.claude": 1100, total: 2500 },
  });
  const reportWithConfig = buildDmadRunReportWithConfig(report, {
    totalTimeoutMs: 2000,
    agentTimeoutMs: 90000,
    moaTimeoutMs: 60000,
    verificationTimeoutMs: 20000,
    maxRounds: 3,
    convergenceThreshold: "0.6900",
    varianceThreshold: "0.0500",
  });
  writeDmadRunReport(reportWithConfig, reportPath);
  const saved = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  writeDmadRunReport({ ok: true, marker: "nested" }, nestedReportPath);
  const nestedSaved = JSON.parse(fs.readFileSync(nestedReportPath, "utf8"));
  assert.deepEqual(nestedSaved, { ok: true, marker: "nested" });
  assert.equal(saved.aborted, true);
  assert.equal(saved.timeoutPhase, "agent");
  assert.deepEqual(saved.activeAgents, [
    {
      agent: "codex",
      phase: "agent",
      round: 3,
      startedAt: "2026-05-20T00:00:01Z",
    },
  ]);
  assert.equal(saved.latestProgress.agent, "codex");
  assert.equal(saved.latestProgress.round, 3);
  assert.equal(saved.phaseTimingsMs["round3.claude"], 1100);
  assert.equal(saved.phaseTimingsMs.total, 2500);
  assert.deepEqual(saved.runConfig, {
    totalTimeoutMs: 2000,
    agentTimeoutMs: 90000,
    moaTimeoutMs: 60000,
    verificationTimeoutMs: 20000,
    maxRounds: 3,
    convergenceThreshold: "0.6900",
    varianceThreshold: "0.0500",
  });

  // timeout 路徑：stdout/runConfig 與 report/runConfig 一致
  writeDmadRunReport({ ...timeoutReport, runConfig: timeoutRunConfig }, timeoutConsistencyPath);
  const timeoutSaved = JSON.parse(fs.readFileSync(timeoutConsistencyPath, "utf8"));
  assert.deepEqual(timeoutSaved.runConfig, timeoutStdout.runConfig);
  assert.equal(timeoutSaved.runStatus, timeoutStdout.runStatus);
  assert.equal(timeoutSaved.qualityStatus, timeoutStdout.qualityStatus);
  assert.equal(timeoutSaved.degradedReason, timeoutStdout.degradedReason);
  assert.equal(timeoutSaved.durationMs, timeoutStdout.durationMs);
  assert.equal(timeoutSaved.totalTimeoutMs, timeoutStdout.totalTimeoutMs);
  assert.equal(timeoutSaved.aborted, timeoutStdout.aborted);
  assert.equal(timeoutSaved.timeoutPhase, timeoutStdout.timeoutPhase);
  assert.deepEqual(timeoutSaved.activeAgents, timeoutStdout.activeAgents);
  assert.deepEqual(timeoutSaved.latestProgress, timeoutStdout.latestProgress);
  assert.deepEqual(timeoutSaved.phaseTimingsMs, timeoutStdout.phaseTimingsMs);

  // success 路徑：stdout/runConfig 與 report/runConfig 一致
  const successReport = {
    ok: true,
    runStatus: "completed",
    task: "success report consistency",
    rounds: [],
    finalAnswer: "",
    convergenceScore: successStdout.convergenceScore,
    totalRounds: successStdout.rounds,
    stoppedBy: successStdout.stoppedBy,
    patternSlugsUsed: successStdout.patternsUsed,
    hadCliError: successStdout.hadCliError,
    cliErrorSummary: successStdout.cliErrorSummary,
    qualityStatus: successStdout.qualityStatus,
    degradedReason: successStdout.degradedReason,
    trajectoryScores: successStdout.trajectoryScores,
    estimatedCostUsd: 0,
    phaseTimingsMs: successStdout.phaseTimingsMs,
    runConfig: successStdout.runConfig,
  };
  writeDmadRunReport(successReport, successConsistencyPath);
  const successSaved = JSON.parse(fs.readFileSync(successConsistencyPath, "utf8"));
  assert.deepEqual(successSaved.runConfig, successStdout.runConfig);
  assert.equal(successSaved.totalRounds, successStdout.rounds);
  assert.equal(successSaved.stoppedBy, successStdout.stoppedBy);
  assert.equal(successSaved.convergenceScore, successStdout.convergenceScore);
  assert.equal(successSaved.qualityStatus, successStdout.qualityStatus);
  assert.equal(successSaved.degradedReason, successStdout.degradedReason);
  assert.equal(successSaved.hadCliError, successStdout.hadCliError);
  assert.deepEqual(successSaved.cliErrorSummary, successStdout.cliErrorSummary);
  assert.deepEqual(successSaved.patternSlugsUsed, successStdout.patternsUsed);
  assert.deepEqual(successSaved.trajectoryScores, successStdout.trajectoryScores);
  assert.deepEqual(successSaved.phaseTimingsMs, successStdout.phaseTimingsMs);
} finally {
  fs.rmSync(reportDir, { recursive: true, force: true });
}

const tracker = createDmadRunProgressTracker();
tracker.onProgress({
  phase: "agent",
  status: "start",
  agent: "claude",
  round: 2,
  at: "2026-05-20T00:00:02Z",
});
assert.equal(tracker.snapshot(25).activePhase, "agent");
assert.deepEqual(tracker.snapshot(25).activeAgents, [
  { agent: "claude", phase: "agent", round: 2, startedAt: "2026-05-20T00:00:02Z" },
]);
tracker.onProgress({
  phase: "agent",
  status: "complete",
  agent: "claude",
  round: 2,
  at: "2026-05-20T00:00:03Z",
  durationMs: 1000,
});
assert.equal(tracker.snapshot(1000).activeAgents.length, 0);
assert.equal(tracker.snapshot(1000).phaseTimingsMs["round2.claude"], 1000);

const multiAgentTracker = createDmadRunProgressTracker();
multiAgentTracker.onProgress({
  phase: "agent",
  status: "start",
  agent: "claude",
  round: 3,
  at: "2026-05-20T00:00:04Z",
});
multiAgentTracker.onProgress({
  phase: "agent",
  status: "start",
  agent: "codex",
  round: 3,
  at: "2026-05-20T00:00:05Z",
});
const multiAgentActiveSnapshot = multiAgentTracker.snapshot(50);
assert.equal(multiAgentActiveSnapshot.activePhase, "agent");
assert.deepEqual(multiAgentActiveSnapshot.activeAgents, [
  { agent: "claude", phase: "agent", round: 3, startedAt: "2026-05-20T00:00:04Z" },
  { agent: "codex", phase: "agent", round: 3, startedAt: "2026-05-20T00:00:05Z" },
]);
assert.equal(multiAgentActiveSnapshot.latestProgress?.agent, "codex");
assert.equal(multiAgentActiveSnapshot.latestProgress?.status, "start");
multiAgentTracker.onProgress({
  phase: "agent",
  status: "complete",
  agent: "claude",
  round: 3,
  at: "2026-05-20T00:00:06Z",
  durationMs: 1200,
});
const multiAgentPartialSnapshot = multiAgentTracker.snapshot(1250);
assert.equal(multiAgentPartialSnapshot.activePhase, "agent");
assert.deepEqual(multiAgentPartialSnapshot.activeAgents, [
  { agent: "codex", phase: "agent", round: 3, startedAt: "2026-05-20T00:00:05Z" },
]);
assert.equal(multiAgentPartialSnapshot.latestProgress?.agent, "claude");
assert.equal(multiAgentPartialSnapshot.latestProgress?.status, "complete");
assert.equal(multiAgentPartialSnapshot.phaseTimingsMs["round3.claude"], 1200);
multiAgentTracker.onProgress({
  phase: "agent",
  status: "complete",
  agent: "codex",
  round: 3,
  at: "2026-05-20T00:00:07Z",
  durationMs: 1500,
});
const multiAgentCompleteSnapshot = multiAgentTracker.snapshot(2700);
assert.equal(multiAgentCompleteSnapshot.activePhase, "runDMAD");
assert.deepEqual(multiAgentCompleteSnapshot.activeAgents, []);
assert.equal(multiAgentCompleteSnapshot.latestProgress?.agent, "codex");
assert.equal(multiAgentCompleteSnapshot.latestProgress?.status, "complete");
assert.equal(multiAgentCompleteSnapshot.phaseTimingsMs["round3.codex"], 1500);

const nonAgentTracker = createDmadRunProgressTracker();
nonAgentTracker.onProgress({
  phase: "moa",
  status: "start",
  at: "2026-05-20T00:00:08Z",
});
const moaStartSnapshot = nonAgentTracker.snapshot(10);
assert.equal(moaStartSnapshot.activePhase, "moa");
assert.deepEqual(moaStartSnapshot.activeAgents, []);
assert.equal(moaStartSnapshot.latestProgress?.phase, "moa");
assert.equal(moaStartSnapshot.latestProgress?.status, "start");
nonAgentTracker.onProgress({
  phase: "moa",
  status: "complete",
  at: "2026-05-20T00:00:10Z",
  durationMs: 2000,
});
const moaCompleteSnapshot = nonAgentTracker.snapshot(2010);
assert.equal(moaCompleteSnapshot.activePhase, "runDMAD");
assert.equal(moaCompleteSnapshot.latestProgress?.phase, "moa");
assert.equal(moaCompleteSnapshot.latestProgress?.status, "complete");
assert.equal(moaCompleteSnapshot.phaseTimingsMs.moa, 2000);
nonAgentTracker.onProgress({
  phase: "verification",
  status: "error",
  at: "2026-05-20T00:00:11Z",
  durationMs: 300,
});
const verificationErrorSnapshot = nonAgentTracker.snapshot(2310);
assert.equal(verificationErrorSnapshot.activePhase, "verification");
assert.deepEqual(verificationErrorSnapshot.activeAgents, []);
assert.equal(verificationErrorSnapshot.latestProgress?.phase, "verification");
assert.equal(verificationErrorSnapshot.latestProgress?.status, "error");
assert.equal(verificationErrorSnapshot.phaseTimingsMs.verification, 300);

const timeoutErrorPositiveCases = [
  {
    name: "direct DmadRunTestTimeoutError constructor",
    err: new DmadRunTestTimeoutError(12_345),
    totalTimeoutMs: 12_345,
  },
] as const;

for (const c of timeoutErrorPositiveCases) {
  assert.equal(isDmadRunTestTimeoutError(c.err, c.totalTimeoutMs), true, c.name);
}

const timeoutErrorNegativeCases = [
  {
    name: "generic Error with matching message",
    err: new Error("DMAD run-test exceeded total timeout 12345ms"),
    totalTimeoutMs: 12_345,
  },
  {
    name: "wrong totalTimeoutMs",
    err: new DmadRunTestTimeoutError(1),
    totalTimeoutMs: 0,
  },
  {
    name: "null input",
    err: null,
    totalTimeoutMs: 0,
  },
  {
    name: "string input",
    err: "DMAD run-test exceeded total timeout 0ms",
    totalTimeoutMs: 0,
  },
  {
    name: "plain object shape match",
    err: {
      name: "DmadRunTestTimeoutError",
      message: "DMAD run-test exceeded total timeout 0ms",
      totalTimeoutMs: 0,
    },
    totalTimeoutMs: 0,
  },
] as const;

for (const c of timeoutErrorNegativeCases) {
  assert.equal(isDmadRunTestTimeoutError(c.err, c.totalTimeoutMs), false, c.name);
}

let successTimeoutCallbackCount = 0;
const timeoutWrappedValue = await withDmadRunTimeout(Promise.resolve("resolved"), 1000, () => {
  successTimeoutCallbackCount += 1;
});
assert.equal(timeoutWrappedValue, "resolved");
assert.equal(successTimeoutCallbackCount, 0);

let zeroTimeoutCallbackCount = 0;
const zeroTimeoutRejection = withDmadRunTimeout(Promise.resolve("ignored"), 0, () => {
  zeroTimeoutCallbackCount += 1;
});
assert.equal(zeroTimeoutCallbackCount, 1);
await assert.rejects(zeroTimeoutRejection, (err) => isDmadRunTestTimeoutError(err, 0));

let rejectedPromiseTimeoutCallbackCount = 0;
const originalRejection = new Error("original rejection");
await assert.rejects(
  withDmadRunTimeout(Promise.reject(originalRejection), 1000, () => {
    rejectedPromiseTimeoutCallbackCount += 1;
  }),
  (err) => err === originalRejection,
);
assert.equal(rejectedPromiseTimeoutCallbackCount, 0);

let timeoutCallbackCount = 0;
await assert.rejects(
  withDmadRunTimeout(
    new Promise(() => {
      /* never resolves */
    }),
    1,
    () => {
      timeoutCallbackCount += 1;
    },
  ),
  (err) => isDmadRunTestTimeoutError(err, 1),
);
assert.equal(timeoutCallbackCount, 1);

console.log("[dmad-run-test-self-test] PASS");
