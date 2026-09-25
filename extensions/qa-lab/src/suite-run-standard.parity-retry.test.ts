import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getEffectiveQaEvidenceEntries,
  projectQaEvidenceScenarioOutcomes,
  type QaEvidenceSummaryV3Json,
} from "./evidence-summary.js";
import { QaGatewayChildLifecycle } from "./gateway-child-lifecycle.js";
import type { QaLabServerHandle } from "./lab-server.types.js";
import type { writeQaSuiteArtifacts } from "./suite-artifacts.js";
import { runQaFlowSuiteStandard } from "./suite-run-standard.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";
import type {
  QaSuiteResolvedRunContext,
  QaSuiteScenarioResult,
  QaSuiteScenarioRunner,
} from "./suite-types.js";
import type { runQaFlowSuiteCleanupPlan } from "./suite.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const mocks = vi.hoisted(() => ({
  captureTransportArtifacts: vi.fn(async () => ({
    artifacts: [{ kind: "channel-driver-smoke" as const, path: "readiness.json" }],
  })),
  captureRuntimeParityCell: vi.fn(async (params: { runtime: "codex"; wallClockMs: number }) => ({
    runtime: params.runtime,
    transcriptBytes: "",
    toolCalls: [],
    finalText: "",
    usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
    cacheDiagnostics: {
      assistantTurns: 1,
      cacheTelemetryTurns: 1,
      cacheHitTurns: 0,
      cacheWriteTurns: 0,
      cacheMisses: [],
      cacheMissInputTokens: 0,
      unmeasuredPostWarmTurns: [],
    },
    wallClockMs: params.wallClockMs,
    bootStateLines: [],
  })),
  createRuntimePreloads: vi.fn(() => ["file:///qa-transport-preload.mjs"]),
  startQaGatewayChild: vi.fn(async (_params: unknown) => ({
    baseUrl: "http://127.0.0.1:18789",
    token: "qa-test-token",
    cfg: {},
    getProcessCpuMs: () => null,
    getProcessRssBytes: () => null,
    evidenceIdentity: null as { protocol: number; version: string } | null,
    stop: vi.fn(async () => {}),
  })),
  stopQaGatewayChild: vi.fn<QaGatewayChildLifecycle["stop"]>(),
  writeQaSuiteArtifacts: vi.fn<typeof writeQaSuiteArtifacts>(async () => ({
    evidence: undefined,
    evidencePath: "/qa-output/qa-evidence.json",
    report: "",
    reportPath: "/qa-output/qa-suite-report.md",
    summaryPath: "/qa-output/qa-suite-summary.json",
  })),
  waitForGatewayHealthy: vi.fn(async () => {}),
  waitForTransportReady: vi.fn(async () => {}),
  runQaFlowSuiteCleanupPlan: vi.fn<typeof runQaFlowSuiteCleanupPlan>(async () => []),
  writeQaSuiteProgress: vi.fn(),
  runQaSuiteRoundTripProbe: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/agent-harness", () => ({
  disposeRegisteredAgentHarnesses: vi.fn(async () => {}),
}));
vi.mock("./gateway-child.js", () => ({
  createQaGatewayChild: () => ({
    start: (params: unknown) => mocks.startQaGatewayChild(params),
    stop: mocks.stopQaGatewayChild,
  }),
}));
vi.mock("./providers/server-runtime.js", () => ({
  startQaProviderServer: vi.fn(async () => undefined),
}));
vi.mock("./runtime-parity.js", () => ({
  captureRuntimeParityCell: mocks.captureRuntimeParityCell,
}));
vi.mock("./suite-artifacts.js", () => ({
  writeQaSuiteArtifacts: mocks.writeQaSuiteArtifacts,
}));
vi.mock("./suite-runtime-gateway.js", () => ({
  waitForGatewayHealthy: mocks.waitForGatewayHealthy,
  waitForTransportReady: mocks.waitForTransportReady,
}));
vi.mock("./suite.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./suite.js")>()),
  buildQaSuiteRuntimeMetrics: vi.fn(() => ({ wallMs: 1 })),
  captureGatewayHeapSnapshotCheckpoint: vi.fn(async () => undefined),
  createQaSuiteTransportAdapter: vi.fn(async () => ({
    adapter: {
      id: "qa-channel",
      captureArtifacts: mocks.captureTransportArtifacts,
      createRuntimePreloads: mocks.createRuntimePreloads,
    },
    cleanupBeforeGatewayStop: vi.fn(async () => {}),
    cleanupAfterGatewayStop: vi.fn(async () => {}),
  })),
  requireQaSuiteStartLab: vi.fn(),
  resolveQaSuiteTransportReadyTimeoutMs: vi.fn(() => 1_000),
  runQaFlowSuiteCleanupPlan: mocks.runQaFlowSuiteCleanupPlan,
  waitForQaLabReadyOrStopOwned: vi.fn(async () => {}),
  writeQaSuiteProgress: mocks.writeQaSuiteProgress,
}));
vi.mock("./web-runtime.js", () => ({
  closeQaWebSessions: vi.fn(async () => {}),
}));
vi.mock("./suite-round-trip.js", () => ({
  runQaSuiteRoundTripProbe: mocks.runQaSuiteRoundTripProbe,
}));
vi.mock("./evidence-environment.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./evidence-environment.js")>()),
  captureQaEvidenceLaunchIdentity: vi.fn(async () => ({
    source: { ref: "fixture-source", integrity: "fixture-integrity" },
    runtime: { id: "node", version: "fixture-version" },
    package: null,
    protocol: null,
    accountRef: null,
    proofClass: "fixture-only",
  })),
}));

function makeRetryTestLab(): QaLabServerHandle {
  return {
    baseUrl: "http://127.0.0.1:43123",
    listenUrl: "http://127.0.0.1:43123",
    state: {} as QaLabServerHandle["state"],
    setControlUi: vi.fn(),
    setScenarioRun: vi.fn(),
    setLatestReport: vi.fn(),
    runSelfCheck: vi.fn(),
    stop: vi.fn(async () => {}),
  };
}

function makeRetryTestContext(): QaSuiteResolvedRunContext {
  return {
    startedAt: new Date(),
    repoRoot: testOutputDir,
    outputDir: testOutputDir,
    transportId: "qa-channel",
    selectedScenarios: [makeQaSuiteTestScenario("runtime-soak-100-turn")],
    providerMode: "live-frontier",
    primaryModel: "openai/gpt-5.6-luna",
    alternateModel: "openai/gpt-5.6-luna",
    fastMode: true,
    enabledPluginIds: [],
    gatewayConfigPatches: [],
    gatewayRuntimeOptions: undefined,
    concurrency: 1,
    progressEnabled: false,
    gatewayHeapCheckpointsEnabled: false,
  };
}

function makeRetryTestResult(status: "pass" | "fail"): QaSuiteScenarioResult {
  return {
    name: "runtime-soak-100-turn",
    status,
    details: status === "fail" ? "expected 100 persisted user turns, got 101" : "passed",
    steps: [],
  };
}

const tempDirs = createTempDirHarness();
let testOutputDir: string;

beforeEach(async () => {
  testOutputDir = await tempDirs.makeTempDir("qa-standard-lifecycle-");
  vi.clearAllMocks();
  mocks.stopQaGatewayChild.mockReset().mockResolvedValue({
    process: "confirmed-stopped",
    errors: [],
  });
  mocks.runQaFlowSuiteCleanupPlan.mockReset().mockResolvedValue([]);
  mocks.runQaSuiteRoundTripProbe.mockReset();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await tempDirs.cleanup();
});

describe("QA suite Control UI ownership", () => {
  it.each([
    {
      label: "a non-Control UI scenario by default",
      surface: "channel",
      explicit: undefined,
      enabled: false,
    },
    {
      label: "an explicitly disabled non-Control UI scenario",
      surface: "channel",
      explicit: false,
      enabled: false,
    },
    {
      label: "an explicitly enabled non-Control UI scenario",
      surface: "channel",
      explicit: true,
      enabled: true,
    },
    {
      label: "a Control UI scenario by default",
      surface: "control-ui",
      explicit: undefined,
      enabled: true,
    },
    {
      label: "an explicitly disabled Control UI scenario",
      surface: "control-ui",
      explicit: false,
      enabled: false,
    },
  ])("only starts and publishes the gateway Control UI for $label", async (testCase) => {
    const lab = makeRetryTestLab();
    const context = makeRetryTestContext();
    context.selectedScenarios = [
      makeQaSuiteTestScenario("control-ui-ownership", { surface: testCase.surface }),
    ];
    const runScenario = vi
      .fn<QaSuiteScenarioRunner>()
      .mockResolvedValue(makeRetryTestResult("pass"));

    await runQaFlowSuiteStandard(
      {
        lab,
        ...(testCase.explicit === undefined ? {} : { controlUiEnabled: testCase.explicit }),
      },
      context,
      runScenario,
    );

    expect(mocks.startQaGatewayChild).toHaveBeenCalledWith(
      expect.objectContaining({
        controlUiEnabled: testCase.enabled,
        runtimePreloads: ["file:///qa-transport-preload.mjs"],
      }),
    );
    expect(mocks.createRuntimePreloads).toHaveBeenCalledOnce();
    if (testCase.enabled) {
      expect(lab.setControlUi).toHaveBeenCalledWith({
        controlUiProxyTarget: "http://127.0.0.1:18789",
        controlUiProxyToken: "qa-test-token",
      });
    } else {
      expect(lab.setControlUi).not.toHaveBeenCalled();
    }
  });
});

describe("QA runtime parity scenario retry isolation", () => {
  it.each(["pass", "fail"] as const)(
    "records each retry and selects the whole %s attempt",
    async (status) => {
      const captured: QaEvidenceSummaryV3Json[] = [];
      const runScenario = vi
        .fn<QaSuiteScenarioRunner>()
        .mockResolvedValueOnce(makeRetryTestResult("fail"))
        .mockResolvedValueOnce(makeRetryTestResult(status));
      const result = await runQaFlowSuiteStandard(
        { lab: makeRetryTestLab(), onEvidence: (summary) => captured.push(summary) },
        makeRetryTestContext(),
        runScenario,
      );
      const final = captured.at(-1)!;
      expect(final.schemaVersion).toBe(3);
      expect(final.entries.map((entry) => entry.result.status)).toEqual(["fail", status]);
      expect(getEffectiveQaEvidenceEntries(final).map((entry) => entry.result.status)).toEqual([
        status,
      ]);
      expect(projectQaEvidenceScenarioOutcomes(final)[0]).toMatchObject({
        status,
        occurrenceId: result.scenarios[0]!.evidenceOccurrenceId,
      });
      expect(mocks.writeQaSuiteArtifacts.mock.calls.at(-1)?.[0].recordedEvidence).toMatchObject({
        occurrences: final.occurrences,
        entries: final.entries,
      });
    },
  );

  it.each(["skip", "pass", "fail"] as const)(
    "retries only observed failures when a captured failure continues to %s",
    async (status) => {
      const context = makeRetryTestContext();
      const scenario = context.selectedScenarios[0]!;
      if (scenario.execution.kind !== "flow") {
        throw new Error("expected flow scenario");
      }
      scenario.execution.retryCount = 0;
      const captured: QaEvidenceSummaryV3Json[] = [];
      const first = await runQaFlowSuiteStandard(
        { lab: makeRetryTestLab(), onEvidence: (summary) => captured.push(summary) },
        context,
        vi.fn<QaSuiteScenarioRunner>().mockResolvedValue(makeRetryTestResult("fail")),
      );
      const original = structuredClone(captured.at(-1)!);
      scenario.execution.retryCount = 1;
      const runScenario = vi
        .fn<QaSuiteScenarioRunner>()
        .mockResolvedValueOnce({
          ...makeRetryTestResult("fail"),
          status: status === "skip" ? "skip" : "fail",
          details: status === "skip" ? "not applicable" : "continued failure",
        })
        .mockResolvedValue(makeRetryTestResult(status === "skip" ? "pass" : status));
      const result = await runQaFlowSuiteStandard(
        {
          lab: makeRetryTestLab(),
          evidenceAnchors: original.occurrences.filter(
            (occurrence) => occurrence.scenario?.kind === "instance",
          ),
          evidenceContinuation: original,
          onEvidence: (summary) => captured.push(summary),
        },
        context,
        runScenario,
      );
      expect(runScenario).toHaveBeenCalledTimes(status === "skip" ? 1 : 2);
      const final = captured.at(-1)!;
      const observations = final.occurrences.filter(
        (occurrence) => occurrence.scenario?.kind === "observation",
      );
      expect(observations.map((occurrence) => occurrence.retryOf)).toEqual(
        status === "skip"
          ? [null, observations[0]!.id]
          : [null, observations[0]!.id, observations[1]!.id],
      );
      expect(final.entries.map((entry) => entry.result.status)).toEqual(
        status === "skip" ? ["fail", "skipped"] : ["fail", "fail", status],
      );
      expect(getEffectiveQaEvidenceEntries(final).map((entry) => entry.result.status)).toEqual([
        status === "pass" ? "pass" : "fail",
      ]);
      expect(projectQaEvidenceScenarioOutcomes(final)[0]).toMatchObject({
        status: status === "pass" ? "pass" : "fail",
        occurrenceId: result.scenarios[0]!.evidenceOccurrenceId,
      });
      if (status === "pass") {
        expect(result.scenarios[0]?.details).toContain(
          "passed on retry; first attempt: continued failure",
        );
      } else {
        expect(result.scenarios[0]).toMatchObject({
          status: "fail",
          details: first.scenarios[0]!.details,
          evidenceOccurrenceId: first.scenarios[0]!.evidenceOccurrenceId,
        });
      }
      expect(final.occurrences.find((item) => item.id === observations[0]!.id)).toEqual(
        original.occurrences.find((item) => item.id === observations[0]!.id),
      );
    },
  );

  it("captures Gateway facts before cleanup without labelling them as selected harness facts", async () => {
    let identity: { protocol: number; version: string } | null = {
      protocol: 3,
      version: "gateway-fixture",
    };
    mocks.startQaGatewayChild.mockResolvedValueOnce({
      baseUrl: "http://127.0.0.1:18789",
      token: "qa-test-token",
      cfg: {},
      getProcessCpuMs: () => null,
      getProcessRssBytes: () => null,
      get evidenceIdentity() {
        return identity;
      },
      stop: vi.fn(async () => {}),
    });
    mocks.runQaFlowSuiteCleanupPlan.mockImplementationOnce(async () => {
      identity = null;
      return [];
    });
    await runQaFlowSuiteStandard(
      { lab: makeRetryTestLab(), forcedRuntime: "codex" },
      makeRetryTestContext(),
      vi.fn<QaSuiteScenarioRunner>().mockResolvedValue(makeRetryTestResult("pass")),
    );
    const summary = mocks.writeQaSuiteArtifacts.mock.calls.at(-1)![0].recordedEvidence!;
    expect(summary.schemaVersion).toBe(3);
    if (summary.schemaVersion !== 3) {
      throw new Error("expected occurrences");
    }
    const receipts = summary.occurrences.flatMap((occurrence) => occurrence.receipts);
    expect(receipts.find((receipt) => receipt.phase === "runtime")?.identity).toEqual({
      source: { ref: null, integrity: null },
      runtime: { id: "openclaw", version: "gateway-fixture" },
      package: null,
      protocol: "gateway:3",
      accountRef: null,
      proofClass: null,
    });
    expect(identity).toBeNull();
  });

  it.each(["pass", "fail", "throws"] as const)(
    "retains a pass and separate diagnostic when the post-run probe %s",
    async (probeStatus) => {
      const context = makeRetryTestContext();
      context.selectedScenarios[0]!.assertions = [
        { id: "scenario-result", meaning: "the scenario owns its result", coverage: [] },
      ];
      const captured: QaEvidenceSummaryV3Json[] = [];
      const error = new Error("post-run probe failed");
      if (probeStatus === "throws") {
        mocks.runQaSuiteRoundTripProbe.mockRejectedValueOnce(error);
      } else {
        mocks.runQaSuiteRoundTripProbe.mockResolvedValueOnce({
          passed: probeStatus === "pass" ? 1 : 0,
          details: `probe ${probeStatus}`,
        });
      }
      const run = runQaFlowSuiteStandard(
        {
          lab: makeRetryTestLab(),
          onEvidence: (summary) => captured.push(summary),
          roundTripProbe: {
            scenarioId: context.selectedScenarios[0]!.id,
            count: 1,
            maxFailures: 1,
            timeoutMs: 100,
            markerPrefix: "fixture",
            textPrefix: "fixture",
            input: { conversation: { kind: "direct", id: "fixture" }, senderId: "fixture" },
          },
        },
        context,
        vi.fn<QaSuiteScenarioRunner>().mockResolvedValue(makeRetryTestResult("pass")),
      );
      if (probeStatus === "throws") {
        await expect(run).rejects.toBe(error);
        expect(mocks.writeQaSuiteArtifacts).not.toHaveBeenCalled();
      } else {
        await expect(run).resolves.toMatchObject({ scenarios: [{ status: probeStatus }] });
      }
      const summary = captured.at(-1)!;
      const status = probeStatus === "pass" ? "pass" : "fail";
      expect(summary.entries.map((entry) => entry.result.status)).toEqual(["pass", status]);
      expect(summary.entries[1]?.coverage).toEqual([]);
      expect(projectQaEvidenceScenarioOutcomes(summary)[0]?.status).toBe(status);
      const actualId = summary.entries[0]!.binding.occurrenceId;
      for (const occurrence of summary.occurrences) {
        expect(occurrence.assertions).toEqual(
          occurrence.id === actualId ? context.selectedScenarios[0]!.assertions : null,
        );
      }
    },
  );

  it("keeps unstarted repeated flow instances pending after the first failure", async () => {
    const lab = makeRetryTestLab();
    const context = makeRetryTestContext();
    context.selectedScenarios = ["same", "other", "same"].map((id) => {
      const scenario = makeQaSuiteTestScenario(id);
      if (scenario.execution.kind === "flow") {
        scenario.execution.retryCount = 0;
      }
      return scenario;
    });
    const snapshots: Parameters<QaLabServerHandle["setScenarioRun"]>[0][] = [];
    vi.mocked(lab.setScenarioRun).mockImplementation((next) => {
      snapshots.push(structuredClone(next));
    });
    const evidence: QaEvidenceSummaryV3Json[] = [];
    const runScenario = vi.fn<QaSuiteScenarioRunner>().mockResolvedValue({
      name: "same",
      status: "fail",
      details: "first failed",
      steps: [],
    });
    const result = await runQaFlowSuiteStandard(
      {
        lab,
        failFast: true,
        onEvidence: (summary) => {
          evidence.push(summary);
        },
      },
      context,
      runScenario,
    );
    expect(runScenario).toHaveBeenCalledTimes(1);
    expect(result.scenarios).toHaveLength(1);
    expect(projectQaEvidenceScenarioOutcomes(evidence.at(-1)!).map((item) => item.status)).toEqual([
      "fail",
      null,
      null,
    ]);
    expect(snapshots.at(-1)?.scenarios.map((item) => item.status)).toEqual([
      "fail",
      "pending",
      "pending",
    ]);
    expect(snapshots.at(-1)?.scenarios.map((item) => item.id)).toEqual(["same", "other", "same"]);
  });

  it.each([false, true])(
    "preserves runner progress through cleanup (failFast=%s)",
    async (failFast) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const at = (second: number) => new Date(Date.UTC(2026, 7, 4, 0, 0, second));
      vi.setSystemTime(at(0));
      const lab = makeRetryTestLab();
      const context = makeRetryTestContext();
      context.selectedScenarios = ["first", "second", "tail"].map((id) => {
        const scenario = makeQaSuiteTestScenario(id);
        scenario.title = `Catalog ${id}`;
        if (scenario.execution.kind === "flow") {
          scenario.execution.retryCount = 0;
        }
        return scenario;
      });
      const snapshots: Parameters<QaLabServerHandle["setScenarioRun"]>[0][] = [];
      vi.mocked(lab.setScenarioRun).mockImplementation((next) =>
        snapshots.push(structuredClone(next)),
      );
      const results: QaSuiteScenarioResult[] = [
        {
          name: "result first",
          status: "pass",
          details: "",
          steps: [{ name: "check", status: "pass" }],
        },
        { name: "result second", status: "fail", steps: [] },
        { name: "result tail", status: "skip", details: "not applicable", steps: [] },
      ];
      const runScenario = vi.fn<QaSuiteScenarioRunner>().mockImplementation(async () => {
        const index = runScenario.mock.calls.length - 1;
        vi.setSystemTime(at(index + 1));
        return results[index]!;
      });
      mocks.runQaFlowSuiteCleanupPlan.mockImplementationOnce(async () => {
        expect(snapshots.every((snapshot) => snapshot?.status === "running")).toBe(true);
        expect(mocks.writeQaSuiteArtifacts).not.toHaveBeenCalled();
        vi.setSystemTime(at(10));
        return [];
      });

      await runQaFlowSuiteStandard({ lab, failFast }, context, runScenario);

      const finishedCount = failFast ? 2 : 3;
      const finalStatuses = failFast ? ["pass", "fail", "pending"] : ["pass", "fail", "skip"];
      expect(
        snapshots.map((snapshot) => snapshot?.scenarios.map((scenario) => scenario.status)),
      ).toEqual([
        ["pending", "pending", "pending"],
        ["running", "pending", "pending"],
        ["pass", "pending", "pending"],
        ["pass", "running", "pending"],
        ["pass", "fail", "pending"],
        ...(failFast
          ? []
          : [
              ["pass", "fail", "running"],
              ["pass", "fail", "skip"],
            ]),
        finalStatuses,
      ]);
      expect(snapshots.at(-1)).toStrictEqual({
        kind: "suite",
        status: "completed",
        startedAt: at(0).toISOString(),
        finishedAt: at(10).toISOString(),
        scenarios: context.selectedScenarios.map((scenario, index) =>
          Object.assign(
            { id: scenario.id, name: scenario.title, status: finalStatuses[index] },
            index < finishedCount
              ? {
                  details: results[index]!.details,
                  steps: results[index]!.steps,
                  startedAt: at(index).toISOString(),
                  finishedAt: at(index + 1).toISOString(),
                }
              : {},
          ),
        ),
      });
      expect(runScenario).toHaveBeenCalledTimes(finishedCount);
      expect(mocks.captureTransportArtifacts).toHaveBeenCalledOnce();
      expect(mocks.captureTransportArtifacts.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.runQaFlowSuiteCleanupPlan.mock.invocationCallOrder[0]!,
      );
      expect(mocks.writeQaSuiteArtifacts).toHaveBeenCalledWith(
        expect.objectContaining({
          transportArtifacts: {
            artifacts: [{ kind: "channel-driver-smoke", path: "readiness.json" }],
          },
        }),
      );
      expect(mocks.writeQaSuiteArtifacts.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(lab.setLatestReport).mock.invocationCallOrder[0]!,
      );
      expect(vi.mocked(lab.setLatestReport).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(lab.setScenarioRun).mock.invocationCallOrder.at(-1)!,
      );
    },
  );

  it("does not publish terminal artifacts when cleanup fails", async () => {
    const lab = makeRetryTestLab();
    const cleanupError = Object.assign(new Error("gateway shutdown socket reset"), {
      code: "ECONNRESET",
    });
    mocks.runQaFlowSuiteCleanupPlan.mockResolvedValueOnce([
      { phase: "gateway stop", error: cleanupError },
    ]);

    const thrown = await runQaFlowSuiteStandard(
      { lab },
      makeRetryTestContext(),
      vi.fn<QaSuiteScenarioRunner>().mockResolvedValue(makeRetryTestResult("pass")),
    ).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as Error).message.split("\n")[0]).toBe(
      "QA scenarios passed, but cleanup failed",
    );
    expect((thrown as Error).message).toContain(
      "scenario counts: passed=1 failed=0 skipped=0 total=1",
    );
    expect((thrown as Error).message).toContain(
      "failed cleanup phases: gateway stop: gateway shutdown socket reset",
    );
    expect((thrown as Error).cause).toBe(cleanupError);
    expect(mocks.writeQaSuiteArtifacts).not.toHaveBeenCalled();
    expect(lab.setLatestReport).not.toHaveBeenCalled();
    expect(lab.setScenarioRun).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed" }),
    );
    expect(
      mocks.writeQaSuiteProgress.mock.calls.filter(([, message]) =>
        String(message).startsWith("run complete"),
      ),
    ).toHaveLength(0);
  });

  it.each([
    { forcedRuntime: undefined, expectedRuntime: "openclaw" },
    { forcedRuntime: "codex" as const, expectedRuntime: "codex" },
  ])(
    "records $expectedRuntime as the selected runtime fact",
    async ({ forcedRuntime, expectedRuntime }) => {
      const runScenario = vi.fn<QaSuiteScenarioRunner>().mockImplementation(async (env) => {
        expect(env.runtimeId).toBe(expectedRuntime);
        return makeRetryTestResult("pass");
      });

      await runQaFlowSuiteStandard(
        { lab: makeRetryTestLab(), ...(forcedRuntime ? { forcedRuntime } : {}) },
        makeRetryTestContext(),
        runScenario,
      );

      expect(runScenario).toHaveBeenCalledOnce();
    },
  );

  it("skips connected-transport readiness for intentionally unhealthy startup", async () => {
    const context = makeRetryTestContext();
    context.gatewayRuntimeOptions = { allowUnhealthyStartup: true };
    const runScenario = vi
      .fn<QaSuiteScenarioRunner>()
      .mockResolvedValue(makeRetryTestResult("pass"));

    await runQaFlowSuiteStandard({ lab: makeRetryTestLab() }, context, runScenario);

    expect(mocks.startQaGatewayChild).toHaveBeenCalledWith(
      expect.objectContaining({ allowUnhealthyStartup: true }),
    );
    expect(mocks.waitForGatewayHealthy).not.toHaveBeenCalled();
    expect(mocks.waitForTransportReady).not.toHaveBeenCalled();
    expect(runScenario).toHaveBeenCalledOnce();
  });

  it("captures one failed parity attempt without replaying its transcript or usage", async () => {
    const runScenario = vi
      .fn<QaSuiteScenarioRunner>()
      .mockResolvedValueOnce(makeRetryTestResult("fail"))
      .mockResolvedValueOnce(makeRetryTestResult("pass"));

    const result = await runQaFlowSuiteStandard(
      { lab: makeRetryTestLab(), forcedRuntime: "codex", captureRuntimeParityCell: true },
      makeRetryTestContext(),
      runScenario,
    );

    expect(runScenario).toHaveBeenCalledOnce();
    expect(result.scenarios[0]).toMatchObject({ status: "fail" });
    expect(mocks.captureRuntimeParityCell).toHaveBeenCalledOnce();
    expect(mocks.captureRuntimeParityCell).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime: "codex",
        scenarioResult: expect.objectContaining({ status: "fail" }),
        wallClockMs: expect.any(Number),
      }),
    );
    expect(result.runtimeParityCell).toMatchObject({
      usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
      cacheDiagnostics: { assistantTurns: 1 },
      wallClockMs: expect.any(Number),
    });
  });

  it.each(["pass", "fail"] as const)(
    "retains sanitized logs after an initial %s only when the scenario retried",
    async (firstStatus) => {
      vi.stubEnv("OPENCLAW_QA_KEEP_TEMP", undefined);
      const root = await tempDirs.makeTempDir("qa-retry-artifacts-");
      const tempRoot = path.join(root, "runtime");
      await fs.mkdir(tempRoot);
      const stderrPath = path.join(tempRoot, "gateway.stderr.log");
      const gateway = new QaGatewayChildLifecycle();
      gateway.repoRoot = root;
      gateway.tempRoot = tempRoot;
      mocks.stopQaGatewayChild.mockImplementation((options) => gateway.stop(options));
      mocks.runQaFlowSuiteCleanupPlan.mockImplementation(async ({ stopGateway }) => {
        const stopped = await stopGateway();
        return stopped.errors.map((error) => ({ phase: "gateway stop", error }));
      });
      let attempts = 0;
      const runScenario = vi.fn<QaSuiteScenarioRunner>().mockImplementation(async () => {
        attempts += 1;
        await fs.appendFile(
          stderrPath,
          attempts === 1
            ? "FIRST_ATTEMPT apiKey=synthetic-fixture-secret\n"
            : "SECOND_ATTEMPT_PASS\n",
        );
        return makeRetryTestResult(attempts === 1 ? firstStatus : "pass");
      });
      const context = {
        ...makeRetryTestContext(),
        repoRoot: root,
        outputDir: path.join(root, "output"),
      };

      const result = await runQaFlowSuiteStandard(
        { lab: makeRetryTestLab() },
        context,
        runScenario,
      );

      expect(runScenario).toHaveBeenCalledTimes(firstStatus === "fail" ? 2 : 1);
      expect(result.scenarios[0]).toMatchObject({ status: "pass" });
      expect(mocks.captureRuntimeParityCell).not.toHaveBeenCalled();
      await expect(fs.stat(tempRoot)).rejects.toMatchObject({ code: "ENOENT" });
      const artifactDir = path.join(context.outputDir, "artifacts", "gateway-runtime");
      if (firstStatus === "fail") {
        expect(result.scenarios[0]?.details).toContain(
          "passed on retry; first attempt: expected 100 persisted user turns, got 101",
        );
        const log = await fs.readFile(path.join(artifactDir, "gateway.stderr.log"), "utf8");
        expect(log).toContain("FIRST_ATTEMPT apiKey=<redacted>");
        expect(log).toContain("SECOND_ATTEMPT_PASS");
        expect(log).not.toContain("synthetic-fixture-secret");
      } else {
        await expect(fs.stat(artifactDir)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );
});
