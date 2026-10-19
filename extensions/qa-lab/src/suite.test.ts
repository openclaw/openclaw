import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QaLabServerHandle } from "./lab-server.types.js";
import { remapModelRefForForcedRuntime } from "./model-selection.js";
import { sanitizeQaProgressValue as sanitizeQaSuiteProgressValue } from "./progress-format.js";
import type { QaTransportAdapter } from "./qa-transport.js";
import { artifactPaths, createTestLab } from "./suite-runtime-parity.test-support.js";
import {
  buildQaGatewayHeapCheckpointRuntimeEnvPatch,
  mergeQaRuntimeEnvPatches,
} from "./suite-support.js";
import { makeQaSuiteTestScenario, recordQaSuiteTestResults } from "./suite-test-helpers.js";
import type { QaSuiteResult } from "./suite-types.js";
import {
  buildQaSuiteRuntimeMetrics,
  buildQaSuiteSummaryJson,
  captureGatewayHeapSnapshotCheckpoint,
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
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

const tempDirs = createTempDirHarness();
const messageToolConfig = () => ({ messages: { groupChat: { visibleReplies: "message_tool" } } });
const rssSamples = [
  { label: "suite-start", at: "2026-04-22T12:00:00.000Z", gatewayProcessRssBytes: 100_000_000 },
  { label: "finish", at: "2026-04-22T12:00:10.000Z", gatewayProcessRssBytes: 140_000_000 },
];
const heapSnapshots = [
  {
    label: "suite-start",
    at: "2026-04-22T12:00:01.000Z",
    path: "artifacts/gateway-heap-snapshots/suite-start.heapsnapshot",
    bytes: 12_345,
  },
];

const expectedMetrics = {
  wallMs: 12_000,
  gatewayProcessCpuMs: 3_000,
  gatewayCpuCoreRatio: 0.25,
  gatewayProcessRssStartBytes: 100_000_000,
  gatewayProcessRssEndBytes: 125_000_000,
  gatewayProcessRssDeltaBytes: 25_000_000,
  gatewayProcessRssPeakBytes: 140_000_000,
  gatewayProcessRssPeakDeltaBytes: 40_000_000,
  gatewayProcessRssSamples: rssSamples,
  gatewayHeapSnapshots: heapSnapshots,
};

function cleanupErrorForTest(params: Parameters<typeof throwQaSuiteCleanupErrors>[0]): Error {
  try {
    throwQaSuiteCleanupErrors(params);
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected cleanup to fail");
}

function readiness(stop: QaLabServerHandle["stop"], ownsLab: boolean, timeoutMs?: number) {
  return waitForQaLabReadyOrStopOwned({
    lab: { listenUrl: "http://127.0.0.1:43123", stop },
    ownsLab,
    timeoutMs,
  });
}

afterEach(async () => {
  fetchWithSsrFGuardMock.mockReset();
  vi.useRealTimers();
  await tempDirs.cleanup();
});

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

  it.each([true, false])("preserves error causes with runFailed=%s", (runFailed) => {
    const runError = runFailed ? new Error("primary failed") : undefined;
    const cleanupError = new Error("cleanup failed");
    const thrown = cleanupErrorForTest({
      cleanupFailures: [{ phase: "transport stop", error: cleanupError }],
      runFailed,
      runError,
    });
    expect(thrown).toMatchObject({
      cause: runError ?? cleanupError,
      errors: runFailed ? [runError, cleanupError] : [cleanupError],
    });
    expect(thrown.message.split("\n")[0]).toBe(
      runFailed
        ? "QA suite and cleanup failed"
        : "QA suite cleanup failed before scenarios completed",
    );
    expect(thrown.message).toContain("failed cleanup phases: transport stop: cleanup failed");
  });

  it("reports completed counts, labeled failures, and only written artifact paths", () => {
    const scenarios = (["pass", "fail", "skip"] as const).map((status) => ({
      name: status,
      status,
      steps: [],
    }));
    const result = {
      outputDir: "/qa-output\nretained",
      ...artifactPaths,
      ...recordQaSuiteTestResults(
        undefined,
        scenarios.map(({ name }) => makeQaSuiteTestScenario(name)),
        scenarios,
      ),
      startedScenarioIds: ["pass", "fail", "skip"],
      watchUrl: "http://127.0.0.1:43123",
    } satisfies QaSuiteResult;

    const thrown = cleanupErrorForTest({
      cleanupFailures: [
        { phase: "agent\nharnesses", error: new Error("dispose failed") },
        { phase: "lab stop", error: new Error("stop failed") },
      ],
      runFailed: false,
      runError: undefined,
      result,
      evidenceWritten: false,
    });

    expect(thrown.message).toBe(
      [
        "QA scenarios completed, but cleanup failed",
        "scenario counts: passed=1 failed=1 skipped=1 total=3",
        "failed cleanup phases: agent harnesses: dispose failed; lab stop: stop failed",
        "retained artifacts: output=/qa-output retained report=/qa-output/qa-suite-report.md summary=/qa-output/qa-suite-summary.json",
      ].join("\n"),
    );
    expect("cause" in thrown).toBe(false);
    expect(thrown.message).not.toContain("evidence=");
  });

  it.each(["never-spawned", "unconfirmed"] as const)(
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

    const run = runQaFlowSuite({ transportId: "qa-nope" as unknown as "qa-channel", startLab });
    await expect(run).rejects.toThrow("unsupported QA transport: qa-nope");

    expect(startLab).not.toHaveBeenCalled();
  });

  it.each([undefined, "telegram"])(
    "selects the live adapter only for channel %s",
    async (channelId) => {
      const adapter = { id: "telegram" } as QaTransportAdapter;
      const create = vi.fn(async () => adapter);
      const selected = await createQaSuiteTransportAdapter({
        adapterFactories: [{ id: "telegram", matches: () => true, create }],
        channelDriver: "live",
        channelId,
        outputDir: "/tmp/qa-output",
        transportPolicy: { requireGroupMention: true },
        state: {} as QaLabServerHandle["state"],
        transportId: "qa-channel",
      });
      expect(selected).toMatchObject(
        channelId
          ? { adapter, driver: "live" }
          : { adapter: { id: "qa-channel" }, driver: "qa-channel" },
      );
      expect(create).toHaveBeenCalledTimes(channelId ? 1 : 0);
      if (channelId) {
        expect(create).toHaveBeenCalledWith(
          expect.objectContaining({
            adapterOptions: expect.objectContaining({
              transportPolicy: { requireGroupMention: true },
            }),
          }),
        );
      }
    },
  );

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

    await expect(readiness(stop, false)).resolves.toBeUndefined();

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

    const rejection = expect(readiness(stop, true, 1_000)).rejects.toThrow(
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

    await expect(readiness(stop, false, 1)).rejects.toThrow(
      "timed out after 1ms waiting for qa-lab ready",
    );
    expect(stop).not.toHaveBeenCalled();
  });

  it("resolves transport-ready timeout from params and env", () => {
    for (const [timeout, value, expected] of [
      [undefined, undefined, 120_000],
      [undefined, "180000", 180_000],
      ...["bad", "0x10", "1e3", "10.5"].map((invalid) => [undefined, invalid, 120_000] as const),
      [90_000, undefined, 90_000],
    ] as const) {
      expect(
        resolveQaSuiteTransportReadyTimeoutMs(timeout, {
          OPENCLAW_QA_TRANSPORT_READY_TIMEOUT_MS: value,
        }),
      ).toBe(expected);
    }
  });

  it("applies OPENCLAW_QA_SUITE_PROGRESS override and falls back on invalid values", () => {
    for (const [CI, override, expected] of [
      ["false", "true", true],
      ["true", "false", false],
      ["false", "on", true],
      ["true", "off", false],
      ["true", "definitely", true],
    ] as const) {
      expect(shouldLogQaSuiteProgress({ CI, OPENCLAW_QA_SUITE_PROGRESS: override })).toBe(expected);
    }
  });

  it("sanitizes scenario ids for progress logs", () => {
    expect(sanitizeQaSuiteProgressValue("scenario-id")).toBe("scenario-id");
    expect(sanitizeQaSuiteProgressValue("scenario\nid\tvalue")).toBe("scenario id value");
    expect(sanitizeQaSuiteProgressValue("\u0000\u0001")).toBe("<empty>");
  });

  it("includes effective channel driver in run start progress logs", () => {
    for (const { expected, ...params } of [
      { concurrency: 8, expected: "run start: scenarios=80 concurrency=8 transport=qa-channel" },
      {
        concurrency: 1,
        channelDriver: "crabline" as const,
        channelId: "telegram",
        expected:
          "run start: scenarios=80 concurrency=1 transport=qa-channel channelDriver=crabline channel=telegram",
      },
    ]) {
      expect(
        formatQaSuiteRunStartProgress({
          selectedScenarioCount: 80,
          transportId: "qa-channel",
          ...params,
        }),
      ).toBe(expected);
    }
  });

  it("records gateway RSS peak and trace samples", () => {
    const metrics = buildQaSuiteRuntimeMetrics({
      startedAt: new Date("2026-04-22T12:00:00.000Z"),
      finishedAt: new Date("2026-04-22T12:00:12.000Z"),
      gatewayProcessCpuStartMs: 1_000,
      gatewayProcessCpuEndMs: 4_000,
      gatewayProcessRssStartBytes: 100_000_000,
      gatewayProcessRssEndBytes: 125_000_000,
      gatewayProcessRssSamples: structuredClone(rssSamples),
      gatewayHeapSnapshots: structuredClone(heapSnapshots),
    });
    expect(metrics).toEqual(expectedMetrics);
  });

  it("arms gateway heap checkpoint env only when requested", () => {
    const option = "--heapsnapshot-signal=SIGQUIT";
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
      NODE_OPTIONS: `--max-old-space-size=4096 ${option}`,
    });
    expect(mergeQaRuntimeEnvPatches({ OPENAI_API_KEY: "mock" }, { NODE_OPTIONS: option })).toEqual({
      OPENAI_API_KEY: "mock",
      NODE_OPTIONS: option,
    });
  });

  it("keeps caller-owned serial labs on shared workers without a launcher", () => {
    const scenarios = [
      makeQaSuiteTestScenario("baseline"),
      makeQaSuiteTestScenario("message-tool-mode", {
        gatewayConfigPatch: messageToolConfig(),
      }),
    ];
    const lab = createTestLab();
    const startLab = vi.fn();

    const params = { scenarios, concurrency: 1, lab };
    expect(shouldRunQaSuiteWithIsolatedScenarioWorkers(params)).toBe(false);
    expect(shouldRunQaSuiteWithIsolatedScenarioWorkers({ ...params, startLab })).toBe(true);
  });

  it("remaps mock-openai refs only for the codex runtime", () => {
    for (const [forcedRuntime, expected] of [
      ["codex", "openai/gpt-5.6-luna"],
      ["openclaw", "mock-openai/gpt-5.6-luna"],
    ] as const) {
      expect(
        remapModelRefForForcedRuntime({
          modelRef: "mock-openai/gpt-5.6-luna",
          providerMode: "mock-openai",
          forcedRuntime,
        }),
      ).toBe(expected);
    }
  });
});

describe("buildQaSuiteSummaryJson", () => {
  const baseParams = {
    scenarios: [
      { name: "Scenario A", status: "pass" as const, steps: [] },
      { name: "Scenario B", status: "fail" as const, details: "something broke", steps: [] },
    ],
    startedAt: new Date("2026-04-11T00:00:00.000Z"),
    finishedAt: new Date("2026-04-11T00:05:00.000Z"),
    providerMode: "mock-openai" as const,
    primaryModel: "openai/gpt-5.6-luna",
    alternateModel: "openai/gpt-5.6-luna-alt",
    fastMode: true,
    concurrency: 2,
  };

  it("rejects the removed channel-driver selection input", () => {
    expect(() =>
      buildQaSuiteSummaryJson(
        Object.assign({}, baseParams, {
          channelDriverSelection: { channel: "discord", driver: "crabline" },
        }),
      ),
    ).toThrow("channelDriverSelection was removed");
  });

  it("records selected scenarios and realized run metadata", () => {
    const run = {
      scenarioIds: ["approval", "handoff", "recall"],
      status: "running",
      channel: "telegram",
      channelDriver: "crabline",
      channelCapabilityMatrixPath: "crabline-channel-driver-capabilities.json",
      channelDriverSmokePath: "crabline-provider-readiness.json",
      runtimePair: ["openclaw", "codex"],
    } satisfies Partial<Parameters<typeof buildQaSuiteSummaryJson>[0]>;
    const json = buildQaSuiteSummaryJson({ ...baseParams, ...structuredClone(run) });
    expect(json.run).toMatchObject(run);
  });

  it("leaves split fields null when a model ref is malformed", () => {
    const json = buildQaSuiteSummaryJson({
      ...baseParams,
      primaryModel: "not-a-real-ref",
      alternateModel: "",
      scenarioIds: [],
    });
    expect(json.run).toMatchObject({
      primaryModel: "not-a-real-ref",
      primaryProvider: null,
      primaryModelName: null,
      alternateModel: "",
      alternateProvider: null,
      alternateModelName: null,
      scenarioIds: null,
    });
  });

  it("includes skipped scenarios in the canonical summary counts", () => {
    const json = buildQaSuiteSummaryJson({
      ...baseParams,
      scenarios: [
        ...baseParams.scenarios,
        { name: "Scenario C", status: "skip" as const, steps: [] },
        { name: "Scenario D", status: "skip" as const, steps: [] },
      ],
    });

    expect(json.counts).toEqual({ total: 4, passed: 1, failed: 1, skipped: 2 });
  });

  it("records optional runtime metrics when provided", () => {
    const metrics = { ...expectedMetrics, gatewayProcessCpuMs: 3_400, gatewayCpuCoreRatio: 0.283 };
    const json = buildQaSuiteSummaryJson({ ...baseParams, metrics: structuredClone(metrics) });
    expect(json.metrics).toEqual(metrics);
  });
});

describe("Gateway heap snapshot checkpoints", () => {
  async function createWriterFixture(outcome?: "failed" | "replaced-before" | "replaced-during") {
    const tempRoot = await tempDirs.makeTempDir("qa-heap-checkpoint-");
    const outputDir = path.join(tempRoot, "output");
    const snapshotPath = path.join(tempRoot, "Heap.snapshot.heapsnapshot");
    let pid = 123;
    const gateway = {
      tempRoot,
      get pid() {
        return pid;
      },
      async signalProcess(signal: NodeJS.Signals) {
        expect(signal).toBe("SIGQUIT");
        await fs.writeFile(snapshotPath, '{"snapshot":');
        if (outcome === "replaced-before") {
          pid += 1;
        }
      },
      async call() {
        if (outcome === "failed") {
          throw new Error("Gateway exited during snapshot serialization");
        }
        if (outcome === "replaced-during") {
          pid += 1;
        }
        // Node's signal handler closes the snapshot before its JS thread can answer an RPC.
        await fs.appendFile(snapshotPath, '{"complete":true}}');
        return { ok: true };
      },
    };
    return { gateway, outputDir, label: "after turn" };
  }

  it("copies the completed snapshot even when an unfinished prefix has stopped growing", async () => {
    const params = await createWriterFixture();
    const checkpoint = await captureGatewayHeapSnapshotCheckpoint(params);
    expect(checkpoint).toBeDefined();
    const artifact = await fs.readFile(path.join(params.outputDir, checkpoint!.path));
    expect(JSON.parse(artifact.toString())).toEqual({ snapshot: { complete: true } });
    expect(checkpoint!.bytes).toBe(artifact.length);
  });

  it.each(["failed", "replaced-before", "replaced-during"] as const)(
    "does not publish a snapshot after the Gateway is %s",
    async (outcome) => {
      const params = await createWriterFixture(outcome);
      await expect(captureGatewayHeapSnapshotCheckpoint(params)).rejects.toThrow(
        outcome === "failed" ? "Gateway exited" : "Gateway changed",
      );
      await expect(fs.access(params.outputDir)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});
