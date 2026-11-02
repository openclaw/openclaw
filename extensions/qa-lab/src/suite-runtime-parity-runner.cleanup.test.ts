import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeRuntimeParitySummary } from "./agentic-parity-report-test-helpers.js";
import {
  buildQaRuntimeParityReport,
  renderQaRuntimeParityMarkdownReport,
} from "./agentic-parity-report.js";
import { createQaBusState } from "./bus-state.js";
import {
  projectQaEvidenceScenarioOutcomes,
  type QaEvidenceSummaryV3Json,
} from "./evidence-summary.js";
import type { QaLabServerHandle } from "./lab-server.types.js";
import {
  createQaTransportAdapter,
  type QaTransportAdapterFactory,
} from "./qa-transport-registry.js";
import type { RuntimeParityScenarioExecution } from "./runtime-parity.js";
import * as scenarioCatalog from "./scenario-catalog.js";
import type { writeQaSuiteArtifacts } from "./suite-artifacts.js";
import * as suiteRunStandard from "./suite-run-standard.js";
import { runQaFlowSuiteFromRuntime } from "./suite-run.runtime.js";
import {
  artifactPaths,
  childResult,
  createTestLab,
  runtimeCell,
} from "./suite-runtime-parity.test-support.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";
import type { QaSuiteRunner, QaSuiteRunParams, QaSuiteScenarioRunner } from "./suite-types.js";
import * as suite from "./suite.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const tempDirs = createTempDirHarness();
const runtimeOptions = {
  providerMode: "mock-openai" as const,
  primaryModel: "mock-openai/test-model",
  alternateModel: "mock-openai/test-model-alt",
};
const createTransport = vi.hoisted(
  () =>
    (id: string, label: string): Awaited<ReturnType<QaTransportAdapterFactory["create"]>> => ({
      id,
      label,
      accountId: "sut",
      requiredPluginIds: [],
      supportedActions: [],
      sendInbound: vi.fn(async () => {
        throw new Error("Unexpected inbound message in parity cleanup fixture");
      }),
      createGatewayConfig: () => ({}),
      waitReady: vi.fn(async () => {}),
      buildAgentDelivery: ({ target }) => ({
        channel: id,
        to: target,
        replyChannel: id,
        replyTo: target,
      }),
      handleAction: vi.fn(async () => {}),
      createReportNotes: () => [],
    }),
);

const mocks = vi.hoisted(() => ({
  captureRuntimeParityCell: vi.fn(
    async (params: { runtime: "openclaw" | "codex"; wallClockMs: number }) =>
      runtimeCell(params.runtime, params.wallClockMs),
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
  })),
  writeQaSuiteArtifacts: vi.fn<typeof writeQaSuiteArtifacts>(async (params) => ({
    evidence: params.recordedEvidence,
    ...artifactPaths,
  })),
}));

vi.mock("openclaw/plugin-sdk/agent-harness", () => ({
  disposeRegisteredAgentHarnesses: mocks.disposeRegisteredAgentHarnesses,
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
}));
// mock-isolation: lifecycle cleanup uses synthetic transports, not live Crabline clients.
vi.mock("./crabline-transport.js", () => {
  const create = vi.fn(async () => ({
    ...createTransport("telegram", "Crabline Telegram"),
    captureArtifacts: vi.fn(async () => ({
      artifacts: [{ kind: "channel-driver-smoke", path: "/qa-output/driver-smoke.json" }],
      reportNotes: [],
    })),
    cleanupAfterGatewayStop: vi.fn(async () => {}),
  }));
  return {
    createQaCrablineTransportAdapter: create,
    createQaCrablineTransportDefinition: create,
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
        ...createTransport("leased", "Leased channel"),
        sendInbound: async (input) => lab.state.addInboundMessage(input),
        ...cleanupPhases,
      };
    },
  };
}

async function runCleanupTestSuite(params: {
  factory: QaTransportAdapterFactory;
  lab: QaLabServerHandle;
  progressEnabled?: boolean;
  runChild: QaSuiteRunner;
}) {
  vi.spyOn(suite, "shouldLogQaSuiteProgress").mockReturnValue(params.progressEnabled ?? false);
  vi.spyOn(suiteRunStandard, "runQaFlowSuiteStandard").mockImplementation((childParams) =>
    params.runChild(childParams),
  );
  return runFlow([makeQaSuiteTestScenario("runtime-cleanup")], {
    adapterFactories: [params.factory],
    channelDriver: "live",
    channelId: "leased",
    transportId: "qa-channel",
    fastMode: true,
    startLab: async () => params.lab,
    runtimePair: ["openclaw", "codex"],
  });
}

function createCleanupTestChild(
  lab: QaLabServerHandle,
  startedScenarioIds: string[] = ["runtime-cleanup"],
) {
  return vi.fn<QaSuiteRunner>().mockImplementation(async (params) => ({
    ...childResult(params, [makeQaSuiteTestScenario("runtime-cleanup")], "/qa-child"),
    startedScenarioIds,
    watchUrl: lab.baseUrl,
  }));
}

async function runFlow(scenarios: Parameters<typeof childResult>[1], params: QaSuiteRunParams) {
  const repoRoot = await tempDirs.makeTempDir("qa-runtime-");
  vi.spyOn(scenarioCatalog, "readQaBootstrapScenarioCatalog").mockReturnValue({
    agentIdentityMarkdown: "test",
    kickoffTask: "test",
    scenarios: [...scenarios],
  });
  return runQaFlowSuiteFromRuntime({
    repoRoot,
    outputDir: path.join(repoRoot, "output"),
    ...runtimeOptions,
    concurrency: 1,
    startLab: async () => createTestLab(),
    ...params,
  });
}

async function runParityProjection(
  scenario: ReturnType<typeof makeQaSuiteTestScenario>,
  executions: Record<"openclaw" | "codex", RuntimeParityScenarioExecution>,
) {
  const runScenario = vi.spyOn(suite, "runQaSuiteScenarioDefinitionForRuntime");
  for (const runtime of ["openclaw", "codex"] as const) {
    const execution = executions[runtime];
    runScenario.mockResolvedValueOnce({
      name: scenario.title,
      status: execution.status,
      details: execution.details,
      steps: [],
    });
    mocks.captureRuntimeParityCell.mockResolvedValueOnce(execution.cell);
  }
  const result = await runFlow([scenario], {
    channelId: "telegram",
    channelDriver: "crabline",
    runtimePair: ["openclaw", "codex"],
  });
  return result.scenarios[0]!;
}

describe("QA suite runtime parity result projection", () => {
  it("combines result-cell status with execution errors without losing skip details", async () => {
    const failed = await runParityProjection(
      { ...makeQaSuiteTestScenario("runtime-tool-read"), title: "Runtime tool fixture — read" },
      {
        openclaw: {
          status: "skip",
          cell: runtimeCell("openclaw"),
          details:
            "implementation unavailable\nRUNTIME_PARITY_SESSION_KEY=agent:qa:runtime-tool:read:happy",
        },
        codex: {
          status: "pass",
          cell: { ...runtimeCell("codex"), runtimeErrorClass: "scenario-failure" },
        },
      },
    );
    expect(failed.status).toBe("fail");
    expect(failed.steps?.map((step) => step.status)).toEqual(["skip", "fail", "fail"]);
    expect(failed.steps?.[0]?.details).toContain(
      "RUNTIME_PARITY_SESSION_KEY=agent:qa:runtime-tool:read:happy",
    );
  });

  it.each([
    { description: "known harness gap", knownGap: true, bothSkipped: false, pass: true },
    { description: "unexpected skip", knownGap: false, bothSkipped: false, pass: false },
    { description: "both runtimes skipped", knownGap: true, bothSkipped: true, pass: false },
  ])(
    "preserves $description in runtime parity evidence",
    async ({ knownGap, bothSkipped, pass }) => {
      const catalogScenario = scenarioCatalog.readQaScenarioById("compaction-retry-mutating-tool");
      const summary = makeRuntimeParitySummary();
      const captured = summary.scenarios[1]!.runtimeParity!;
      summary.scenarios[1] = await runParityProjection(
        { ...makeQaSuiteTestScenario(catalogScenario.id), title: catalogScenario.title },
        {
          openclaw: { status: bothSkipped ? "skip" : "pass", cell: captured.cells.openclaw },
          codex: {
            status: "skip",
            details: knownGap
              ? "known-harness-gap compaction-retry-mutating-tool: native compaction"
              : "implementation unavailable",
            cell: captured.cells.codex,
          },
        },
      );
      const report = buildQaRuntimeParityReport({ summary });
      expect(report.pass).toBe(pass);
      expect(report.scenarios[1]).toMatchObject({
        status: pass ? "pass" : "fail",
        openclawStatus: bothSkipped ? "skip" : "pass",
        codexStatus: "skip",
        drift: pass ? "structural" : "failure-mode",
      });
      const steps = summary.scenarios[1]?.steps?.map((step) => step.status);
      expect(steps).toEqual([bothSkipped ? "skip" : "pass", "skip", pass ? "pass" : "skip"]);
      expect(summary.scenarios[1]?.status).toBe(pass ? "pass" : "skip");
      expect(summary.scenarios[1]?.steps?.[1]?.details).toContain(
        knownGap ? "known-harness-gap" : "implementation unavailable",
      );
      expect(renderQaRuntimeParityMarkdownReport(report)).toContain("- codex: skip (");
    },
  );

  it("projects controlled tool-error cells as passing with advisory drift", async () => {
    const summary = makeRuntimeParitySummary();
    const scenario = summary.scenarios[1]!;
    const { cells, scenarioId } = scenario.runtimeParity!;
    cells.codex.runtimeErrorClass = "tool-error";
    summary.scenarios[1] = await runParityProjection(
      { ...makeQaSuiteTestScenario(scenarioId), title: scenario.name },
      {
        openclaw: { status: "pass", cell: cells.openclaw },
        codex: { status: "pass", cell: cells.codex },
      },
    );
    expect(summary.scenarios[1]?.steps?.map((step) => step.status)).toEqual([
      "pass",
      "pass",
      "pass",
    ]);
    expect(buildQaRuntimeParityReport({ summary })).toMatchObject({
      pass: true,
      failedScenarios: 0,
      failures: [],
      scenarios: [{}, { codexStatus: "pass" }],
    });
  });
});

describe("runtime parity suite transport cleanup", () => {
  it("executes repeated flow instances in request order through the standard producer", async () => {
    const scenarios = [makeQaSuiteTestScenario("first"), makeQaSuiteTestScenario("second")];
    const observed: string[] = [];
    vi.spyOn(suite, "runQaSuiteScenarioDefinitionForRuntime").mockImplementation(
      async (_env, scenario) => {
        observed.push(scenario.id);
        return {
          name: scenario.title,
          status: "pass",
          details: `invocation ${observed.length}`,
          steps: [],
        };
      },
    );
    const lab = createTestLab();
    const result = await runFlow(scenarios, {
      scenarioIds: ["first", "second", "first"],
      lab,
      startLab: async () => lab,
    });
    const evidence = result.evidence as QaEvidenceSummaryV3Json;
    expect(observed).toEqual(["first", "second", "first"]);
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
    const lab = createTestLab({ setLatestReport, stop: stopLab });
    const cleanup = vi.fn(async () => {});
    const factory = createCleanupTestFactory(lab, () => ({ cleanup }));
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const runChild = createCleanupTestChild(lab);

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
  });

  it("reports a parity scenario only after a nested producer starts it", async () => {
    const lab = createTestLab();
    const cleanup = vi.fn(async () => {});
    const factory = createCleanupTestFactory(lab, () => ({ cleanup }));
    const runChild = createCleanupTestChild(lab, []);

    const result = await runCleanupTestSuite({ factory, lab, runChild });

    expect(result.startedScenarioIds).toEqual([]);
    expect(runChild).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])(
    "preserves runtime preparation publication ownership with parity=%s",
    async (parity) => {
      vi.stubEnv("OPENCLAW_QA_SUITE_PROGRESS", "1");
      const scenario = makeQaSuiteTestScenario("runtime-cleanup");
      const labs = Array.from({ length: parity ? 3 : 1 }, () => createTestLab());
      const startLab = vi.fn<() => Promise<QaLabServerHandle>>();
      for (const lab of labs) {
        startLab.mockResolvedValueOnce(lab);
      }
      const runScenario = vi
        .fn<QaSuiteScenarioRunner>()
        .mockResolvedValue({ name: scenario.title, status: "pass", steps: [] });
      vi.spyOn(suite, "runQaSuiteScenarioDefinitionForRuntime").mockImplementation(runScenario);
      const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const result = await runFlow([scenario], {
        transportId: "qa-channel",
        fastMode: true,
        channelId: "telegram",
        channelDriver: "crabline",
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
    },
  );

  it("releases an exclusive parent lease before its first runtime child acquires it", async () => {
    const events: string[] = [];
    const childError = new Error("first runtime child completed");
    let activeOwner: "parent" | "child" | undefined;
    let leaseCount = 0;
    const lab = createTestLab({
      stop: vi.fn(async () => {
        events.push("lab:stop");
      }),
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

  it("retains failed parent cleanupAfterGatewayStop without replaying cleanup before stopping its owned lab", async () => {
    const lab = createTestLab();
    const cleanupError = new Error("credential release failed");
    const cleanup = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(cleanupError)
      .mockResolvedValueOnce(undefined);
    const factory = createCleanupTestFactory(lab, () => ({ cleanupAfterGatewayStop: cleanup }));
    const runChild = vi.fn<QaSuiteRunner>();

    await expect(runCleanupTestSuite({ factory, lab, runChild })).rejects.toMatchObject({
      cause: cleanupError,
      errors: [cleanupError, cleanupError],
    });

    expect(cleanup).toHaveBeenCalledOnce();
    expect(runChild).not.toHaveBeenCalled();
    expect(lab.stop).toHaveBeenCalledOnce();
  });
});
