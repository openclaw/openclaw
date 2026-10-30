import { vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import type { QaLabServerHandle } from "./lab-server.types.js";
import type { RuntimeParityCell } from "./runtime-parity.js";
import { recordQaSuiteTestResults } from "./suite-test-helpers.js";
import type { QaSuiteRunParams } from "./suite-types.js";

export const artifactPaths = {
  evidencePath: "/qa-output/qa-evidence.json",
  reportPath: "/qa-output/qa-suite-report.md",
  summaryPath: "/qa-output/qa-suite-summary.json",
  report: "",
};
export function createTestLab(overrides: Partial<QaLabServerHandle> = {}): QaLabServerHandle {
  return {
    baseUrl: "http://127.0.0.1:43123",
    listenUrl: "http://127.0.0.1:43123",
    state: createQaBusState(),
    setControlUi: vi.fn(),
    setScenarioRun: vi.fn(),
    setLatestReport: vi.fn(),
    runSelfCheck: vi.fn(),
    stop: vi.fn(async () => {}),
    ...overrides,
  };
}
export function runtimeCell(
  runtime: RuntimeParityCell["runtime"],
  wallClockMs = 1,
): RuntimeParityCell {
  return {
    runtime,
    wallClockMs,
    transcriptBytes: "",
    toolCalls: [],
    finalText: "ok",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    bootStateLines: [],
  };
}
export function childResult(
  params: QaSuiteRunParams | undefined,
  scenarios: Parameters<typeof recordQaSuiteTestResults>[1],
  outputDir: string,
) {
  return {
    ...artifactPaths,
    evidencePath: `${outputDir}/qa-evidence.json`,
    reportPath: `${outputDir}/qa-suite-report.md`,
    summaryPath: `${outputDir}/qa-suite-summary.json`,
    outputDir,
    watchUrl: "http://127.0.0.1:43123",
    ...recordQaSuiteTestResults(
      params,
      scenarios,
      scenarios.map(({ title }) => ({
        name: title,
        status: "pass",
        steps: [],
      })),
    ),
    startedScenarioIds: scenarios.map(({ id }) => id),
    runtimeParityCell: runtimeCell(params?.forcedRuntime ?? "openclaw"),
  };
}
