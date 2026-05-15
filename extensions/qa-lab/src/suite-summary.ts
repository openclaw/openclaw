import type { GatewayLogSentinelFinding } from "./gateway-log-sentinel.js";
import type { QaProviderMode } from "./model-selection.js";
import type { RuntimeId, RuntimeParityResult } from "./runtime-parity.js";
import type { QaCodexToolLoading } from "./runtime-tool-metadata.js";

type QaSuiteSummaryScenario = {
  name: string;
  status: "pass" | "fail" | "skip";
  steps: unknown[];
  details?: string;
  runtimeParity?: RuntimeParityResult;
  gatewayLogSentinels?: GatewayLogSentinelFinding[];
};

export type QaSuiteSummaryJson = {
  scenarios: QaSuiteSummaryScenario[];
  counts: {
    total: number;
    passed: number;
    skipped: number;
    failed: number;
  };
  metrics?: {
    wallMs: number;
    gatewayProcessCpuMs?: number | null;
    gatewayCpuCoreRatio?: number | null;
    gatewayProcessRssStartBytes?: number | null;
    gatewayProcessRssEndBytes?: number | null;
    gatewayProcessRssDeltaBytes?: number | null;
  };
  gatewayLogSentinels?: GatewayLogSentinelFinding[];
  run: {
    startedAt: string;
    finishedAt: string;
    providerMode: QaProviderMode;
    primaryModel: string;
    primaryProvider: string | null;
    primaryModelName: string | null;
    alternateModel: string;
    alternateProvider: string | null;
    alternateModelName: string | null;
    fastMode: boolean;
    concurrency: number;
    scenarioIds: string[] | null;
    runtimePair?: [RuntimeId, RuntimeId] | null;
    codexToolLoading?: QaCodexToolLoading | null;
  };
};

type QaSuiteScenarioStatus = Pick<QaSuiteSummaryScenario, "status">;

export function countQaSuiteFailedScenarios(
  scenarios: ReadonlyArray<QaSuiteScenarioStatus>,
): number {
  let failed = 0;
  for (const scenario of scenarios) {
    if (scenario.status === "fail") {
      failed += 1;
    }
  }
  return failed;
}

export function countQaSuiteSkippedScenarios(
  scenarios: ReadonlyArray<QaSuiteScenarioStatus>,
): number {
  let skipped = 0;
  for (const scenario of scenarios) {
    if (scenario.status === "skip") {
      skipped += 1;
    }
  }
  return skipped;
}

export function readQaSuiteFailedScenarioCountFromSummary(summary: unknown): number | null {
  if (!summary || typeof summary !== "object") {
    return null;
  }
  const payload = summary as {
    counts?: {
      failed?: unknown;
    };
    scenarios?: Array<QaSuiteScenarioStatus>;
  };
  if (typeof payload.counts?.failed === "number" && Number.isFinite(payload.counts.failed)) {
    return Math.max(0, Math.floor(payload.counts.failed));
  }
  if (Array.isArray(payload.scenarios)) {
    return countQaSuiteFailedScenarios(payload.scenarios);
  }
  return null;
}
