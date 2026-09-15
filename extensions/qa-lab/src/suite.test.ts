// Qa Lab tests cover suite plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QaLabServerHandle } from "./lab-server.types.js";
import { sanitizeQaProgressValue as sanitizeQaSuiteProgressValue } from "./progress-format.js";
import type { QaTransportAdapter } from "./qa-transport.js";
import {
  buildQaGatewayHeapCheckpointRuntimeEnvPatch,
  buildQaIsolatedScenarioWorkerParams,
  mergeQaRuntimeEnvPatches,
  remapModelRefForForcedRuntime,
} from "./suite-support.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";
import type { QaSuiteResult } from "./suite-types.js";
import {
  buildQaSuiteRuntimeMetrics,
  createQaSuiteTransportAdapter,
  formatQaSuiteRunStartProgress,
  resolveQaSuiteTransportReadyTimeoutMs,
  runQaFlowSuite,
  runQaFlowSuiteCleanupPlan,
  shouldLogQaSuiteProgress,
  shouldRunQaSuiteWithIsolatedScenarioWorkers,
  throwQaSuiteCleanupErrors,
  waitForQaLabReadyOrStopOwned,
} from "./suite.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

afterEach(() => {
  fetchWithSsrFGuardMock.mockReset();
  vi.useRealTimers();
});

function makeQaSuiteTestLabHandle(): QaLabServerHandle {
  return {
    baseUrl: "http://127.0.0.1:43123",
    listenUrl: "http://127.0.0.1:43123",
    state: {} as QaLabServerHandle["state"],
    setControlUi: vi.fn(),
    setScenarioRun: vi.fn(),
    setLatestReport: vi.fn(),
    runSelfCheck: vi.fn(async () => ({}) as Awaited<ReturnType<QaLabServerHandle["runSelfCheck"]>>),
    stop: vi.fn(async () => {}),
  };
}

describe("qa suite", () => {
  it("runs the production cleanup plan in dependency order after a failure", async () => {
    const calls: string[] = [];
    const transportFailure = new Error("transport close failed");
    const providerFailure = new Error("provider close failed");
    const step = (name: string, error?: Error) => async () => {
      calls.push(name);
      if (error) {
        throw error;
      }
    };

    const failures = await runQaFlowSuiteCleanupPlan({
      closeWebSessions: step("web sessions"),
      cleanupTransportBeforeGatewayStop: step("transport before gateway", transportFailure),
      cleanupTransportAfterGatewayStop: step("transport after gateway"),
      stopGateway: async () => {
        await step("gateway")();
        return { process: "confirmed-stopped", errors: [] };
      },
      disposeAgentHarnesses: step("agent harnesses"),
      stopProvider: step("provider", providerFailure),
      finishLab: step("lab"),
    });

    expect(calls).toEqual([
      "web sessions",
      "transport before gateway",
      "gateway",
      "transport after gateway",
      "agent harnesses",
      "provider",
      "lab",
    ]);
    expect(failures).toEqual([
      { phase: "transport before gateway stop", error: transportFailure },
      { phase: "provider stop", error: providerFailure },
    ]);
  });

  it("keeps the primary suite error as the cause of aggregated cleanup failures", () => {
    const runError = new Error("gateway infrastructure failed");
    const cleanupError = new Error("transport cleanup failed");

    let thrown: unknown;
    try {
      throwQaSuiteCleanupErrors({
        cleanupFailures: [{ phase: "transport before gateway stop", error: cleanupError }],
        runFailed: true,
        runError,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      cause: runError,
      errors: [runError, cleanupError],
    });
    expect((thrown as Error).message.split("\n")[0]).toBe("QA suite and cleanup failed");
    expect((thrown as Error).message).toContain(
      "failed cleanup phases: transport before gateway stop: transport cleanup failed",
    );
  });

  it("reports cleanup failure before scenarios completed when no result exists", () => {
    const cleanupError = new Error("stop failed");
    let thrown: unknown;
    try {
      throwQaSuiteCleanupErrors({
        cleanupFailures: [{ phase: "lab stop", error: cleanupError }],
        runFailed: false,
        runError: undefined,
      });
    } catch (error) {
      thrown = error;
    }

    expect((thrown as Error).message.split("\n")[0]).toBe(
      "QA suite cleanup failed before scenarios completed",
    );
    expect((thrown as Error).cause).toBe(cleanupError);
  });

  it("reports completed counts, labeled failures, and only written artifact paths", () => {
    const result = {
      outputDir: "/qa-output\nretained",
      evidencePath: "/qa-output/qa-evidence.json",
      reportPath: "/qa-output/qa-suite-report.md",
      summaryPath: "/qa-output/qa-suite-summary.json",
      report: "",
      scenarios: [
        { name: "pass", status: "pass", steps: [] },
        { name: "fail", status: "fail", steps: [] },
        { name: "skip", status: "skip", steps: [] },
      ],
      startedScenarioIds: ["pass", "fail", "skip"],
      watchUrl: "http://127.0.0.1:43123",
    } satisfies QaSuiteResult;

    let thrown: unknown;
    try {
      throwQaSuiteCleanupErrors({
        cleanupFailures: [
          { phase: "agent\nharnesses", error: new Error("dispose failed") },
          { phase: "lab stop", error: new Error("stop failed") },
        ],
        runFailed: false,
        runError: undefined,
        result,
        evidenceWritten: false,
      });
    } catch (error) {
      thrown = error;
    }

    expect((thrown as Error).message).toBe(
      [
        "QA scenarios completed, but cleanup failed",
        "scenario counts: passed=1 failed=1 skipped=1 total=3",
        "failed cleanup phases: agent harnesses: dispose failed; lab stop: stop failed",
        "retained artifacts: output=/qa-output retained report=/qa-output/qa-suite-report.md summary=/qa-output/qa-suite-summary.json",
      ].join("\n"),
    );
    expect("cause" in (thrown as object)).toBe(false);
    expect((thrown as Error).message).not.toContain("evidence=");
  });

  it.each(["never-spawned", "confirmed-stopped", "unconfirmed"] as const)(
    "gates after-stop cleanup on %s, independently of diagnostic errors",
    async (process) => {
      const diagnostic = new Error("cleanup diagnostic failed");
      const release = vi.fn(async () => {});
      const finishLab = vi.fn(async () => {});
      const failures = await runQaFlowSuiteCleanupPlan({
        cleanupTransportBeforeGatewayStop: async () => {},
        cleanupTransportAfterGatewayStop: release,
        stopGateway: async () => ({ process, errors: [diagnostic] }),
        disposeAgentHarnesses: async () => {},
        finishLab,
      });
      expect(release).toHaveBeenCalledTimes(process === "unconfirmed" ? 0 : 1);
      expect(failures).toEqual([
        { phase: "gateway stop", error: expect.objectContaining({ errors: [diagnostic] }) },
      ]);
      expect(finishLab).toHaveBeenCalledOnce();
    },
  );

  it("rejects unsupported transport ids before starting the lab", async () => {
    const startLab = vi.fn();

    await expect(
      runQaFlowSuite({
        transportId: "qa-nope" as unknown as "qa-channel",
        startLab,
      }),
    ).rejects.toThrow("unsupported QA transport: qa-nope");

    expect(startLab).not.toHaveBeenCalled();
  });

  it("keeps metadata-only live channel drivers on the shared QA transport", async () => {
    const create = vi.fn();

    await expect(
      createQaSuiteTransportAdapter({
        adapterFactories: [{ id: "telegram", matches: () => true, create }],
        channelDriver: "live",
        outputDir: "/tmp/qa-output",
        state: {} as QaLabServerHandle["state"],
        transportId: "qa-channel",
      }),
    ).resolves.toMatchObject({ adapter: { id: "qa-channel" }, driver: "qa-channel" });

    expect(create).not.toHaveBeenCalled();
  });

  it("uses a contributed live adapter when its channel is selected", async () => {
    const adapter = { id: "telegram" } as QaTransportAdapter;
    const create = vi.fn(async () => adapter);

    await expect(
      createQaSuiteTransportAdapter({
        adapterFactories: [{ id: "telegram", matches: () => true, create }],
        channelDriver: "live",
        channelId: "telegram",
        outputDir: "/tmp/qa-output",
        transportPolicy: { requireGroupMention: true },
        state: {} as QaLabServerHandle["state"],
        transportId: "qa-channel",
      }),
    ).resolves.toMatchObject({ adapter, driver: "live" });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterOptions: expect.objectContaining({
          transportPolicy: { requireGroupMention: true },
        }),
      }),
    );
  });

  it("preserves caller-supplied transport policy without scenario metadata", async () => {
    const adapter = { id: "telegram" } as QaTransportAdapter;
    const create = vi.fn(async () => adapter);

    await createQaSuiteTransportAdapter({
      adapterFactories: [{ id: "telegram", matches: () => true, create }],
      adapterOptions: { transportPolicy: { topLevelReplies: true } },
      channelDriver: "live",
      channelId: "telegram",
      outputDir: "/tmp/qa-output",
      state: {} as QaLabServerHandle["state"],
      transportId: "qa-channel",
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterOptions: { transportPolicy: { topLevelReplies: true } },
      }),
    );
  });

  it("stops an owned lab when readiness never becomes healthy", async () => {
    const stop = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: { ok: false },
      release: vi.fn(async () => {}),
    });

    await expect(
      waitForQaLabReadyOrStopOwned({
        lab: {
          listenUrl: "http://127.0.0.1:43123",
          stop,
        },
        ownsLab: true,
        timeoutMs: 1,
      }),
    ).rejects.toThrow("timed out after 1ms waiting for qa-lab ready");
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("cancels a successful lab readiness body before releasing its guard", async () => {
    const events: string[] = [];
    const stop = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            events.push("cancel");
          },
        }),
        { status: 200 },
      ),
      release: async () => {
        events.push("release");
      },
    });

    await expect(
      waitForQaLabReadyOrStopOwned({
        lab: {
          listenUrl: "http://127.0.0.1:43123",
          stop,
        },
        ownsLab: false,
      }),
    ).resolves.toBeUndefined();

    expect(events).toEqual(["cancel", "release"]);
    expect(stop).not.toHaveBeenCalled();
  });

  it("bounds a hung lab readiness request by the remaining startup deadline", async () => {
    vi.useFakeTimers();
    const stop = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockImplementation(
      async ({ timeoutMs }: { timeoutMs: number }) =>
        await new Promise((_, reject) => {
          setTimeout(() => reject(new Error("request timed out")), timeoutMs);
        }),
    );

    const readiness = waitForQaLabReadyOrStopOwned({
      lab: {
        listenUrl: "http://127.0.0.1:43123",
        stop,
      },
      ownsLab: true,
      timeoutMs: 1_000,
    });
    const rejection = expect(readiness).rejects.toThrow(
      "timed out after 1000ms waiting for qa-lab ready",
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 1_000 }),
    );
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("leaves caller-owned labs running when readiness never becomes healthy", async () => {
    const stop = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: { ok: false },
      release: vi.fn(async () => {}),
    });

    await expect(
      waitForQaLabReadyOrStopOwned({
        lab: {
          listenUrl: "http://127.0.0.1:43123",
          stop,
        },
        ownsLab: false,
        timeoutMs: 1,
      }),
    ).rejects.toThrow("timed out after 1ms waiting for qa-lab ready");
    expect(stop).not.toHaveBeenCalled();
  });

  it("defaults progress logging from CI when no override is set", () => {
    expect(shouldLogQaSuiteProgress({ CI: "true" })).toBe(true);
    expect(shouldLogQaSuiteProgress({ CI: "false" })).toBe(false);
  });

  it("resolves transport-ready timeout from params and env", () => {
    expect(resolveQaSuiteTransportReadyTimeoutMs(undefined, {})).toBe(120_000);
    expect(
      resolveQaSuiteTransportReadyTimeoutMs(undefined, {
        OPENCLAW_QA_TRANSPORT_READY_TIMEOUT_MS: "180000",
      }),
    ).toBe(180_000);
    expect(
      resolveQaSuiteTransportReadyTimeoutMs(undefined, {
        OPENCLAW_QA_TRANSPORT_READY_TIMEOUT_MS: "bad",
      }),
    ).toBe(120_000);
    for (const value of ["0x10", "1e3", "10.5"]) {
      expect(
        resolveQaSuiteTransportReadyTimeoutMs(undefined, {
          OPENCLAW_QA_TRANSPORT_READY_TIMEOUT_MS: value,
        }),
      ).toBe(120_000);
    }
    expect(resolveQaSuiteTransportReadyTimeoutMs(90_000, {})).toBe(90_000);
  });

  it("applies OPENCLAW_QA_SUITE_PROGRESS override and falls back on invalid values", () => {
    expect(
      shouldLogQaSuiteProgress({
        CI: "false",
        OPENCLAW_QA_SUITE_PROGRESS: "true",
      }),
    ).toBe(true);
    expect(
      shouldLogQaSuiteProgress({
        CI: "true",
        OPENCLAW_QA_SUITE_PROGRESS: "false",
      }),
    ).toBe(false);
    expect(
      shouldLogQaSuiteProgress({
        CI: "false",
        OPENCLAW_QA_SUITE_PROGRESS: "on",
      }),
    ).toBe(true);
    expect(
      shouldLogQaSuiteProgress({
        CI: "true",
        OPENCLAW_QA_SUITE_PROGRESS: "off",
      }),
    ).toBe(false);
    expect(
      shouldLogQaSuiteProgress({
        CI: "true",
        OPENCLAW_QA_SUITE_PROGRESS: "definitely",
      }),
    ).toBe(true);
  });

  it("sanitizes scenario ids for progress logs", () => {
    expect(sanitizeQaSuiteProgressValue("scenario-id")).toBe("scenario-id");
    expect(sanitizeQaSuiteProgressValue("scenario\nid\tvalue")).toBe("scenario id value");
    expect(sanitizeQaSuiteProgressValue("\u0000\u0001")).toBe("<empty>");
  });

  it("includes effective channel driver in run start progress logs", () => {
    expect(
      formatQaSuiteRunStartProgress({
        selectedScenarioCount: 80,
        concurrency: 8,
        transportId: "qa-channel",
      }),
    ).toBe("run start: scenarios=80 concurrency=8 transport=qa-channel");

    expect(
      formatQaSuiteRunStartProgress({
        selectedScenarioCount: 80,
        concurrency: 1,
        transportId: "qa-channel",
        channelDriverSelection: {
          capabilityMatrixPath: "crabline-channel-driver-capabilities.json",
          channel: "telegram",
          channelDriver: "crabline",
          providerReadinessArtifactPath: "crabline-provider-readiness.json",
        },
      }),
    ).toBe(
      "run start: scenarios=80 concurrency=1 transport=qa-channel channelDriver=crabline channel=telegram",
    );
  });

  it("records gateway RSS peak and trace samples", () => {
    expect(
      buildQaSuiteRuntimeMetrics({
        startedAt: new Date("2026-04-22T12:00:00.000Z"),
        finishedAt: new Date("2026-04-22T12:00:12.000Z"),
        gatewayProcessCpuStartMs: 1_000,
        gatewayProcessCpuEndMs: 4_000,
        gatewayProcessRssStartBytes: 100_000_000,
        gatewayProcessRssEndBytes: 125_000_000,
        gatewayProcessRssSamples: [
          {
            label: "suite-start",
            at: "2026-04-22T12:00:00.000Z",
            gatewayProcessRssBytes: 100_000_000,
          },
          {
            label: "scenario:canary:finish",
            at: "2026-04-22T12:00:10.000Z",
            gatewayProcessRssBytes: 140_000_000,
          },
        ],
        gatewayHeapSnapshots: [
          {
            label: "suite-start",
            at: "2026-04-22T12:00:01.000Z",
            path: "artifacts/gateway-heap-snapshots/suite-start.heapsnapshot",
            bytes: 12_345,
          },
        ],
      }),
    ).toEqual({
      wallMs: 12_000,
      gatewayProcessCpuMs: 3_000,
      gatewayCpuCoreRatio: 0.25,
      gatewayProcessRssStartBytes: 100_000_000,
      gatewayProcessRssEndBytes: 125_000_000,
      gatewayProcessRssDeltaBytes: 25_000_000,
      gatewayProcessRssPeakBytes: 140_000_000,
      gatewayProcessRssPeakDeltaBytes: 40_000_000,
      gatewayProcessRssSamples: [
        {
          label: "suite-start",
          at: "2026-04-22T12:00:00.000Z",
          gatewayProcessRssBytes: 100_000_000,
        },
        {
          label: "scenario:canary:finish",
          at: "2026-04-22T12:00:10.000Z",
          gatewayProcessRssBytes: 140_000_000,
        },
      ],
      gatewayHeapSnapshots: [
        {
          label: "suite-start",
          at: "2026-04-22T12:00:01.000Z",
          path: "artifacts/gateway-heap-snapshots/suite-start.heapsnapshot",
          bytes: 12_345,
        },
      ],
    });
  });

  it("arms gateway heap checkpoint env only when requested", () => {
    expect(
      buildQaGatewayHeapCheckpointRuntimeEnvPatch({
        OPENCLAW_QA_GATEWAY_HEAP_CHECKPOINTS: "0",
      }),
    ).toBeUndefined();
    expect(
      buildQaGatewayHeapCheckpointRuntimeEnvPatch({
        OPENCLAW_QA_GATEWAY_HEAP_CHECKPOINTS: "1",
        NODE_OPTIONS: "--max-old-space-size=4096",
      }),
    ).toEqual({
      NODE_OPTIONS: "--max-old-space-size=4096 --heapsnapshot-signal=SIGUSR2",
    });
    expect(
      mergeQaRuntimeEnvPatches(
        { OPENAI_API_KEY: "mock" },
        { NODE_OPTIONS: "--heapsnapshot-signal=SIGUSR2" },
      ),
    ).toEqual({
      OPENAI_API_KEY: "mock",
      NODE_OPTIONS: "--heapsnapshot-signal=SIGUSR2",
    });
  });

  it("forwards run options into isolated scenario worker params", () => {
    const startLab = vi.fn();
    const adapterFactory = {
      id: "telegram",
      matches: vi.fn(() => true),
      create: vi.fn(),
    };
    const scenario = makeQaSuiteTestScenario("patched-control-ui", {
      surface: "control-ui",
      gatewayConfigPatch: {
        messages: {
          groupChat: {
            visibleReplies: "message_tool",
          },
        },
      },
    });
    const sutOpenClawCommand = {
      executablePath: "/usr/local/bin/openclaw-telegram-sut-launcher",
      usePackagedPlugins: true,
    };

    expect(
      buildQaIsolatedScenarioWorkerParams({
        repoRoot: "/repo",
        outputDir: "/repo/.artifacts/qa-e2e/scenarios/patched-control-ui",
        providerMode: "mock-openai",
        transportId: "qa-channel",
        primaryModel: "mock-openai/gpt-5.6-luna",
        alternateModel: "mock-openai/gpt-5.6-luna-alt",
        fastMode: true,
        scenario,
        startLab,
        input: {
          adapterFactories: [adapterFactory],
          channelId: "telegram",
          adapterOptions: { repoRoot: "/repo" },
          sutOpenClawCommand,
          thinkingDefault: "minimal",
          claudeCliAuthMode: "subscription",
          enabledPluginIds: ["acpx"],
          transportReadyTimeoutMs: 180_000,
          forcedRuntime: "codex",
          writeEvidenceFile: false,
        },
      }),
    ).toMatchObject({
      scenarioIds: ["patched-control-ui"],
      adapterFactories: [adapterFactory],
      channelId: "telegram",
      adapterOptions: { repoRoot: "/repo" },
      sutOpenClawCommand,
      concurrency: 1,
      startLab,
      controlUiEnabled: true,
      thinkingDefault: "minimal",
      claudeCliAuthMode: "subscription",
      enabledPluginIds: ["acpx"],
      transportReadyTimeoutMs: 180_000,
      forcedRuntime: "codex",
      writeEvidenceFile: false,
    });
  });

  it.each([
    { surface: "channel", explicit: undefined, expected: false },
    { surface: "channel", explicit: true, expected: true },
    { surface: "control-ui", explicit: undefined, expected: true },
    { surface: "control-ui", explicit: false, expected: false },
  ])(
    "preserves an explicit Control UI override for isolated $surface scenarios",
    ({ surface, explicit, expected }) => {
      const scenario = makeQaSuiteTestScenario("isolated-control-ui-ownership", { surface });

      expect(
        buildQaIsolatedScenarioWorkerParams({
          repoRoot: "/repo",
          outputDir: "/repo/.artifacts/qa-e2e/scenarios/isolated-control-ui-ownership",
          providerMode: "mock-openai",
          transportId: "qa-channel",
          primaryModel: "mock-openai/gpt-5.6-luna",
          alternateModel: "mock-openai/gpt-5.6-luna-alt",
          fastMode: true,
          scenario,
          startLab: vi.fn(),
          ...(explicit === undefined ? {} : { input: { controlUiEnabled: explicit } }),
        }).controlUiEnabled,
      ).toBe(expected);
    },
  );

  it("keeps caller-owned serial labs on shared workers without a launcher", () => {
    const scenarios = [
      makeQaSuiteTestScenario("baseline"),
      makeQaSuiteTestScenario("message-tool-mode", {
        gatewayConfigPatch: {
          messages: {
            groupChat: {
              visibleReplies: "message_tool",
            },
          },
        },
      }),
    ];
    const lab = makeQaSuiteTestLabHandle();
    const startLab = vi.fn();

    expect(
      shouldRunQaSuiteWithIsolatedScenarioWorkers({
        scenarios,
        concurrency: 1,
        lab,
      }),
    ).toBe(false);
    expect(
      shouldRunQaSuiteWithIsolatedScenarioWorkers({
        scenarios,
        concurrency: 1,
        lab,
        startLab,
      }),
    ).toBe(true);
  });

  it("remaps mock-openai model refs onto the app-server OpenAI provider for codex cells only", () => {
    expect(
      remapModelRefForForcedRuntime({
        modelRef: "mock-openai/gpt-5.6-luna",
        providerMode: "mock-openai",
        forcedRuntime: "codex",
      }),
    ).toBe("openai/gpt-5.6-luna");
    expect(
      remapModelRefForForcedRuntime({
        modelRef: "mock-openai/gpt-5.6-luna",
        providerMode: "mock-openai",
        forcedRuntime: "openclaw",
      }),
    ).toBe("mock-openai/gpt-5.6-luna");
  });
});
