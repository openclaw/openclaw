// Qa Lab tests cover suite runtime flow plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runScenarioFlow = vi.hoisted(() =>
  vi.fn<(params: Parameters<typeof RunScenarioFlow>[0]) => Promise<unknown>>(
    async (params) => params.api,
  ),
);
const waitForOutboundMessage = vi.hoisted(() => vi.fn());

// mock-isolation: observe flow delegation without executing the scenario runner.
vi.mock("./scenario-flow-runner.js", () => ({ runScenarioFlow }));

vi.mock("./suite-runtime-transport.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./suite-runtime-transport.js")>()),
  waitForOutboundMessage,
}));

import { createQaBusState } from "./bus-state.js";
import { QaSuiteScenarioSkipError } from "./errors.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";
import { createQaTransportAdapter } from "./qa-transport-registry.js";
import { createQaTransportStateMethods } from "./qa-transport.js";
import * as runtimeToolFixture from "./runtime-tool-fixture.js";
import type { runScenarioFlow as RunScenarioFlow } from "./scenario-flow-runner.js";
import { runQaSuiteScenarioDefinition, runQaSuiteScenarioSteps } from "./suite-runtime-flow.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";
import type { QaSuiteStep } from "./suite-types.js";

const qaSuiteRuntimeFlowTestConstants = {
  imageUnderstandingPngBase64: "small",
  imageUnderstandingLargePngBase64: "large",
  imageUnderstandingValidPngBase64: "valid",
};

type QaGatewayLogDeps = {
  assertNoGatewayLogSentinels: (options?: { since?: number }) => unknown;
  markGatewayLogCursor: () => number;
  readGatewayLogs: (mark?: number) => string;
  scanGatewayLogSentinels: (options?: { since?: number }) => Array<{
    kind: string;
    line: number;
  }>;
};

function createQaSuiteRuntimeFlowTestEnv(
  transportOverrides: Partial<QaSuiteRuntimeEnv["transport"]> = {},
) {
  return {
    lab: { baseUrl: "http://127.0.0.1:4444" },
    webSessionIds: new Set<string>(),
    gateway: {} as QaSuiteRuntimeEnv["gateway"],
    transport: {
      ...createQaChannelTransport(createQaBusState()),
      label: "QA Channel",
      accountId: "qa-channel",
      ...transportOverrides,
    },
    outputDir: "/artifacts",
    repoRoot: "/repo",
    providerMode: "mock-openai",
    primaryModel: "openai/gpt-5.6-luna",
    alternateModel: "openai/gpt-5.6-luna-mini",
    mock: null,
    cfg: {},
  } satisfies Parameters<typeof runQaSuiteScenarioDefinition>[0]["env"];
}

type FlowApi = { runScenario: typeof runQaSuiteScenarioSteps; signal?: AbortSignal };
function mockStepFlow(name: string, steps: QaSuiteStep[] | ((api: FlowApi) => QaSuiteStep[])) {
  runScenarioFlow.mockImplementationOnce(async ({ api }) => {
    const flowApi = api;
    return flowApi.runScenario(name, typeof steps === "function" ? steps(flowApi) : steps);
  });
}
function runDefinition(
  env: ReturnType<typeof createQaSuiteRuntimeFlowTestEnv>,
  scenario = makeQaSuiteTestScenario("test-flow", { config: {} }),
) {
  return runQaSuiteScenarioDefinition({
    env,
    scenario,
    constants: qaSuiteRuntimeFlowTestConstants,
  });
}
async function runTransportFlow(
  env: ReturnType<typeof createQaSuiteRuntimeFlowTestEnv>,
  actions: Parameters<typeof RunScenarioFlow>[0]["flow"]["steps"][number]["actions"],
) {
  const scenario = makeQaSuiteTestScenario("transport-api", { config: { expected: "value" } });
  if (scenario.execution.kind !== "flow") {
    throw new Error("expected flow scenario");
  }
  scenario.execution.flow = { steps: [{ name: "Transport operations", actions }] };
  const actual = await vi.importActual<typeof import("./scenario-flow-runner.js")>(
    "./scenario-flow-runner.js",
  );
  runScenarioFlow.mockImplementationOnce(actual.runScenarioFlow);
  return await runDefinition(env, scenario);
}
function flowScenario(id: string, timeoutMs?: number) {
  const scenario = makeQaSuiteTestScenario(id, { config: {} });
  if (scenario.execution.kind !== "flow") {
    throw new Error("expected flow scenario");
  }
  scenario.execution.timeoutMs = timeoutMs;
  return scenario;
}
const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
const step = (name: string, run: QaSuiteStep["run"]): QaSuiteStep => ({ name, run });

async function captureQaGatewayLogDeps(
  gateway: Partial<QaSuiteRuntimeEnv["gateway"]>,
): Promise<QaGatewayLogDeps> {
  const env = createQaSuiteRuntimeFlowTestEnv();
  env.gateway = gateway as QaSuiteRuntimeEnv["gateway"];
  const scenario = makeQaSuiteTestScenario("gateway-log-deps", { config: {} });

  await runDefinition(env, scenario);

  const call = runScenarioFlow.mock.calls.at(-1)?.[0] as { api: QaGatewayLogDeps } | undefined;
  if (!call) {
    throw new Error("expected QA scenario runtime API call");
  }
  return call.api;
}

describe("qa suite runtime flow", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    if (vi.isFakeTimers()) {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(runtimeToolFixture, "runRuntimeToolFixture").mockResolvedValue("");
  });

  it("runs transport aliases with their original receivers through a scenario flow", async () => {
    const state = createQaBusState();
    const resetSpy = vi.spyOn(state, "reset");
    const inboundSpy = vi.spyOn(state, "addInboundMessage");
    const outboundSpy = vi.spyOn(state, "addOutboundMessage");
    const readSpy = vi.spyOn(state, "readMessage");
    const methods = createQaTransportStateMethods({ state, accountId: "qa-channel" });
    const env = createQaSuiteRuntimeFlowTestEnv(methods);
    const result = await runTransportFlow(env, [
      {
        assert:
          "lab === env.lab && state === transport.state && config.expected === 'value' && waitForCondition === transport.waitForCondition && waitForChannelReady === waitForTransportReady && waitForQaChannelReady === waitForTransportReady && imageUnderstandingPngBase64 === 'small'",
      },
      {
        call: "injectInboundMessage",
        args: [
          {
            accountId: "qa-channel",
            conversation: { id: "qa-operator", kind: "direct" },
            senderId: "qa-operator",
            text: "hello",
          },
        ],
        saveAs: "inbound",
      },
      {
        call: "injectOutboundMessage",
        args: [{ accountId: "qa-channel", to: "dm:qa-operator", text: "hi" }],
        saveAs: "outbound",
      },
      { assert: "inbound.id.trim() !== '' && outbound.id.trim() !== ''" },
      { call: "getTransportSnapshot", saveAs: "snapshot" },
      { assert: "snapshot.messages.length === 2" },
      {
        call: "readTransportMessage",
        args: [{ accountId: "qa-channel", messageId: { ref: "outbound.id" } }],
        saveAs: "read",
      },
      { assert: "read.id === outbound.id && read.text === 'hi'" },
      { call: "reset" },
      { call: "resetBus" },
      { call: "resetTransport" },
    ]);

    expect(result.status).toBe("pass");
    expect(inboundSpy).toHaveBeenCalledTimes(1);
    expect(outboundSpy).toHaveBeenCalledTimes(1);
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(resetSpy).toHaveBeenCalledTimes(3);
  });

  it("routes scenario injection through a factory-created transport", async () => {
    const state = createQaBusState();
    const providerState = createQaBusState();
    const sendInbound = vi.fn(
      async (input: Parameters<typeof providerState.addInboundMessage>[0]) =>
        providerState.addInboundMessage(input),
    );
    const created = await createQaTransportAdapter(
      {
        channelId: "discord",
        driver: "crabline",
        outputDir: ".artifacts/qa-e2e/transport-api",
        state,
      },
      [
        {
          id: "crabline-test",
          matches: () => true,
          async create() {
            return {
              ...createQaChannelTransport(providerState),
              id: "discord",
              label: "Crabline Discord",
              accountId: "sut",
              sendInbound,
            };
          },
        },
      ],
    );
    try {
      const result = await runTransportFlow(createQaSuiteRuntimeFlowTestEnv(created.adapter), [
        {
          call: "injectInboundMessage",
          args: [
            {
              accountId: "sut",
              conversation: { id: "qa-operator", kind: "direct" },
              senderId: "qa-operator",
              text: "provider ingress",
            },
          ],
        },
      ]);

      expect(result.status).toBe("pass");
      expect(sendInbound).toHaveBeenCalledOnce();
      expect(providerState.getSnapshot().messages).toEqual([
        expect.objectContaining({ text: "provider ingress" }),
      ]);
      expect(state.getSnapshot().messages).toEqual([]);
    } finally {
      await created.cleanupWithoutGateway();
    }
  });

  it("keeps the latest structured RTT measurement when the scenario ends in skip", async () => {
    const firstMeasurement = {
      finalMatchedReplyRttMs: 100,
      requestStartedAt: "2026-09-03T00:00:00.000Z",
      responseObservedAt: "2026-09-03T00:00:00.100Z",
      source: "first-observation",
    };
    const latestMeasurement = {
      finalMatchedReplyRttMs: 200,
      requestStartedAt: "2026-09-03T00:00:01.000Z",
      responseObservedAt: "2026-09-03T00:00:01.200Z",
      source: "latest-observation",
    };
    const result = await runQaSuiteScenarioSteps("RTT retention", [
      step("First measurement", async () => ({
        timing: { wallMs: 10, rttMs: 999 },
        rttMeasurement: firstMeasurement,
      })),
      step("Latest measurement", async () => ({
        timing: { rttMs: 888 },
        rttMeasurement: latestMeasurement,
      })),
      step("Later timing only", async () => ({ timing: { rttMs: 777, p50Ms: 50 } })),
      step("Terminal step", async () => {
        throw new QaSuiteScenarioSkipError("later skip");
      }),
    ]);

    expect(result.status).toBe("skip");
    expect(result.timing).toEqual({ wallMs: 10, rttMs: 200, p50Ms: 50 });
    expect(result.rttMeasurement).toEqual(latestMeasurement);
  });

  it("supplies scenario context, normalization and account-scoped runtime operations", async () => {
    const env = createQaSuiteRuntimeFlowTestEnv();
    const scenario = makeQaSuiteTestScenario("session-memory-ranking", {
      config: { expected: "value" },
    });

    const result = await runDefinition(env, scenario);

    expect(result).toMatchObject({ env, scenario, signal: expect.any(AbortSignal) });
    expect(runScenarioFlow).toHaveBeenCalledTimes(1);
    const api = runScenarioFlow.mock.calls[0]?.[0]?.api as {
      env: typeof env;
      scenario: typeof scenario;
      normalizeModelRef: (raw: string) => { provider: string; model: string } | null;
      waitForOutboundMessage: typeof waitForOutboundMessage;
      markGatewayLogCursor: () => number;
      assertNoGatewayLogSentinels: () => void;
      runRuntimeToolFixture: (
        envArg: typeof env,
        configArg: Record<string, unknown>,
      ) => Promise<unknown>;
    } & Parameters<typeof RunScenarioFlow>[0]["api"] &
      typeof qaSuiteRuntimeFlowTestConstants;
    expect(api.env).toBe(env);
    expect(api.scenario).toBe(scenario);
    expect(api.runScenario).toBeTypeOf("function");
    const canonicalOpus = { provider: "anthropic", model: "claude-opus-5-5" };
    const { normalizeModelRef } = api;
    expect(normalizeModelRef("anthropic/opus")).toEqual(canonicalOpus);
    expect(normalizeModelRef("AnThRoPiC/OPUS")).toEqual(canonicalOpus);
    expect(normalizeModelRef("anthropic/claude-opus-5")).toEqual({
      provider: "anthropic",
      model: "claude-opus-5",
    });
    expect(normalizeModelRef("OPENAI/gpt-5.6-luna")).toEqual({
      provider: "openai",
      model: "gpt-5.6-luna",
    });
    expect(normalizeModelRef("")).toBeNull();
    expect(api.waitForOutboundMessage).toBeTypeOf("function");
    const outboundPredicate = vi.fn();
    api.waitForOutboundMessage(env.transport.state, outboundPredicate, 123);
    expect(waitForOutboundMessage).toHaveBeenCalledWith(
      env.transport.state,
      outboundPredicate,
      123,
      { accountId: "qa-channel" },
    );
    expect(api.markGatewayLogCursor()).toBe(-1);
    expect(() => api.assertNoGatewayLogSentinels()).not.toThrow();
    await api.runRuntimeToolFixture(env, { toolName: "read" });
    expect(runtimeToolFixture.runRuntimeToolFixture).toHaveBeenCalledWith(env, {
      toolName: "read",
    });
    expect(api).toMatchObject({
      imageUnderstandingPngBase64: "small",
      imageUnderstandingLargePngBase64: "large",
      imageUnderstandingValidPngBase64: "valid",
    });
  });

  it("reads fresh gateway logs and sentinels from one absolute collector mark", async () => {
    const freshLogs = "codex_app_server progress stalled after restart\n";
    let legacyLogs = "[qa-lab] older gateway logs truncated\nlegacy tail";
    const markLogs = vi.fn(() => 70_000);
    const readLogsSince = vi.fn((mark: number) => (mark === 70_000 ? freshLogs : ""));
    const deps = await captureQaGatewayLogDeps({
      logs: () => legacyLogs,
      markLogs,
      readLogsSince,
    });

    expect(deps.markGatewayLogCursor()).toBe(70_000);
    expect(deps.readGatewayLogs(70_000)).toBe(freshLogs);
    expect(deps.readGatewayLogs(-1)).toBe(legacyLogs);
    expect(deps.scanGatewayLogSentinels({ since: 70_000 })).toEqual([
      expect.objectContaining({
        kind: "stalled-agent-run",
        line: 1,
      }),
    ]);
    expect(() => deps.assertNoGatewayLogSentinels({ since: 70_000 })).toThrow(
      "codex_app_server progress stalled after restart",
    );
    expect(readLogsSince).toHaveBeenCalledTimes(3);
    expect(readLogsSince).toHaveBeenCalledWith(70_000);

    markLogs.mockReturnValueOnce(-1);
    legacyLogs = "x".repeat(70_000);
    const legacyCursor = deps.markGatewayLogCursor();
    legacyLogs = `${"y".repeat(70_000)}\ncodex_app_server progress stalled\n`;
    expect(legacyCursor).toBe(-1);
    expect(deps.readGatewayLogs(legacyCursor)).toBe(legacyLogs);
    expect(deps.scanGatewayLogSentinels({ since: legacyCursor })).toEqual([
      expect.objectContaining({ kind: "stalled-agent-run" }),
    ]);
    expect(readLogsSince).toHaveBeenCalledTimes(3);
  });

  it("attaches scenario-window gateway sentinels only to a failed step", async () => {
    const finalReplyFailure =
      "[telegram] final reply failed: SqliteWorkerError: Session actor version changed before command admission";
    const readLogsSince = vi.fn((mark: number) =>
      mark === 4_096 ? `gateway ready\n${finalReplyFailure}\n` : "stale scenario logs",
    );
    const env = createQaSuiteRuntimeFlowTestEnv();
    env.gateway = {
      markLogs: () => 4_096,
      readLogsSince,
    } as unknown as QaSuiteRuntimeEnv["gateway"];
    mockStepFlow("Terminal reply", [
      { name: "visible", run: async () => undefined },
      step("silent", async () => {
        throw new Error("[public:silent] timed out after 60000ms");
      }),
    ]);

    const result = await runDefinition(
      env,
      makeQaSuiteTestScenario("gateway-sentinel-evidence", { config: {} }),
    );

    // Scenario-level details feed keyword classifiers and stay unchanged.
    expect(result.details).toBe("[public:silent] timed out after 60000ms");
    expect(result.steps.map((resultStep) => resultStep.details)).toEqual([
      undefined,
      [
        "[public:silent] timed out after 60000ms",
        "Gateway log sentinel(s) during scenario:",
        `final-reply-delivery-failure@2 product-bug owner=openclaw-routing: ${finalReplyFailure}`,
      ].join("\n"),
    ]);
  });

  it.each([
    ["leaves the preparation fallback out of the action deadline", 0, 66_000, undefined, 66_000],
    ["preserves the complete observation window after preparation", 6_000, 8_000, 8_000, 14_000],
    ["aborts stuck preparation before admitting actions", Infinity, 0, 8_000, 65_000],
    ["aborts stuck actions with a separate post-preparation deadline", 10, Infinity, 30, 5_040],
  ] as const)("%s", async (name, preparationMs, actionMs, timeoutMs, settledAt) => {
    vi.useFakeTimers();
    let preparationSignal: AbortSignal | undefined;
    let actionSignal: AbortSignal | undefined;
    const hold = (ms: number) => (ms === Infinity ? new Promise<void>(() => {}) : delay(ms));
    const prepareFlow = vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
      preparationSignal = signal;
      await hold(preparationMs);
    });
    const observed = vi.fn();
    const action = vi.fn(async () => {
      await hold(actionMs);
      observed();
    });
    mockStepFlow(name, (api) => [
      step("Action", async () => {
        actionSignal = api.signal;
        await action();
      }),
    ]);
    const pending = runDefinition(
      createQaSuiteRuntimeFlowTestEnv({ prepareFlow }),
      flowScenario(name, timeoutMs),
    );
    await vi.advanceTimersByTimeAsync(settledAt - 1);
    expect(observed).not.toHaveBeenCalled();
    expect(preparationSignal?.aborted).toBe(false);
    if (actionMs === Infinity) {
      expect(actionSignal?.aborted).toBe(false);
    }
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    const stuck = preparationMs === Infinity || actionMs === Infinity;
    expect(result.status).toBe(stuck ? "fail" : "pass");
    expect(vi.getTimerCount()).toBe(0);
    if (preparationMs === Infinity) {
      expect(result.steps).toMatchObject([{ name: "Prepare QA Channel", status: "fail" }]);
      expect(preparationSignal?.aborted).toBe(true);
      expect(action).not.toHaveBeenCalled();
    } else if (actionMs === Infinity) {
      expect(result.details).toContain("30ms");
      expect(preparationSignal).not.toBe(actionSignal);
      expect(preparationSignal?.aborted).toBe(true);
      expect(actionSignal?.aborted).toBe(true);
    } else {
      expect(observed).toHaveBeenCalledOnce();
    }
    if (timeoutMs === undefined) {
      expect(prepareFlow).toHaveBeenCalledWith(
        expect.objectContaining({ signal: expect.any(AbortSignal), timeoutMs: 60_000 }),
      );
    }
  });

  it.each(["preparation", "action"])(
    "stops %s on transport loss and rejects later actions",
    async (phase) => {
      const failure = Promise.withResolvers<Error>();
      const entered = Promise.withResolvers<void>();
      let nativeSignal: AbortSignal | undefined;
      const laterAction = vi.fn();
      const prepareFlow = async (input: { signal?: AbortSignal }) => {
        nativeSignal = input.signal;
        if (phase === "preparation") {
          entered.resolve();
          await new Promise<void>(() => {});
        }
      };
      const env = createQaSuiteRuntimeFlowTestEnv({
        prepareFlow,
        whenUnhealthy: failure.promise,
      });
      mockStepFlow("Transport loss", [
        step("Pending native action", async () => {
          entered.resolve();
          await new Promise<void>(() => {});
        }),
        { name: "Must not send", run: laterAction },
      ]);
      const pending = runDefinition(env, makeQaSuiteTestScenario("transport-loss", { config: {} }));
      await entered.promise;
      failure.resolve(new Error("owned lease lost"));
      expect(await pending).toMatchObject({
        status: "fail",
        details: expect.stringContaining("owned lease lost"),
      });
      expect(nativeSignal?.aborted).toBe(true);
      expect(laterAction).not.toHaveBeenCalled();
    },
  );

  it("caps and disposes the lifecycle watchdog without advancing the maximum timer", async () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const env = createQaSuiteRuntimeFlowTestEnv();
      const scenario = flowScenario("flow-capped-deadline", MAX_TIMER_TIMEOUT_MS);
      mockStepFlow("Capped deadline", [
        { name: "Settles immediately", run: async () => undefined },
      ]);

      const result = await runDefinition(env, scenario);

      expect(result.status).toBe("pass");
      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      timeoutSpy.mockRestore();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
