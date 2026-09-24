import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { QaSuiteArtifactError, QaSuiteCleanupError, QaSuiteInfraError } from "./errors.js";
import {
  projectQaEvidenceScenarioOutcomes,
  type QaEvidenceSummaryJson,
  type QaEvidenceSummaryV3Json,
} from "./evidence-summary.js";
import type { QaLabServerHandle } from "./lab-server.types.js";
import {
  createQaTransportAdapter,
  type QaTransportAdapterFactory,
} from "./qa-transport-registry.js";
import * as scenarioCatalog from "./scenario-catalog.js";
import { createQaSuiteEvidenceInvocation } from "./suite-evidence.js";
import { runQaSuiteWithInfraRetry } from "./suite-infra-retry.js";
import { runQaFlowSuiteFromRuntime } from "./suite-run.runtime.js";
import { runQaRuntimeParitySuite } from "./suite-runtime-parity-runner.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";
import type { QaSuiteRunner, QaSuiteRunParams, QaSuiteScenarioRunner } from "./suite-types.js";
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
  writeQaSuiteArtifacts: vi.fn(
    async (_params: {
      channel?: string | null;
      channelDriver?: string | null;
      transportArtifacts?: unknown;
      recordedEvidence?: QaEvidenceSummaryJson;
    }) => ({
      evidence: _params.recordedEvidence,
      evidencePath: "/qa-output/qa-evidence.json",
      report: "",
      reportPath: "/qa-output/qa-suite-report.md",
      summaryPath: "/qa-output/qa-suite-summary.json",
    }),
  ),
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
  repoRoot?: string;
  onEvidence?: QaSuiteRunParams["onEvidence"];
  scenarios?: string[];
  concurrency?: number;
  factory: QaTransportAdapterFactory;
  lab: QaLabServerHandle;
  progressEnabled?: boolean;
  runChild: QaSuiteRunner;
}) {
  const repoRoot = params.repoRoot ?? (await tempDirs.makeTempDir("qa-parity-cleanup-"));
  return runQaRuntimeParitySuite({
    onEvidence: params.onEvidence,
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
    concurrency: params.concurrency ?? 1,
    selectedScenarios: (params.scenarios ?? ["runtime-cleanup"]).map((id) =>
      makeQaSuiteTestScenario(id),
    ),
    startLab: async () => params.lab,
    progressEnabled: params.progressEnabled ?? false,
    runtimePair: ["openclaw", "codex"],
  });
}

describe("runtime parity suite transport cleanup", () => {
  it.each(["cleanup", "publication", "ordinary"] as const)(
    "joins an earlier retryable cell and later %s failure before deciding retry",
    async (kind) => {
      vi.stubEnv("OPENCLAW_QA_SUITE_WORKER_START_STAGGER_MS", "0");
      const repoRoot = await tempDirs.makeTempDir("qa-parity-overlapping-failure-");
      const lab = createCleanupTestLab();
      const factory = createCleanupTestFactory(lab, () => ({}));
      const firstError = new QaSuiteInfraError("agent_wait_failed", "first cell disconnected");
      const siblingCause = new Error("sibling finalization failed");
      const bothStarted = createDeferred<void>();
      const firstRecorded = createDeferred<void>();
      const releaseSibling = createDeferred<void>();
      const started: string[] = [];
      let siblingError: unknown;
      let siblingJoined = false;
      const stop = vi.mocked(lab.stop).mockImplementation(async () => {
        expect(siblingJoined).toBe(true);
      });
      const runChild = vi.fn<QaSuiteRunner>().mockImplementation(async (params) => {
        const id = params!.scenarioIds![0]!;
        started.push(id);
        if (id === "first") {
          await bothStarted.promise;
          throw firstError;
        }
        bothStarted.resolve();
        await releaseSibling.promise;
        try {
          if (kind === "cleanup") {
            const cleanupFailures = await suite.runQaSuiteCleanupSteps([
              {
                phase: "lab stop",
                run: async () => {
                  throw siblingCause;
                },
              },
            ]);
            suite.throwQaSuiteCleanupErrors({
              cleanupFailures,
              runFailed: false,
              runError: undefined,
            });
          } else if (kind === "publication") {
            const child = await createQaSuiteEvidenceInvocation(params, {
              repoRoot,
              outputDir: params!.outputDir!,
              selectedScenarios: [makeQaSuiteTestScenario(id)],
              providerMode: "mock-openai",
              primaryModel: "mock-openai/test-model",
              transportId: "qa-channel",
            });
            const artifactDir = path.join(params!.outputDir!, "artifacts");
            await fs.mkdir(artifactDir, { recursive: true });
            await fs.writeFile(path.join(artifactDir, "occurrences"), "blocked directory");
            await child.record(0, child.invocation.begin(0), {
              name: id,
              status: "pass",
              steps: [],
            });
          }
          throw siblingCause;
        } catch (error) {
          siblingError = error;
          throw error;
        } finally {
          siblingJoined = true;
        }
      });
      const attempt = vi.fn(async (index: number) => {
        if (index > 0) {
          return "retried";
        }
        await runCleanupTestSuite({
          repoRoot,
          lab,
          factory,
          runChild,
          scenarios: ["first", "sibling", "unstarted"],
          concurrency: 2,
          onEvidence: (summary) => {
            if (
              summary.entries.some((entry) => entry.result.failure?.reason === firstError.message)
            ) {
              firstRecorded.resolve();
            }
          },
        });
        return "completed";
      });
      let settled = false;
      const pending = runQaSuiteWithInfraRetry(attempt).then(
        (result) => {
          settled = true;
          return result;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      await firstRecorded.promise;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(started).toEqual(["first", "sibling"]);
      expect(settled).toBe(false);
      expect(stop).not.toHaveBeenCalled();
      releaseSibling.resolve();
      const failure = await pending;
      if (kind === "ordinary") {
        expect(failure).toBe("retried");
        expect(attempt).toHaveBeenCalledTimes(2);
      } else {
        expect(attempt).toHaveBeenCalledOnce();
        expect(siblingError).toBeInstanceOf(
          kind === "cleanup" ? QaSuiteCleanupError : QaSuiteArtifactError,
        );
        expect(failure).toBeInstanceOf(
          kind === "cleanup" ? QaSuiteCleanupError : QaSuiteArtifactError,
        );
        const aggregate = kind === "cleanup" ? failure : (failure as QaSuiteArtifactError).cause;
        expect(aggregate).toBeInstanceOf(AggregateError);
        expect((aggregate as AggregateError).cause).toBe(firstError);
        expect((aggregate as AggregateError).errors).toHaveLength(2);
        expect((aggregate as AggregateError).errors[0]).toBe(firstError);
        expect((aggregate as AggregateError).errors[1]).toBe(siblingError);
      }
      expect(started).toEqual(["first", "sibling"]);
      expect(stop).toHaveBeenCalledOnce();
      expect(mocks.writeQaSuiteArtifacts).not.toHaveBeenCalled();
      expect(lab.setScenarioRun).not.toHaveBeenCalledWith(
        expect.objectContaining({ status: "completed" }),
      );
    },
  );

  it("retains typed publication identity when ordinary parity failure reconciliation cannot write", async () => {
    const repoRoot = await tempDirs.makeTempDir("qa-parity-publication-composition-");
    const lab = createCleanupTestLab();
    const factory = createCleanupTestFactory(lab, () => ({}));
    const original = new Error("ordinary cell failure");
    const runChild = vi.fn<QaSuiteRunner>().mockImplementation(async () => {
      const artifactDir = path.join(repoRoot, "output", "artifacts");
      await fs.mkdir(artifactDir, { recursive: true });
      await fs.writeFile(path.join(artifactDir, "occurrences"), "blocked evidence directory");
      throw original;
    });
    const failure = await runCleanupTestSuite({ repoRoot, lab, factory, runChild }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(QaSuiteCleanupError);
    expect(failure).toMatchObject({
      errors: [original, expect.objectContaining({ code: "publication_failed" })],
      cause: expect.objectContaining({ code: "publication_failed" }),
    });
    expect(runChild).toHaveBeenCalledOnce();
    expect(mocks.writeQaSuiteArtifacts).not.toHaveBeenCalled();
    expect(lab.setScenarioRun).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed" }),
    );
  });

  it.each(
    ["cleanup", "publication"].flatMap((kind) =>
      [false, true].map((reconciliationFails) => ({ kind, reconciliationFails })),
    ),
  )(
    "retains captured parity evidence before terminal $kind failure (reconciliation fails=$reconciliationFails)",
    async ({ kind, reconciliationFails }) => {
      const lab = createCleanupTestLab();
      const cleanup = vi.fn(async () => {});
      const factory = createCleanupTestFactory(lab, () => ({ cleanup }));
      const cause = new Error("cell finalization failed");
      const original =
        kind === "cleanup"
          ? new QaSuiteCleanupError([cause], cause.message, { cause })
          : new QaSuiteArtifactError("publication_failed", cause.message, { cause });
      const reconciliationError = new Error("parent evidence callback failed");
      const snapshots: QaEvidenceSummaryV3Json[] = [];
      const runChild = vi.fn<QaSuiteRunner>().mockImplementation(async (params) => {
        const child = await createQaSuiteEvidenceInvocation(params, {
          repoRoot: params!.repoRoot!,
          outputDir: params!.outputDir!,
          selectedScenarios: [makeQaSuiteTestScenario(params!.scenarioIds![0]!)],
          providerMode: "mock-openai",
          primaryModel: "mock-openai/test-model",
          transportId: "qa-channel",
        });
        const id = child.invocation.begin(0);
        await child.record(0, id, { name: "cell passed", status: "pass", steps: [] });
        throw original;
      });
      const error = await runCleanupTestSuite({
        factory,
        lab,
        runChild,
        scenarios: ["interrupted", "unstarted"],
        onEvidence: (summary) => {
          snapshots.push(summary);
          if (
            reconciliationFails &&
            summary.entries.some((entry) => entry.result.failure?.reason === original.message)
          ) {
            throw reconciliationError;
          }
        },
      }).catch((failure: unknown) => failure);
      if (reconciliationFails) {
        expect(error).toBeInstanceOf(QaSuiteCleanupError);
        expect(error).toMatchObject({ cause: original, errors: [original, reconciliationError] });
      } else {
        expect(error).toBe(original);
      }
      const final = snapshots.at(-1)!;
      expect(final.entries.map((entry) => entry.result.status)).toEqual(["pass", "fail"]);
      expect(final.entries[1]!.coverage).toEqual([]);
      expect(projectQaEvidenceScenarioOutcomes(final).map((outcome) => outcome.status)).toEqual([
        "fail",
        null,
      ]);
      expect(runChild).toHaveBeenCalledOnce();
      expect(mocks.writeQaSuiteArtifacts).not.toHaveBeenCalled();
      expect(lab.setScenarioRun).not.toHaveBeenCalledWith(
        expect.objectContaining({ status: "completed" }),
      );
      expect(cleanup).toHaveBeenCalledOnce();
      expect(lab.stop).toHaveBeenCalledOnce();
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

  it("does not publish parent artifacts when owned lab cleanup fails", async () => {
    const cleanupError = Object.assign(new Error("owned lab shutdown reset"), {
      code: "ECONNRESET",
    });
    const setLatestReport = vi.fn<QaLabServerHandle["setLatestReport"]>();
    const stopLab = vi.fn<QaLabServerHandle["stop"]>(async () => {
      throw cleanupError;
    });
    const lab = createCleanupTestLab();
    lab.setLatestReport = setLatestReport;
    lab.stop = stopLab;
    const cleanup = vi.fn(async () => {});
    const factory = createCleanupTestFactory(lab, () => ({ cleanup }));
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

    try {
      const thrown = await runCleanupTestSuite({
        factory,
        lab,
        progressEnabled: true,
        runChild,
      }).catch((error: unknown) => error);

      expect(cleanup).toHaveBeenCalledOnce();
      expect(mocks.writeQaSuiteArtifacts).not.toHaveBeenCalled();
      expect(setLatestReport).not.toHaveBeenCalled();
      expect(lab.setScenarioRun).not.toHaveBeenCalledWith(
        expect.objectContaining({ status: "completed" }),
      );
      expect((thrown as Error).message.split("\n")[0]).toBe(
        "QA scenarios passed, but cleanup failed",
      );
      expect((thrown as Error).message).toContain(
        "failed cleanup phases: lab stop: owned lab shutdown reset",
      );
      expect((thrown as Error).cause).toBe(cleanupError);
      expect(stderrWrite.mock.calls.flat().join("")).not.toContain("run complete");
    } finally {
      stderrWrite.mockRestore();
    }
  });

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

    const result = await runCleanupTestSuite({ factory, lab, runChild });

    expect(result.startedScenarioIds).toEqual([]);
    expect(runChild).toHaveBeenCalledTimes(2);
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
