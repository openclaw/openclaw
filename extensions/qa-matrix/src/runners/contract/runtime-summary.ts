import type { QaReportCheck } from "openclaw/plugin-sdk/qa-runtime";
import type { MatrixQaConfigSnapshot } from "../../substrate/config.js";
import type { MatrixQaDifferentialProbeResult } from "../../substrate/differential-probe.js";
import type { MatrixQaCanaryArtifact, MatrixQaScenarioArtifacts } from "./scenarios.js";

export type MatrixQaScenarioResult = {
  artifacts?: MatrixQaScenarioArtifacts;
  details: string;
  id: string;
  status: "fail" | "pass";
  title: string;
};

export type MatrixQaSummary = {
  checks: QaReportCheck[];
  config: {
    default: MatrixQaConfigSnapshot;
    scenarios: Array<{
      config: MatrixQaConfigSnapshot;
      id: string;
      title: string;
    }>;
  };
  counts: {
    failed: number;
    passed: number;
    total: number;
  };
  finishedAt: string;
  harness: {
    baseUrl: string;
    composeFile: string;
    dmRoomIds: string[];
    image: string;
    roomId: string;
    roomIds: string[];
    serverName: string;
  };
  canary?: MatrixQaCanaryArtifact;
  differentialProbe?: MatrixQaDifferentialProbeResult;
  observedEventCount: number;
  observedEventsPath: string;
  reportPath: string;
  routeStateManifestPath: string;
  scenarios: MatrixQaScenarioResult[];
  startedAt: string;
  summaryPath: string;
  sutAccountId: string;
  timings: MatrixQaTimings;
  userIds: {
    driver: string;
    observer: string;
    sut: string;
  };
};

export type MatrixQaArtifactPaths = {
  observedEvents: string;
  report: string;
  routeStateManifest: string;
  summary: string;
};

export type MatrixQaScenarioTiming = {
  durationMs: number;
  gatewayBootMs: number;
  gatewayRestartMs: number;
  id: string;
  title: string;
  transportInterruptMs: number;
};

type MatrixQaTimings = {
  artifactWriteMs: number;
  canaryMs?: number;
  harnessBootMs: number;
  initialGatewayBootMs: number;
  provisioningMs: number;
  scenarioGatewayBootMs: number;
  scenarioRestartGatewayMs: number;
  scenarioTransportInterruptMs: number;
  scenarios: MatrixQaScenarioTiming[];
  totalMs: number;
};

export type MatrixQaScenarioConfigEntry = MatrixQaSummary["config"]["scenarios"][number];

function countMatrixQaStatuses(entries: Array<{ status: "fail" | "pass" | "skip" }>) {
  return {
    failed: entries.filter((entry) => entry.status === "fail").length,
    passed: entries.filter((entry) => entry.status === "pass").length,
  };
}

export function buildMatrixQaSummary(params: {
  artifactPaths: MatrixQaArtifactPaths;
  canary?: MatrixQaCanaryArtifact;
  checks: QaReportCheck[];
  config: MatrixQaSummary["config"];
  differentialProbe?: MatrixQaDifferentialProbeResult;
  finishedAt: string;
  harness: MatrixQaSummary["harness"];
  observedEventCount: number;
  scenarios: MatrixQaScenarioResult[];
  startedAt: string;
  sutAccountId: string;
  timings: MatrixQaTimings;
  userIds: MatrixQaSummary["userIds"];
}): MatrixQaSummary {
  const checkCounts = countMatrixQaStatuses(params.checks);
  const scenarioCounts = countMatrixQaStatuses(params.scenarios);

  return {
    checks: params.checks,
    config: params.config,
    counts: {
      total: params.checks.length + params.scenarios.length,
      passed: checkCounts.passed + scenarioCounts.passed,
      failed: checkCounts.failed + scenarioCounts.failed,
    },
    finishedAt: params.finishedAt,
    harness: params.harness,
    canary: params.canary,
    differentialProbe: params.differentialProbe,
    observedEventCount: params.observedEventCount,
    observedEventsPath: params.artifactPaths.observedEvents,
    reportPath: params.artifactPaths.report,
    routeStateManifestPath: params.artifactPaths.routeStateManifest,
    scenarios: params.scenarios,
    startedAt: params.startedAt,
    summaryPath: params.artifactPaths.summary,
    sutAccountId: params.sutAccountId,
    timings: params.timings,
    userIds: params.userIds,
  };
}
