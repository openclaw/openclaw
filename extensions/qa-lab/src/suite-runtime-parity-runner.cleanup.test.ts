import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { QaSuiteCleanupError } from "./errors.js";
import {
  projectQaEvidenceScenarioOutcomes,
  type QaEvidenceSummaryV3Json,
} from "./evidence-summary.js";
import type { QaLabServerHandle } from "./lab-server.types.js";
import {
  createQaTransportAdapter,
  type QaTransportAdapterFactory,
} from "./qa-transport-registry.js";
import * as scenarioCatalog from "./scenario-catalog.js";
import type { writeQaSuiteArtifacts } from "./suite-artifacts.js";
import * as suiteEvidence from "./suite-evidence.js";
import { runQaFlowSuiteFromRuntime } from "./suite-run.runtime.js";
import { runQaRuntimeParitySuite } from "./suite-runtime-parity-runner.js";
import {
  findQaSuiteSummaryAccountingError,
  readQaSuiteFailedScenarioCountFromFile,
} from "./suite-summary.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";
import type { QaSuiteRunner, QaSuiteScenarioRunner } from "./suite-types.js";
import * as suite from "./suite.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const tempDirs = createTempDirHarness();

const mocks = vi.hoisted(() => ({
  captureRuntimeParityCell: vi.fn(
    async (params: { runtime: "openclaw" | "codex"; wallClockMs: number }) => ({
      runtime: params.runtime,
      transcriptBytes: "",
      toolCalls: [],
      finalText: "ok",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
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
    }),
  ),
  disposeRegisteredAgentHarnesses: vi.fn(async () => {}),
  fetchWithSsrFGuard: vi.fn(async () => ({
    response: new Response(null, { status: 204 }),
    release: vi.fn(async () => {}),
  })),
  startQaGatewayChild: vi.fn(async (_params: unknown) => ({
    baseUrl: "http://127.0.0.1:18789",
    token: "qa-test-token",
    cfg: {},
    getProcessCpuMs: () => null,
    getProcessRssBytes: () => null,
    stop: vi.fn(async () => {}),
  })),
  writeQaSuiteArtifacts: vi.fn<typeof writeQaSuiteArtifacts>(async (_params) => ({
    evidence: _params.recordedEvidence,
    evidencePath: "/qa-output/qa-evidence.json",
    report: "",
    reportPath: "/qa-output/qa-suite-report.md",
    summaryPath: "/qa-output/qa-suite-summary.json",
  })),
}));

vi.mock("openclaw/plugin-sdk/agent-harness", () => ({
  disposeRegisteredAgentHarnesses: mocks.disposeRegisteredAgentHarnesses,
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
}));
vi.mock("./crabline-transport.js", () => {
  const createTransport = vi.fn(async () => ({
    id: "telegram",
    label: "Crabline Telegram",
    accountId: "sut",
    requiredPluginIds: [],
    supportedActions: [],
    sendInbound: vi.fn(async () => {}),
    createGatewayConfig: () => ({}),
    waitReady: vi.fn(async () => {}),
    buildAgentDelivery: ({ target }: { target: string }) => ({
      channel: "telegram",
      to: target,
      replyChannel: "telegram",
      replyTo: target,
    }),
    handleAction: vi.fn(async () => {}),
    createReportNotes: () => [],
    captureArtifacts: vi.fn(async () => ({
      artifacts: [{ kind: "channel-driver-smoke", path: "/qa-output/driver-smoke.json" }],
      reportNotes: [],
    })),
    cleanupAfterGatewayStop: vi.fn(async () => {}),
  }));
  return {
    createQaCrablineTransportAdapter: createTransport,
    createQaCrablineTransportDefinition: createTransport,
  };
});
vi.mock("./gateway-child.js", () => ({
  createQaGatewayChild: () => ({
    start: (params: unknown) => mocks.startQaGatewayChild(params),
    stop: async () => ({ process: "confirmed-stopped", errors: [] }),
  }),
}));
vi.mock("./providers/server-runtime.js", () => ({
  startQaProviderServer: vi.fn(async () => undefined),
}));
vi.mock("./runtime-parity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime-parity.js")>()),
  captureRuntimeParityCell: mocks.captureRuntimeParityCell,
}));
vi.mock("./suite-artifacts.js", () => ({
  invalidateQaSuiteArtifactGeneration: vi.fn(async () => {}),
  writeQaSuiteArtifacts: mocks.writeQaSuiteArtifacts,
}));
vi.mock("./suite-runtime-gateway.js", () => ({
  waitForGatewayHealthy: vi.fn(async () => {}),
  waitForTransportReady: vi.fn(async () => {}),
}));
vi.mock("./web-runtime.js", () => ({
  closeQaWebSessions: vi.fn(async () => {}),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await tempDirs.cleanup();
});

function createCleanupTestLab(): QaLabServerHandle {
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

type CleanupPhases = {
  cleanup?: () => Promise<void>;
  cleanupAfterGatewayStop?: () => Promise<void>;
};

function createCleanupTestFactory(
  lab: QaLabServerHandle,
  createCleanupPhases: () => CleanupPhases | Promise<CleanupPhases>,
): QaTransportAdapterFactory {
  return {
    id: "leased",
    matches: ({ channelId, driver }) => channelId === "leased" && driver === "live",
    async create() {
      const cleanupPhases = await createCleanupPhases();
      return {
        id: "leased",
        label: "Leased channel",
        accountId: "sut",
        requiredPluginIds: [],
        supportedActions: [],
        sendInbound: async (input) => lab.state.addInboundMessage(input),
        createGatewayConfig: () => ({}),
        async waitReady() {},
        buildAgentDelivery: ({ target }) => ({
          channel: "leased",
          to: target,
          replyChannel: "leased",
          replyTo: target,
        }),
        async handleAction() {},
        createReportNotes: () => [],
        ...cleanupPhases,
      };
    },
  };
}

async function runCleanupTestSuite(params: {
  signal?: AbortSignal;
  forwardParentSignals?: boolean;
  factory: QaTransportAdapterFactory;
  lab: QaLabServerHandle;
  progressEnabled?: boolean;
  runChild: QaSuiteRunner;
  overrides?: Partial<Parameters<typeof runQaRuntimeParitySuite>[0]>;
}) {
  const repoRoot = params.overrides?.repoRoot ?? (await tempDirs.makeTempDir("qa-parity-cleanup-"));
  return runQaRuntimeParitySuite({
    signal: params.signal,
    forwardParentSignals: params.forwardParentSignals,
    runQaFlowSuite: params.runChild,
    adapterFactories: [params.factory],
    channelDriver: "live",
    channelId: "leased",
    repoRoot,
    outputDir: path.join(repoRoot, "output"),
    startedAt: new Date("2026-08-04T00:00:00.000Z"),
    providerMode: "mock-openai",
    transportId: "qa-channel",
    primaryModel: "mock-openai/test-model",
    alternateModel: "mock-openai/test-model-alt",
    fastMode: true,
    concurrency: 1,
    selectedScenarios: [makeQaSuiteTestScenario("runtime-cleanup")],
    startLab: async () => params.lab,
    progressEnabled: params.progressEnabled ?? false,
    runtimePair: ["openclaw", "codex"],
    ...params.overrides,
  });
}

describe("runtime parity suite transport cleanup", () => {
  it("publishes the committed comparison when its evidence observer throws", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const at = (second: number) => new Date(Date.UTC(2026, 7, 4, 0, 0, second));
    vi.setSystemTime(at(0));
    const lab = createCleanupTestLab();
    const publicationError = new Error("comparison evidence publication failed");
    const captured: QaEvidenceSummaryV3Json[] = [];
    const observeRejection = vi.fn((error: unknown) => error);
    let completedCells = 0;
    const runChild = vi.fn<QaSuiteRunner>(async (params) => {
      vi.setSystemTime(at(++completedCells));
      return {
        outputDir: params!.outputDir!,
        evidencePath: "unused",
        reportPath: "unused",
        summaryPath: "unused",
        report: "",
        scenarios: [{ name: "cell result", status: "pass", steps: [] }],
        startedScenarioIds: [...params!.scenarioIds!],
        watchUrl: lab.baseUrl,
        runtimeParityCell: await mocks.captureRuntimeParityCell({
          runtime: params?.forcedRuntime === "codex" ? "codex" : "openclaw",
          wallClockMs: 1,
        }),
      };
    });
    vi.mocked(lab.stop).mockImplementationOnce(async () => {
      expect(mocks.writeQaSuiteArtifacts).not.toHaveBeenCalled();
      vi.setSystemTime(at(10));
    });

    const thrown = await runCleanupTestSuite({
      factory: createCleanupTestFactory(lab, () => ({})),
      lab,
      runChild,
      overrides: {
        onEvidence(summary) {
          captured.push(summary);
          if (summary.entries.length > 0) {
            throw publicationError;
          }
        },
      },
    }).catch(observeRejection);

    expect(thrown).toBe(publicationError);
    expect(runChild.mock.calls.map(([params]) => params?.forcedRuntime)).toEqual([
      "openclaw",
      "codex",
    ]);
    expect(mocks.writeQaSuiteArtifacts).toHaveBeenCalledOnce();
    const written = mocks.writeQaSuiteArtifacts.mock.calls[0]![0];
    const selected = projectQaEvidenceScenarioOutcomes(captured.at(-1)!)[0]!;
    expect(written.scenarios).toMatchObject([
      { status: "pass", evidenceOccurrenceId: selected.occurrenceId },
    ]);
    expect(written.recordedEvidence).toMatchObject({
      entries: captured.at(-1)!.entries,
      occurrences: captured.at(-1)!.occurrences,
    });
    const { buildQaSuiteSummaryJson } =
      await vi.importActual<typeof import("./suite-artifacts.js")>("./suite-artifacts.js");
    const report = buildQaSuiteSummaryJson({ ...written, evidence: written.recordedEvidence });
    expect(report.counts).toEqual({ total: 1, passed: 1, failed: 0, skipped: 0 });
    expect(findQaSuiteSummaryAccountingError(report)).toBeUndefined();
    expect(lab.setScenarioRun).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "completed",
        finishedAt: at(10).toISOString(),
        scenarios: [
          expect.objectContaining({
            id: "runtime-cleanup",
            name: "runtime-cleanup",
            status: "pass",
            startedAt: at(0).toISOString(),
            finishedAt: at(2).toISOString(),
          }),
        ],
      }),
    );
    expect(lab.stop).toHaveBeenCalledOnce();
    expect(vi.mocked(lab.stop).mock.invocationCallOrder[0]).toBeLessThan(
      mocks.writeQaSuiteArtifacts.mock.invocationCallOrder[0]!,
    );
    expect(vi.mocked(lab.setLatestReport).mock.invocationCallOrder[0]).toBeLessThan(
      observeRejection.mock.invocationCallOrder[0]!,
    );
    expect(vi.mocked(lab.setScenarioRun).mock.invocationCallOrder.at(-1)).toBeLessThan(
      observeRejection.mock.invocationCallOrder[0]!,
    );
  });

  it.each(["openclaw", "codex"] as const)(
    "closes admission while %s finishes",
    async (heldRuntime) => {
      vi.stubEnv("OPENCLAW_QA_SUITE_WORKER_START_STAGGER_MS", "0");
      const repoRoot = await tempDirs.makeTempDir("qa-parity-fatal-admission-");
      const outputDir = path.join(repoRoot, "output");
      const lab = createCleanupTestLab();
      const scenarios = ["fatal", "healthy", "queued"].map((id) =>
        makeQaSuiteTestScenario(id, { channel: "leased" }),
      );
      vi.spyOn(scenarioCatalog, "readQaBootstrapScenarioCatalog").mockReturnValue({
        agentIdentityMarkdown: "test",
        kickoffTask: "test",
        scenarios,
      });
      vi.spyOn(suite, "runQaSuiteScenarioDefinitionForRuntime").mockImplementation(
        async (_env, scenario) => ({ name: scenario.title, status: "pass", steps: [] }),
      );
      const entered = createDeferred<void>();
      const releaseHealthy = createDeferred<void>();
      const writing = createDeferred<void>();
      const releaseDiagnostic = createDeferred<void>();
      const healthyRecorded = createDeferred<void>();
      const children: string[] = [];
      const started = vi.fn();
      const originalCreate = suiteEvidence.createQaSuiteEvidenceInvocation;
      vi.spyOn(suiteEvidence, "createQaSuiteEvidenceInvocation").mockImplementation(
        async (...params) => {
          const owned = await originalCreate(...params);
          const record = owned.record;
          owned.record = async (...args) => {
            const root = params[1].outputDir === outputDir;
            if (root && args[2].name === "fatal") {
              writing.resolve();
              await releaseDiagnostic.promise;
            }
            const result = await record(...args);
            if (args[3]?.env && args[2].name === "healthy") {
              children.push(args[1]);
            }
            if (root && args[2].name === "healthy") {
              healthyRecorded.resolve();
            }
            return result;
          };
          return owned;
        },
      );
      const fatal = new QaSuiteCleanupError([new Error("unconfirmed child")], "fatal cleanup");
      const runChild = vi.fn<QaSuiteRunner>(async (params) => {
        if (params?.scenarioIds?.[0] === "fatal") {
          await entered.promise;
          await runQaFlowSuiteFromRuntime(params);
          throw fatal;
        }
        if (params?.scenarioIds?.[0] === "healthy" && params?.forcedRuntime === heldRuntime) {
          entered.resolve();
          await releaseHealthy.promise;
        }
        return await runQaFlowSuiteFromRuntime(params);
      });
      const settled = vi.fn((value: unknown) => value);
      const run = runCleanupTestSuite({
        factory: createCleanupTestFactory(lab, () => ({})),
        lab,
        runChild,
        overrides: {
          repoRoot,
          outputDir,
          concurrency: 2,
          selectedScenarios: scenarios,
          onScenarioStarted: started,
          lab,
          startLab: async () => createCleanupTestLab(),
        },
      }).then(settled, settled);

      try {
        await writing.promise;
        releaseHealthy.resolve();
        await healthyRecorded.promise;
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(runChild).toHaveBeenCalledTimes(heldRuntime === "openclaw" ? 2 : 3);
        expect(settled).not.toHaveBeenCalled();
      } finally {
        releaseHealthy.resolve();
        releaseDiagnostic.resolve();
        await run;
      }

      expect(await run).toBe(fatal);
      expect(runChild).toHaveBeenCalledTimes(heldRuntime === "openclaw" ? 2 : 3);
      const evidence = mocks.writeQaSuiteArtifacts.mock.calls.at(-1)![0].recordedEvidence;
      if (evidence?.schemaVersion !== 3) {
        throw new Error("expected retained v3 evidence");
      }
      expect(
        evidence.entries
          .filter((entry) => children.includes(entry.binding.occurrenceId))
          .map((entry) => entry.result.status),
      ).toEqual(heldRuntime === "openclaw" ? ["pass"] : ["pass", "pass"]);
      const progress = vi.mocked(lab.setScenarioRun).mock.calls.at(-1)?.[0];
      expect(progress?.scenarios.map(({ status }) => status)).toEqual([
        "fail",
        heldRuntime === "openclaw" ? "fail" : "pass",
        "fail",
      ]);
      expect(progress?.status).toBe("completed");
      expect(lab.setLatestReport).toHaveBeenCalledOnce();
      expect(new Set(started.mock.calls.flat()).size).toBe(2);
    },
  );

  it.each(["standard", "isolated", "parity"] as const)(
    "publishes every %s instance after cancellation without counting unstarted work",
    async (mode) => {
      const controller = new AbortController();
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const first = makeQaSuiteTestScenario("first", {
        suiteIsolation: mode === "isolated" ? "isolated" : undefined,
      });
      const tail = makeQaSuiteTestScenario("tail");
      vi.spyOn(scenarioCatalog, "readQaBootstrapScenarioCatalog").mockReturnValue({
        agentIdentityMarkdown: "test",
        kickoffTask: "test",
        scenarios: [first, tail],
      });
      const expectedCalls = mode === "parity" ? 2 : 1;
      let calls = 0;
      const runScenario = vi
        .spyOn(suite, "runQaSuiteScenarioDefinitionForRuntime")
        .mockImplementation(async (_env, scenario) => {
          if (++calls === expectedCalls) {
            entered.resolve();
            await release.promise;
          }
          return { name: scenario.title, status: "pass", steps: [] };
        });
      const repoRoot = await tempDirs.makeTempDir("qa-cancelled-flow-report-");
      const lab = createCleanupTestLab();
      const run = runQaFlowSuiteFromRuntime({
        repoRoot,
        outputDir: path.join(repoRoot, "output"),
        scenarioIds: [first.id, tail.id, first.id],
        concurrency: 1,
        signal: controller.signal,
        providerMode: "mock-openai",
        lab,
        startLab: async () => createCleanupTestLab(),
        runtimePair: mode === "parity" ? ["openclaw", "codex"] : undefined,
      });
      try {
        await entered.promise;
        controller.abort(new Error("operator stopped suite"));
        release.resolve();
        const result = await run;
        expect(runScenario).toHaveBeenCalledTimes(expectedCalls);
        expect(result.startedScenarioIds).toEqual([first.id]);
        const evidence = result.evidence;
        if (evidence?.schemaVersion !== 3) {
          throw new Error("expected recorded flow evidence");
        }
        const outcomes = projectQaEvidenceScenarioOutcomes(evidence);
        expect(outcomes.map(({ status }) => status)).toEqual(["pass", "fail", "fail"]);
        expect(result.scenarios.map(({ status }) => status)).toEqual(["pass", "fail", "fail"]);
        expect(result.startedScenarioInstanceIds).toEqual([outcomes[0]!.scenarioInstanceId]);
        expect(
          result.scenarios
            .slice(1)
            .every(({ details }) => details?.includes("operator stopped suite")),
        ).toBe(true);
        const written = mocks.writeQaSuiteArtifacts.mock.calls.at(-1)![0];
        expect(written.scenarios).toEqual(result.scenarios);
        expect(written.recordedEvidence).toEqual(evidence);
        const { buildQaSuiteSummaryJson } =
          await vi.importActual<typeof import("./suite-artifacts.js")>("./suite-artifacts.js");
        const report = buildQaSuiteSummaryJson({ ...written, evidence });
        expect(report.run.status).toBe("completed");
        expect(report.counts).toEqual({ total: 3, passed: 1, failed: 2, skipped: 0 });
        expect(findQaSuiteSummaryAccountingError(report)).toBeUndefined();
        expect(lab.setScenarioRun).toHaveBeenLastCalledWith(
          expect.objectContaining({
            status: "completed",
            scenarios: [
              expect.objectContaining({ id: first.id, status: "pass" }),
              expect.objectContaining({ id: tail.id, status: "fail" }),
              expect.objectContaining({ id: first.id, status: "fail" }),
            ],
          }),
        );
      } finally {
        release.resolve();
        await run.catch(() => {});
      }
    },
  );

  it.each([
    ["standard", 1],
    ["isolated", 1],
    ["parity", 2],
  ] as const)(
    "restores %s with %i continued results when startup is cancelled",
    async (mode, retainedCount) => {
      const controller = new AbortController();
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const repoRoot = await tempDirs.makeTempDir("qa-continued-startup-");
      const scenario = makeQaSuiteTestScenario("same", {
        channel: "leased",
        suiteIsolation: mode === "isolated" ? "isolated" : undefined,
      });
      const options = {
        repoRoot,
        outputDir: path.join(repoRoot, "output"),
        providerMode: "mock-openai" as const,
        primaryModel: "mock-openai/test-model",
        channelDriver: "live" as const,
        channelId: "leased",
        scenarioDefinitions: [scenario],
        scenarioIds: [scenario.id, scenario.id],
      };
      const original = await suiteEvidence.createQaSuiteEvidenceInvocation(options, {
        ...options,
        selectedScenarios: [scenario, scenario],
        transportId: "qa-channel",
      });
      const retained = [];
      for (let index = 0; index < retainedCount; index++) {
        retained.push(
          await original.record(index, original.invocation.begin(index), {
            name: scenario.title,
            status: "pass",
            details: `retained result ${index}`,
            steps: [],
          }),
        );
      }
      const before = original.snapshot();
      const lab = createCleanupTestLab();
      const factory = createCleanupTestFactory(lab, async () => {
        entered.resolve();
        await release.promise;
        return {};
      });
      const runScenario = vi.spyOn(suite, "runQaSuiteScenarioDefinitionForRuntime");
      const actual =
        await vi.importActual<typeof import("./suite-artifacts.js")>("./suite-artifacts.js");
      const defaultWrite = mocks.writeQaSuiteArtifacts.getMockImplementation()!;
      mocks.writeQaSuiteArtifacts.mockImplementation(actual.writeQaSuiteArtifacts);
      const reason = new Error("stop during continued startup");
      const run = runQaFlowSuiteFromRuntime({
        ...options,
        signal: controller.signal,
        lab,
        startLab: async () => createCleanupTestLab(),
        adapterFactories: [factory],
        concurrency: 1,
        runtimePair: mode === "parity" ? ["openclaw", "codex"] : undefined,
        evidenceAnchors: original.invocation.anchors,
        evidenceContinuation: before,
      }).catch((error: unknown) => error);
      try {
        await entered.promise;
        controller.abort(reason);
        release.resolve();
        const result = await run;
        if (mode === "standard") {
          expect(result).toBe(reason);
        } else {
          expect(result).toMatchObject({
            startedScenarioIds: [],
            startedScenarioInstanceIds: [],
          });
        }
        expect(runScenario).not.toHaveBeenCalled();
        expect(mocks.startQaGatewayChild).not.toHaveBeenCalled();
        const written = mocks.writeQaSuiteArtifacts.mock.calls.at(-1)![0];
        expect(written.scenarios).toHaveLength(2);
        expect(written.scenarios.slice(0, retainedCount)).toEqual(retained);
        if (retainedCount === 1) {
          expect(written.scenarios[1]).toMatchObject({
            status: "fail",
            details: expect.stringContaining(reason.message),
          });
        }
        expect(written.recordedEvidence?.entries.slice(0, before.entries.length)).toEqual(
          before.entries,
        );
        const summaryPath = path.join(options.outputDir, "qa-suite-summary.json");
        const summary = JSON.parse(await fs.readFile(summaryPath, "utf8"));
        const failed = 2 - retainedCount;
        expect(summary.counts).toEqual({ total: 2, passed: retainedCount, failed, skipped: 0 });
        await expect(readQaSuiteFailedScenarioCountFromFile(summaryPath)).resolves.toBe(failed);
        expect(lab.setScenarioRun).toHaveBeenLastCalledWith(
          expect.objectContaining({
            status: "completed",
            scenarios: written.scenarios.map(({ status }) =>
              expect.objectContaining({ id: scenario.id, status }),
            ),
          }),
        );
      } finally {
        release.resolve();
        await run;
        mocks.writeQaSuiteArtifacts.mockReset().mockImplementation(defaultWrite);
      }
    },
  );

  it.each(["standard", "isolated", "parity"] as const)(
    "stops %s admission when cancelled during adapter preparation",
    async (mode) => {
      const controller = new AbortController();
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const factory = createCleanupTestFactory(createCleanupTestLab(), () => ({}));
      const create = vi.spyOn(factory, "create");
      factory.prepareSelectedScenarios = async () => {
        entered.resolve();
        await release.promise;
      };
      const startLab = vi
        .fn<() => Promise<QaLabServerHandle>>()
        .mockRejectedValue(new Error("unexpected child admission"));
      const reason = new Error("stop during preparation");
      const repoRoot = await tempDirs.makeTempDir("qa-cancel-preparation-");
      const run = runQaFlowSuiteFromRuntime({
        repoRoot,
        outputDir: path.join(repoRoot, "output"),
        signal: controller.signal,
        startLab,
        concurrency: 1,
        channelDriver: "live",
        channelId: "leased",
        adapterFactories: [factory],
        providerMode: "mock-openai",
        scenarioDefinitions: [
          makeQaSuiteTestScenario("prepare", {
            channel: "leased",
            suiteIsolation: mode === "isolated" ? "isolated" : undefined,
          }),
        ],
        runtimePair: mode === "parity" ? ["openclaw", "codex"] : undefined,
      }).catch((error: unknown) => error);
      try {
        await entered.promise;
        controller.abort(reason);
        release.resolve();
        expect(await run).toBe(reason);
        expect(startLab).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
        expect(mocks.startQaGatewayChild).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await run;
      }
    },
  );

  it("executes repeated flow instances in request order through the standard producer", async () => {
    const repoRoot = await tempDirs.makeTempDir("qa-repeated-flow-");
    const scenarios = [makeQaSuiteTestScenario("first"), makeQaSuiteTestScenario("second")];
    vi.spyOn(scenarioCatalog, "readQaBootstrapScenarioCatalog").mockReturnValue({
      agentIdentityMarkdown: "test",
      kickoffTask: "test",
      scenarios,
    });
    const observed: string[] = [];
    const runScenario = vi
      .spyOn(suite, "runQaSuiteScenarioDefinitionForRuntime")
      .mockImplementation(async (_env, scenario) => {
        observed.push(scenario.id);
        return {
          name: scenario.title,
          status: "pass",
          details: `invocation ${observed.length}`,
          steps: [],
        };
      });
    const lab = createCleanupTestLab();
    const result = await runQaFlowSuiteFromRuntime({
      repoRoot,
      outputDir: path.join(repoRoot, "output"),
      scenarioIds: ["first", "second", "first"],
      providerMode: "mock-openai",
      primaryModel: "mock-openai/test-model",
      alternateModel: "mock-openai/test-model-alt",
      lab,
      startLab: async () => lab,
      concurrency: 1,
    });
    const evidence = result.evidence as QaEvidenceSummaryV3Json;
    expect(observed).toEqual(["first", "second", "first"]);
    expect(new Set(runScenario.mock.calls.map(([, scenario]) => scenario)).size).toBe(3);
    const outcomes = projectQaEvidenceScenarioOutcomes(evidence);
    expect(outcomes.map((outcome) => outcome.scenarioId)).toEqual(observed);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["pass", "pass", "pass"]);
    expect(new Set(outcomes.map((outcome) => outcome.scenarioInstanceId)).size).toBe(3);
    expect(new Set(outcomes.map((outcome) => outcome.occurrenceId)).size).toBe(3);
    expect(result.scenarios.map((scenario) => scenario.details)).toEqual([
      "invocation 1",
      "invocation 2",
      "invocation 3",
    ]);
    expect(evidence.entries.map((entry) => entry.test.id)).toEqual(observed);
  });

  it.each(["cleanup", "capture"] as const)(
    "publishes completed cells before rejecting failed %s",
    async (phase) => {
      const cleanupError = Object.assign(new Error("owned lab shutdown reset"), {
        code: "ECONNRESET",
      });
      const setLatestReport = vi.fn<QaLabServerHandle["setLatestReport"]>();
      const stopLab = vi.fn<QaLabServerHandle["stop"]>(async () => {
        if (phase === "cleanup") {
          throw cleanupError;
        }
      });
      const lab = createCleanupTestLab();
      lab.setLatestReport = setLatestReport;
      lab.stop = stopLab;
      const cleanup = vi.fn(async () => {});
      const factory = createCleanupTestFactory(lab, () => ({ cleanup }));
      const create = factory.create;
      factory.create = async (options) => ({
        ...(await create(options)),
        captureArtifacts: async () => {
          if (phase === "capture") {
            throw cleanupError;
          }
          return { artifacts: [] };
        },
      });
      const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const runChild = vi.fn<QaSuiteRunner>().mockImplementation(async (params) => ({
        outputDir: "/qa-child",
        evidencePath: "/qa-child/qa-evidence.json",
        reportPath: "/qa-child/qa-suite-report.md",
        summaryPath: "/qa-child/qa-suite-summary.json",
        report: "",
        scenarios: [{ name: "runtime-cleanup", status: "pass", steps: [] }],
        startedScenarioIds: ["runtime-cleanup"],
        watchUrl: lab.baseUrl,
        runtimeParityCell: {
          runtime: params?.forcedRuntime ?? "openclaw",
          transcriptBytes: "",
          toolCalls: [],
          finalText: "ok",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          wallClockMs: 1,
          bootStateLines: [],
        },
      }));

      const observeRejection = vi.fn((error: unknown) => error);
      try {
        const thrown = await runCleanupTestSuite({
          factory,
          lab,
          progressEnabled: true,
          runChild,
        }).catch(observeRejection);

        expect(cleanup).toHaveBeenCalledOnce();
        expect(mocks.writeQaSuiteArtifacts).toHaveBeenCalledOnce();
        expect(mocks.writeQaSuiteArtifacts).toHaveBeenCalledWith(
          expect.objectContaining({ scenarios: [expect.objectContaining({ status: "pass" })] }),
        );
        expect(setLatestReport).toHaveBeenCalledWith(
          expect.objectContaining({ outputPath: "/qa-output/qa-suite-report.md" }),
        );
        expect(lab.setScenarioRun).toHaveBeenLastCalledWith(
          expect.objectContaining({ status: "completed" }),
        );
        expect(vi.mocked(lab.setScenarioRun).mock.invocationCallOrder.at(-1)).toBeLessThan(
          observeRejection.mock.invocationCallOrder[0]!,
        );
        if (phase === "cleanup") {
          expect(thrown).toBeInstanceOf(AggregateError);
          expect(thrown).not.toBeInstanceOf(QaSuiteCleanupError);
          expect(thrown).toMatchObject({ cause: cleanupError, errors: [cleanupError] });
          expect((thrown as Error).message.split("\n")[0]).toBe(
            "QA scenarios passed, but cleanup failed",
          );
          expect((thrown as Error).message).toContain(
            "failed cleanup phases: lab stop: owned lab shutdown reset",
          );
        } else {
          expect(thrown).toBe(cleanupError);
        }
        expect(stderrWrite.mock.calls.flat().join("")).not.toContain("run complete");
      } finally {
        stderrWrite.mockRestore();
      }
    },
  );

  it("reports a parity scenario only after a nested producer starts it", async () => {
    const lab = createCleanupTestLab();
    const cleanup = vi.fn(async () => {});
    const factory = createCleanupTestFactory(lab, () => ({ cleanup }));
    const runChild = vi.fn<QaSuiteRunner>().mockImplementation(async (params) => ({
      outputDir: "/qa-child",
      evidencePath: "/qa-child/qa-evidence.json",
      reportPath: "/qa-child/qa-suite-report.md",
      summaryPath: "/qa-child/qa-suite-summary.json",
      report: "",
      scenarios: [{ name: "runtime-cleanup", status: "pass", steps: [] }],
      startedScenarioIds: [],
      watchUrl: lab.baseUrl,
      runtimeParityCell: {
        runtime: params?.forcedRuntime ?? "openclaw",
        transcriptBytes: "",
        toolCalls: [],
        finalText: "ok",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        wallClockMs: 1,
        bootStateLines: [],
      },
    }));

    const signal = new AbortController().signal;
    const result = await runCleanupTestSuite({
      factory,
      lab,
      runChild,
      signal,
      forwardParentSignals: false,
    });

    expect(result.startedScenarioIds).toEqual([]);
    expect(runChild).toHaveBeenCalledTimes(2);
    for (const [child] of runChild.mock.calls) {
      expect(child?.signal).toBe(signal);
      expect(child?.forwardParentSignals).toBe(false);
    }
  });

  it.each([true, false])(
    "preserves runtime preparation publication ownership with parity=%s",
    async (parity) => {
      vi.stubEnv("OPENCLAW_QA_SUITE_PROGRESS", "1");
      mocks.writeQaSuiteArtifacts.mockClear();
      const repoRoot = await tempDirs.makeTempDir("qa-runtime-publication-");
      const scenario = makeQaSuiteTestScenario("runtime-cleanup");
      const labs = Array.from({ length: parity ? 3 : 1 }, createCleanupTestLab);
      const startLab = vi.fn<() => Promise<QaLabServerHandle>>();
      for (const lab of labs) {
        startLab.mockResolvedValueOnce(lab);
      }
      const runScenario = vi
        .fn<QaSuiteScenarioRunner>()
        .mockResolvedValue({ name: scenario.title, status: "pass", steps: [] });
      vi.spyOn(scenarioCatalog, "readQaBootstrapScenarioCatalog").mockReturnValue({
        agentIdentityMarkdown: "test",
        kickoffTask: "test",
        scenarios: [scenario],
      });
      vi.spyOn(suite, "runQaSuiteScenarioDefinitionForRuntime").mockImplementation(runScenario);
      const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      try {
        const result = await runQaFlowSuiteFromRuntime({
          repoRoot,
          outputDir: path.join(repoRoot, "output"),
          providerMode: "mock-openai",
          transportId: "qa-channel",
          channelId: "telegram",
          channelDriver: "crabline",
          primaryModel: "mock-openai/test-model",
          alternateModel: "mock-openai/test-model-alt",
          fastMode: true,
          concurrency: 1,
          scenarioIds: [scenario.id],
          startLab,
          ...(parity ? { runtimePair: ["openclaw", "codex"] } : {}),
        });

        const completionLines = stderrWrite.mock.calls
          .flat()
          .join("")
          .split("\n")
          .filter((line) => line.startsWith("[qa-suite] run complete"));
        expect(result.scenarios).toEqual([expect.objectContaining({ status: "pass" })]);
        expect(completionLines).toEqual([
          parity
            ? "[qa-suite] run complete"
            : "[qa-suite] run complete: passed=1 failed=0 skipped=0 total=1",
        ]);
        expect(runScenario).toHaveBeenCalledTimes(parity ? 2 : 1);
        expect(mocks.writeQaSuiteArtifacts).toHaveBeenCalledTimes(labs.length);
        for (const [childArtifacts] of mocks.writeQaSuiteArtifacts.mock.calls.slice(0, -1)) {
          expect(childArtifacts.transportArtifacts).toBeUndefined();
        }
        expect(mocks.writeQaSuiteArtifacts.mock.calls.at(-1)?.[0]).toMatchObject({
          channel: "telegram",
          channelDriver: "crabline",
          transportArtifacts: {
            artifacts: [{ kind: "channel-driver-smoke", path: "/qa-output/driver-smoke.json" }],
          },
        });
        for (const lab of labs) {
          expect(lab.stop).toHaveBeenCalledOnce();
        }
      } finally {
        stderrWrite.mockRestore();
      }
    },
  );

  it("preserves the scenario error when its owned lab cleanup fails", async () => {
    const lab = createCleanupTestLab();
    const scenarioError = new Error("runtime scenario failed");
    const cleanupError = new Error("owned lab shutdown failed");
    lab.stop = vi.fn(async () => {
      throw cleanupError;
    });
    const cleanup = vi.fn(async () => {});
    const factory = createCleanupTestFactory(lab, () => ({ cleanup }));
    const runChild = vi.fn<QaSuiteRunner>().mockRejectedValueOnce(scenarioError);

    await expect(runCleanupTestSuite({ factory, lab, runChild })).rejects.toMatchObject({
      message: expect.stringContaining(
        "failed cleanup phases: lab stop: owned lab shutdown failed",
      ),
      cause: scenarioError,
      errors: [scenarioError, cleanupError],
    });

    expect(runChild).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(lab.stop).toHaveBeenCalledOnce();
  });

  it("releases an exclusive parent lease before its first runtime child acquires it", async () => {
    const lab = createCleanupTestLab();
    const events: string[] = [];
    const childError = new Error("first runtime child completed");
    let activeOwner: "parent" | "child" | undefined;
    let leaseCount = 0;
    lab.stop = vi.fn(async () => {
      events.push("lab:stop");
    });
    const factory = createCleanupTestFactory(lab, () => {
      if (activeOwner) {
        throw new Error("exclusive credential pool exhausted");
      }
      const owner = leaseCount++ === 0 ? "parent" : "child";
      activeOwner = owner;
      events.push(`${owner}:acquire`);
      return {
        cleanup: async () => {
          events.push(`${owner}:cleanup-before`);
        },
        cleanupAfterGatewayStop: async () => {
          events.push(`${owner}:cleanup-after`);
          activeOwner = undefined;
        },
      };
    });
    const runChild = vi.fn<QaSuiteRunner>().mockImplementation(async () => {
      const childTransport = await createQaTransportAdapter(
        {
          channelId: "leased",
          driver: "live",
          outputDir: "/qa-child",
          state: createQaBusState(),
        },
        [factory],
      );
      await childTransport.cleanupWithoutGateway();
      throw childError;
    });

    await expect(runCleanupTestSuite({ factory, lab, runChild })).rejects.toBe(childError);

    expect(runChild).toHaveBeenCalledOnce();
    expect(events).toEqual([
      "parent:acquire",
      "parent:cleanup-before",
      "parent:cleanup-after",
      "child:acquire",
      "child:cleanup-before",
      "child:cleanup-after",
      "lab:stop",
    ]);
    expect(activeOwner).toBeUndefined();
  });

  it.each(["cleanup", "cleanupAfterGatewayStop"] as const)(
    "retries failed parent %s before stopping its owned lab",
    async (cleanupPhase) => {
      const lab = createCleanupTestLab();
      const cleanupError = new Error("credential release failed");
      const cleanup = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(cleanupError)
        .mockResolvedValueOnce(undefined);
      const factory = createCleanupTestFactory(lab, () => ({ [cleanupPhase]: cleanup }));
      const runChild = vi.fn<QaSuiteRunner>();

      await expect(runCleanupTestSuite({ factory, lab, runChild })).rejects.toBe(cleanupError);

      expect(cleanup).toHaveBeenCalledTimes(2);
      expect(runChild).not.toHaveBeenCalled();
      expect(lab.stop).toHaveBeenCalledOnce();
    },
  );
});
