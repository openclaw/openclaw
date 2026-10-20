// Qa Lab tests cover suite runtime flow plugin behavior.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createQaScenarioRuntimeApi = vi.hoisted(() => vi.fn());
const runScenarioFlow = vi.hoisted(() => vi.fn(async (params: { api: unknown }) => params.api));
const waitForOutboundMessage = vi.hoisted(() => vi.fn());
const runRuntimeToolFixture = vi.hoisted(() => vi.fn());
const { webOpenPage, createWebPageOpener } = vi.hoisted(() => {
  const openPageMock = vi.fn(async (_params: { url: string; repoRoot?: string }) => ({
    pageId: "page-1",
  }));
  const createOpenerMock = vi.fn(
    (owner: Set<string>) => (params: { url: string; repoRoot?: string }) => {
      owner.add("page-1");
      return openPageMock(params);
    },
  );
  return { webOpenPage: openPageMock, createWebPageOpener: createOpenerMock };
});

// mock-isolation: provide the synthetic scenario API without loading live runtime owners.
vi.mock("./scenario-runtime-api.js", () => ({ createQaScenarioRuntimeApi }));

// mock-isolation: observe flow delegation without executing the scenario runner.
vi.mock("./scenario-flow-runner.js", () => ({ runScenarioFlow }));

vi.mock("./suite-runtime-transport.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./suite-runtime-transport.js")>()),
  waitForOutboundMessage,
}));

vi.mock("./web-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./web-runtime.js")>()),
  createQaWebPageOpener: createWebPageOpener,
}));

vi.mock("./runtime-tool-fixture.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime-tool-fixture.js")>()),
  runRuntimeToolFixture,
}));

import { extractToolPayload as extractQaToolPayload } from "openclaw/plugin-sdk/tool-payload";
import * as browserRuntime from "./browser-runtime.js";
import { createQaBusState } from "./bus-state.js";
import * as cronRunWait from "./cron-run-wait.js";
import * as discoveryEval from "./discovery-eval.js";
import { QaSuiteScenarioSkipError } from "./errors.js";
import { inspectQaExecutionIdentityStorage } from "./execution-identity-storage-inspection.js";
import * as modelSwitchEval from "./model-switch-eval.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";
import { runQaCli } from "./qa-cli-process.js";
import * as suiteRuntimeAgentMedia from "./suite-runtime-agent-media.js";
import * as suiteRuntimeAgentProcess from "./suite-runtime-agent-process.js";
import * as suiteRuntimeAgentSession from "./suite-runtime-agent-session.js";
import * as suiteRuntimeAgentTools from "./suite-runtime-agent-tools.js";
import { runQaSuiteScenarioDefinition, runQaSuiteScenarioSteps } from "./suite-runtime-flow.js";
import * as suiteRuntimeGateway from "./suite-runtime-gateway.js";
import * as suiteRuntimeTransport from "./suite-runtime-transport.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";
import type { QaSuiteStep } from "./suite-types.js";
import * as webRuntime from "./web-runtime.js";

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
  createQaScenarioRuntimeApi.mockImplementationOnce((params: { deps: FlowApi }) => ({
    runScenario: params.deps.runScenario,
  }));
  runScenarioFlow.mockImplementationOnce(async ({ api }) => {
    const flowApi = api as FlowApi;
    return flowApi.runScenario(name, typeof steps === "function" ? steps(flowApi) : steps);
  });
}
function runDefinition(
  env: ReturnType<typeof createQaSuiteRuntimeFlowTestEnv>,
  scenario = makeQaSuiteTestScenario("test-flow", { config: {} }),
  runScenario = runQaSuiteScenarioSteps,
) {
  return runQaSuiteScenarioDefinition({
    env,
    scenario,
    runScenario,
    constants: qaSuiteRuntimeFlowTestConstants,
  });
}
function flowScenario(id: string, timeoutMs: number) {
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
  createQaScenarioRuntimeApi.mockReturnValueOnce({ api: "ok" });

  await runDefinition(env, scenario, vi.fn());

  const call = createQaScenarioRuntimeApi.mock.calls.at(-1)?.[0] as
    | { deps: QaGatewayLogDeps }
    | undefined;
  if (!call) {
    throw new Error("expected QA scenario runtime API call");
  }
  return call.deps;
}

describe("qa suite runtime flow", () => {
  afterEach(() => {
    if (vi.isFakeTimers()) {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("wires the split suite runtime deps into the scenario runtime api", async () => {
    const env = createQaSuiteRuntimeFlowTestEnv();
    const scenario = makeQaSuiteTestScenario("session-memory-ranking", {
      config: { expected: "value" },
    });
    const runScenario = vi.fn();
    createQaScenarioRuntimeApi.mockReturnValue({ api: "ok" });

    const result = await runDefinition(env, scenario, runScenario);

    expect(result).toMatchObject({ api: "ok", signal: expect.any(AbortSignal) });
    expect(createQaScenarioRuntimeApi).toHaveBeenCalledTimes(1);
    const call = createQaScenarioRuntimeApi.mock.calls[0]?.[0] as {
      env: typeof env;
      scenario: typeof scenario;
      deps: {
        runScenario: (...args: never[]) => unknown;
        normalizeModelRef: unknown;
        waitForOutboundMessage: typeof waitForOutboundMessage;
        markGatewayLogCursor: () => number;
        assertNoGatewayLogSentinels: () => void;
        runRuntimeToolFixture: (
          envArg: typeof env,
          configArg: Record<string, unknown>,
        ) => Promise<unknown>;
        webOpenPage: (params: { url: string }) => Promise<unknown>;
      };
      constants: typeof qaSuiteRuntimeFlowTestConstants;
    };
    expect(call.env).toBe(env);
    expect(call.scenario).toBe(scenario);
    expect(call.deps.runScenario).toBeTypeOf("function");
    const identityDeps = {
      ...suiteRuntimeTransport,
      ...suiteRuntimeAgentMedia,
      ...suiteRuntimeAgentProcess,
      ...suiteRuntimeAgentSession,
      ...suiteRuntimeAgentTools,
      runQaCli,
      inspectQaExecutionIdentityStorage,
      ...suiteRuntimeGateway,
      ...cronRunWait,
      ...discoveryEval,
      extractQaToolPayload,
      ...modelSwitchEval,

      browserRequest: browserRuntime.callQaBrowserRequest,
      waitForBrowserReady: browserRuntime.waitForQaBrowserReady,
      browserOpenTab: browserRuntime.qaBrowserOpenTab,
      browserSnapshot: browserRuntime.qaBrowserSnapshot,
      browserAct: browserRuntime.qaBrowserAct,
      webWait: webRuntime.qaWebWait,
      webType: webRuntime.qaWebType,
      webSnapshot: webRuntime.qaWebSnapshot,
      webEvaluate: webRuntime.qaWebEvaluate,
    };
    for (const [name, helper] of Object.entries(identityDeps)) {
      if (name !== "waitForOutboundMessage") {
        expect((call.deps as Record<string, unknown>)[name]).toBe(helper);
      }
    }
    const canonicalOpus = { provider: "anthropic", model: "claude-opus-5-5" };
    const normalizeModelRef = call.deps.normalizeModelRef as (
      raw: string,
    ) => { provider: string; model: string } | null;
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
    expect(call.deps.waitForOutboundMessage).toBeTypeOf("function");
    const outboundPredicate = vi.fn();
    call.deps.waitForOutboundMessage(env.transport.state, outboundPredicate, 123);
    expect(waitForOutboundMessage).toHaveBeenCalledWith(
      env.transport.state,
      outboundPredicate,
      123,
      { accountId: "qa-channel" },
    );
    expect(call.deps.markGatewayLogCursor()).toBe(-1);
    expect(() => call.deps.assertNoGatewayLogSentinels()).not.toThrow();
    await call.deps.runRuntimeToolFixture(env, { toolName: "read" });
    expect(runRuntimeToolFixture).toHaveBeenCalledWith(
      env,
      { toolName: "read" },
      {
        createSession: suiteRuntimeAgentSession.createSession,
        readEffectiveTools: suiteRuntimeAgentSession.readEffectiveTools,
        runAgentPrompt: suiteRuntimeAgentProcess.runAgentPrompt,
        fetchJson: suiteRuntimeGateway.fetchJson,
        ensureImageGenerationConfigured: suiteRuntimeAgentMedia.ensureImageGenerationConfigured,
      },
    );
    expect(call.constants).toEqual({
      imageUnderstandingPngBase64: "small",
      imageUnderstandingLargePngBase64: "large",
      imageUnderstandingValidPngBase64: "valid",
    });

    const released = createDeferred<{ pageId: string }>();
    webOpenPage.mockReturnValueOnce(released.promise);
    const opening = call.deps.webOpenPage({ url: "https://openclaw.ai" });
    expect(createWebPageOpener).toHaveBeenNthCalledWith(
      1,
      env.webSessionIds,
      expect.any(AbortSignal),
    );
    expect(createWebPageOpener).toHaveBeenNthCalledWith(2, env.webSessionIds, undefined);
    expect(webOpenPage).toHaveBeenCalledWith({ url: "https://openclaw.ai", repoRoot: "/repo" });
    expect(env.webSessionIds.has("page-1")).toBe(true);
    released.resolve({ pageId: "page-1" });
    await opening;
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

  it("does not turn the preparation fallback into a whole-flow deadline", async () => {
    vi.useFakeTimers();
    const prepareFlow = vi.fn(async () => undefined);
    const env = createQaSuiteRuntimeFlowTestEnv({ prepareFlow });
    const scenario = makeQaSuiteTestScenario("flow-without-explicit-deadline", { config: {} });
    mockStepFlow("No explicit deadline", [
      step("Longer than preparation fallback", async () => {
        await delay(66_000);
      }),
    ]);

    const pending = runDefinition(env, scenario);

    await vi.advanceTimersByTimeAsync(66_000);
    const result = await pending;
    expect(vi.getTimerCount()).toBe(0);
    expect(result.status).toBe("pass");
    expect(prepareFlow).toHaveBeenCalledWith(
      expect.objectContaining({ signal: expect.any(AbortSignal), timeoutMs: 60_000 }),
    );
  });

  it("preserves the observation window after 6000ms of preparation", async () => {
    const preparationMs = 6_000;
    vi.useFakeTimers();
    const prepareFlow = vi.fn(async () => {
      await delay(preparationMs);
    });
    const env = createQaSuiteRuntimeFlowTestEnv({ prepareFlow });
    const scenario = flowScenario("negative-observation", 8_000);
    const observed = vi.fn();
    mockStepFlow("Negative observation", [
      step("Observe the complete no-reply window", async () => {
        await delay(8_000);
        observed();
      }),
    ]);
    const pending = runDefinition(env, scenario);
    await vi.advanceTimersByTimeAsync(preparationMs + 7_999);
    expect(observed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).status).toBe("pass");
    expect(observed).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts stuck preparation with scenario timeout 8000", async () => {
    const timeoutMs = 8_000;
    vi.useFakeTimers();
    let preparationSignal: AbortSignal | undefined;
    const prepareFlow = vi.fn(async (input: { signal?: AbortSignal }) => {
      preparationSignal = input.signal;
      await new Promise<void>(() => {});
    });
    const env = createQaSuiteRuntimeFlowTestEnv({ prepareFlow });
    const scenario = flowScenario("stuck-preparation", timeoutMs);
    const action = vi.fn();
    mockStepFlow("Stuck preparation", [{ name: "Action", run: action }]);
    const pending = runDefinition(env, scenario);
    await vi.advanceTimersByTimeAsync(64_999);
    expect(preparationSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({
      status: "fail",
      steps: [{ name: "Prepare QA Channel", status: "fail" }],
    });
    expect(preparationSignal?.aborted).toBe(true);
    expect(action).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds actions after preparation with an aborting scenario deadline", async () => {
    vi.useFakeTimers();
    let preparationSignal: AbortSignal | undefined;
    let actionSignal: AbortSignal | undefined;
    const prepareFlow = vi.fn(async (input: { signal?: AbortSignal }) => {
      preparationSignal = input.signal;
      await delay(10);
    });
    const env = createQaSuiteRuntimeFlowTestEnv({ prepareFlow });
    const scenario = flowScenario("flow-deadline", 30);
    mockStepFlow("Flow deadline", (api) => [
      step(
        "Never settles without abort",
        async () =>
          await new Promise<void>(() => {
            actionSignal = api.signal;
            api.signal?.addEventListener("abort", () => {}, { once: true });
          }),
      ),
    ]);

    const pending = runDefinition(env, scenario);
    await vi.advanceTimersByTimeAsync(5_039);
    expect(actionSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(result).toMatchObject({ status: "fail", details: expect.stringContaining("30ms") });
    expect(preparationSignal).not.toBe(actionSignal);
    expect(preparationSignal?.aborted).toBe(true);
    expect(actionSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
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
