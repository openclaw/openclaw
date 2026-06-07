// Qa Lab plugin module implements suite summary behavior.
import fs from "node:fs/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { QaProviderMode } from "./model-selection.js";
import type { RuntimeId, RuntimeParityResult } from "./runtime-parity.js";

type QaSuiteSummaryScenario = {
  name: string;
  status: "pass" | "fail";
  steps: unknown[];
  details?: string;
  runtimeParity?: RuntimeParityResult;
};

export type QaSuiteSummaryJson = {
  scenarios: QaSuiteSummaryScenario[];
  counts: {
    total: number;
    passed: number;
    failed: number;
  };
  metrics?: {
    wallMs: number;
    gatewayProcessCpuMs?: number | null;
    gatewayCpuCoreRatio?: number | null;
    gatewayProcessRssStartBytes?: number | null;
    gatewayProcessRssEndBytes?: number | null;
    gatewayProcessRssDeltaBytes?: number | null;
    gatewayProcessRssPeakBytes?: number | null;
    gatewayProcessRssPeakDeltaBytes?: number | null;
    gatewayProcessRssSamples?: Array<{
      label: string;
      at: string;
      gatewayProcessRssBytes: number;
    }>;
    gatewayHeapSnapshots?: Array<{
      label: string;
      at: string;
      path: string;
      bytes: number;
    }>;
  };
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
  const countedFailures =
    typeof payload.counts?.failed === "number" && Number.isFinite(payload.counts.failed)
      ? Math.max(0, Math.floor(payload.counts.failed))
      : null;
  const scenarioFailures = Array.isArray(payload.scenarios)
    ? countQaSuiteFailedScenarios(payload.scenarios)
    : null;
  if (countedFailures !== null && scenarioFailures !== null) {
    return Math.max(countedFailures, scenarioFailures);
  }
  if (scenarioFailures !== null) {
    return scenarioFailures;
  }
  return countedFailures;
}

export async function readQaSuiteFailedScenarioCountFromFile(summaryPath: string): Promise<number> {
  let summaryText: string;
  try {
    summaryText = await fs.readFile(summaryPath, "utf8");
  } catch (error) {
    throw new Error(
      `Could not read QA summary JSON at ${summaryPath}: ${formatErrorMessage(error)}`,
      { cause: error },
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(summaryText) as unknown;
  } catch (error) {
    throw new Error(
      `Could not parse QA summary JSON at ${summaryPath}: ${formatErrorMessage(error)}`,
      { cause: error },
    );
  }
  const failedScenarioCount = readQaSuiteFailedScenarioCountFromSummary(payload);
  if (failedScenarioCount !== null) {
    return failedScenarioCount;
  }
  throw new Error(
    `QA summary at ${summaryPath} did not include counts.failed or scenarios[].status.`,
  );
}
