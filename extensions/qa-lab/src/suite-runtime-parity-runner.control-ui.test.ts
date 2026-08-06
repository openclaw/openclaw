import { beforeEach, describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import type { QaLabServerHandle } from "./lab-server.types.js";
import { runQaFlowSuiteFromRuntime } from "./suite-run.runtime.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";
import type { QaSuiteResolvedRunContext, QaSuiteRunParams } from "./suite-types.js";

const mocks = vi.hoisted(() => ({
  readQaBootstrapScenarioCatalog: vi.fn(),
  runQaFlowSuiteStandard: vi.fn(),
  writeQaSuiteArtifacts: vi.fn(),
}));

vi.mock("./scenario-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./scenario-catalog.js")>()),
  readQaBootstrapScenarioCatalog: mocks.readQaBootstrapScenarioCatalog,
}));

vi.mock("./suite-planning.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./suite-planning.js")>()),
  resolveQaSuiteOutputDir: vi.fn(
    async (_repoRoot: string, outputDir?: string) => outputDir ?? "/qa-output",
  ),
}));

vi.mock("./suite-run-standard.js", () => ({
  runQaFlowSuiteStandard: mocks.runQaFlowSuiteStandard,
}));

vi.mock("./suite-artifacts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./suite-artifacts.js")>()),
  writeQaSuiteArtifacts: mocks.writeQaSuiteArtifacts,
}));

function createControlUiTestLab(): QaLabServerHandle {
  return {
    baseUrl: "http://127.0.0.1:43123",
    listenUrl: "http://127.0.0.1:43123",
    state: createQaBusState(),
    setControlUi: vi.fn(),
    setScenarioRun: vi.fn(),
    setLatestReport: vi.fn(),
    runSelfCheck: vi.fn(),
    stop: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readQaBootstrapScenarioCatalog.mockReturnValue({
    scenarios: [
      makeQaSuiteTestScenario("runtime-channel", { surface: "channel" }),
      makeQaSuiteTestScenario("runtime-control-ui", { surface: "control-ui" }),
    ],
  });
  mocks.runQaFlowSuiteStandard.mockImplementation(
    async (params: QaSuiteRunParams | undefined, context: QaSuiteResolvedRunContext) => ({
      outputDir: context.outputDir,
      evidencePath: "/qa-output/qa-evidence.json",
      reportPath: "/qa-output/qa-suite-report.md",
      summaryPath: "/qa-output/qa-suite-summary.json",
      report: "",
      scenarios: [{ name: context.selectedScenarios[0]?.title, status: "pass", steps: [] }],
      startedScenarioIds: context.selectedScenarios.map((scenario) => scenario.id),
      watchUrl: "http://127.0.0.1:43123",
      runtimeParityCell: {
        runtime: params?.forcedRuntime ?? "openclaw",
        transcriptBytes: "",
        toolCalls: [],
        finalText: "ok",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        wallClockMs: 1,
        bootStateLines: [],
      },
    }),
  );
  mocks.writeQaSuiteArtifacts.mockResolvedValue({
    evidence: undefined,
    evidencePath: "/qa-output/qa-evidence.json",
    report: "",
    reportPath: "/qa-output/qa-suite-report.md",
    summaryPath: "/qa-output/qa-suite-summary.json",
  });
});

describe("runtime parity Control UI ownership", () => {
  it("keeps checkpoint ownership at the logical runtime-parity scenario", async () => {
    const lab = createControlUiTestLab();
    const profileCheckpoint = {
      start: vi.fn(async () => {}),
      complete: vi.fn(async () => {}),
    };
    mocks.writeQaSuiteArtifacts.mockResolvedValueOnce({
      evidence: {
        kind: "openclaw.qa.evidence-summary",
        schemaVersion: 2,
        generatedAt: "2026-08-06T00:00:00.000Z",
        evidenceMode: "full",
        entries: [],
      },
      evidencePath: "/qa-output/qa-evidence.json",
      report: "",
      reportPath: "/qa-output/qa-suite-report.md",
      summaryPath: "/qa-output/qa-suite-summary.json",
    });

    await runQaFlowSuiteFromRuntime({
      repoRoot: "/qa-repo",
      outputDir: "/qa-output",
      providerMode: "mock-openai",
      scenarioIds: ["runtime-channel"],
      runtimePair: ["openclaw", "codex"],
      lab,
      startLab: async () => lab,
      profileCheckpoint,
    });

    expect(profileCheckpoint.start).toHaveBeenCalledOnce();
    expect(profileCheckpoint.complete).toHaveBeenCalledOnce();
    expect(
      mocks.runQaFlowSuiteStandard.mock.calls.every(([params]) => !params.profileCheckpoint),
    ).toBe(true);
  });

  it("persists the first parity result before a later start interruption", async () => {
    const lab = createControlUiTestLab();
    const interruption = new Error("interrupted after first parity cell");
    const profileCheckpoint = {
      start: vi.fn(async (scenarioId: string) => {
        if (scenarioId === "runtime-control-ui") {
          throw interruption;
        }
      }),
      complete: vi.fn(async () => {}),
    };

    await expect(
      runQaFlowSuiteFromRuntime({
        repoRoot: "/qa-repo",
        outputDir: "/qa-output",
        providerMode: "mock-openai",
        scenarioIds: ["runtime-channel", "runtime-control-ui"],
        runtimePair: ["openclaw", "codex"],
        concurrency: 1,
        lab,
        startLab: async () => lab,
        profileCheckpoint,
      }),
    ).rejects.toBe(interruption);

    expect(mocks.runQaFlowSuiteStandard).toHaveBeenCalledTimes(2);
    expect(profileCheckpoint.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        scenarioId: "runtime-channel",
        evidence: expect.objectContaining({
          entries: [
            expect.objectContaining({
              test: expect.objectContaining({ id: "runtime-channel" }),
              result: expect.objectContaining({ status: "pass" }),
            }),
          ],
        }),
        result: "pass",
      }),
    );
    expect(mocks.writeQaSuiteArtifacts).not.toHaveBeenCalled();
    expect(
      mocks.runQaFlowSuiteStandard.mock.calls.every(([params]) => !params.profileCheckpoint),
    ).toBe(true);
  });

  it("persists a terminal failed parity result returned by a runtime cell", async () => {
    const lab = createControlUiTestLab();
    const profileCheckpoint = {
      start: vi.fn(async () => {}),
      complete: vi.fn(async () => {}),
    };
    mocks.runQaFlowSuiteStandard.mockImplementationOnce(
      async (params: QaSuiteRunParams | undefined, context: QaSuiteResolvedRunContext) => ({
        outputDir: context.outputDir,
        evidencePath: "/qa-output/qa-evidence.json",
        reportPath: "/qa-output/qa-suite-report.md",
        summaryPath: "/qa-output/qa-suite-summary.json",
        report: "",
        scenarios: [
          {
            name: context.selectedScenarios[0]?.title,
            status: "fail",
            details: "runtime scenario failed",
            steps: [],
          },
        ],
        startedScenarioIds: context.selectedScenarios.map((scenario) => scenario.id),
        watchUrl: "http://127.0.0.1:43123",
        runtimeParityCell: {
          runtime: params?.forcedRuntime ?? "openclaw",
          transcriptBytes: "",
          toolCalls: [],
          finalText: "",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          wallClockMs: 1,
          runtimeErrorClass: "scenario-failure",
          bootStateLines: [],
        },
      }),
    );

    const result = await runQaFlowSuiteFromRuntime({
      repoRoot: "/qa-repo",
      outputDir: "/qa-output",
      providerMode: "mock-openai",
      scenarioIds: ["runtime-channel"],
      runtimePair: ["openclaw", "codex"],
      lab,
      startLab: async () => lab,
      profileCheckpoint,
    });

    expect(result.scenarios).toMatchObject([{ status: "fail" }]);
    expect(profileCheckpoint.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        scenarioId: "runtime-channel",
        evidence: expect.objectContaining({
          entries: [
            expect.objectContaining({
              test: expect.objectContaining({ id: "runtime-channel" }),
              result: expect.objectContaining({ status: "fail" }),
            }),
          ],
        }),
        result: "fail",
      }),
    );
  });

  it.each([
    {
      label: "a non-Control UI scenario by default",
      scenarioId: "runtime-channel",
      explicit: undefined,
      enabled: false,
    },
    {
      label: "an interactive non-Control UI scenario",
      scenarioId: "runtime-channel",
      explicit: true,
      enabled: true,
    },
    {
      label: "an explicitly disabled non-Control UI scenario",
      scenarioId: "runtime-channel",
      explicit: false,
      enabled: false,
    },
    {
      label: "a Control UI scenario by default",
      scenarioId: "runtime-control-ui",
      explicit: undefined,
      enabled: true,
    },
    {
      label: "an explicitly disabled Control UI scenario",
      scenarioId: "runtime-control-ui",
      explicit: false,
      enabled: false,
    },
  ])("preserves Control UI policy in both runtime cells for $label", async (testCase) => {
    const lab = createControlUiTestLab();

    await runQaFlowSuiteFromRuntime({
      repoRoot: "/qa-repo",
      outputDir: "/qa-output",
      providerMode: "mock-openai",
      scenarioIds: [testCase.scenarioId],
      runtimePair: ["openclaw", "codex"],
      lab,
      startLab: async () => lab,
      ...(testCase.explicit === undefined ? {} : { controlUiEnabled: testCase.explicit }),
    });

    expect(
      mocks.runQaFlowSuiteStandard.mock.calls.map(([params]) => ({
        runtime: params.forcedRuntime,
        controlUiEnabled: params.controlUiEnabled,
      })),
    ).toEqual([
      { runtime: "openclaw", controlUiEnabled: testCase.enabled },
      { runtime: "codex", controlUiEnabled: testCase.enabled },
    ]);
  });
});
