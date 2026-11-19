import { resolveActiveEmbeddedRunSessionId } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { createDynamicToolCall, textToolResult } from "./dynamic-tools.test-support.js";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";
import {
  bindProductionHarnessHostCapabilitiesForTest,
  createCodexRuntimePlanFixture,
  createRuntimeDynamicTool,
  createStartedThreadHarness,
  createTestParams,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
} from "./run-attempt-test-harness.js";

// Core owns the draining fact; this file only decides what the harness does with it.
const gateway = vi.hoisted(() => ({ draining: false }));
vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>();
  return {
    ...actual,
    isGatewayShutdownAbortReason: (reason: unknown) =>
      gateway.draining &&
      actual.resolveAgentRunAbortLifecycleFields(AbortSignal.abort(reason)).stopReason ===
        "restart",
  };
});

setupRunAttemptTestHooks();
afterEach(() => {
  gateway.draining = false;
  clearRuntimeConfigSnapshot();
});

const restartAbort = () =>
  Object.assign(new Error("agent run aborted for restart"), {
    name: "AbortError",
    code: "OPENCLAW_RESTART_ABORT",
  });
const remoteAppServer = {
  pluginConfig: { appServer: { transport: "websocket" as const, url: "ws://127.0.0.1:47123" } },
};
const cancellationRequests = (harness: ReturnType<typeof createStartedThreadHarness>) =>
  harness.requests.filter(({ method }) =>
    ["turn/interrupt", "thread/backgroundTerminals/list"].includes(method),
  );
const interruptRequest = {
  method: "turn/interrupt",
  params: { threadId: "thread-1", turnId: "turn-1" },
};

describe("runCodexAppServerAttempt activation ownership", () => {
  it("observes accepted requests without spending the execution budget", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const harness = createStartedThreadHarness();
    const turnAccepted = createDeferred<void>();
    const params = createTestParams();
    setRuntimeConfigSnapshot(params.config ?? {});
    params.timeoutMs = 1;
    params.onExecutionPhase = ({ phase }) => {
      if (phase === "turn_accepted") {
        turnAccepted.resolve();
      }
    };
    const run = runCodexAppServerAttempt(params);
    await Promise.race([turnAccepted.promise, run]);

    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });

    expect(readAttemptTerminal(await run)).toMatchObject({
      aborted: false,
      timedOut: false,
      promptError: null,
    });
  });

  it("stops accepted native work when published-backend activation fails", async () => {
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    setRuntimeConfigSnapshot(params.config ?? {});
    params.permissionChange = {
      owner: {},
      baseExecOverrides: {},
      request: async () => false,
      applied: () => {
        throw new Error("activation failed");
      },
      recordApplied: () => {},
    };
    await expect(runCodexAppServerAttempt(params)).rejects.toThrow("activation failed");
    expect(
      harness.requests.filter(({ method }) =>
        ["turn/interrupt", "thread/backgroundTerminals/list", "thread/unsubscribe"].includes(
          method,
        ),
      ),
    ).toEqual([
      { method: "turn/interrupt", params: { threadId: "thread-1", turnId: "turn-1" } },
      { method: "thread/backgroundTerminals/list", params: { threadId: "thread-1" } },
      { method: "thread/unsubscribe", params: { threadId: "thread-1" } },
    ]);
    expect(resolveActiveEmbeddedRunSessionId(params.sessionKey!)).toBeUndefined();
    expect(harness.client.getCloseError()).toBeUndefined();
  });
});

describe("runCodexAppServerAttempt Gateway shutdown", () => {
  async function startTurn(
    options: typeof remoteAppServer | undefined,
    harness = createStartedThreadHarness(),
    params = createTestParams(),
  ) {
    const controller = new AbortController();
    params.abortSignal = controller.signal;
    setRuntimeConfigSnapshot(params.config ?? {});
    const run = runCodexAppServerAttempt(params, options);
    await run.waitForTurnAccepted();
    return { harness, run, controller };
  }

  it("leaves a remote turn running when the Gateway stops", async () => {
    const { harness, run, controller } = await startTurn(remoteAppServer);
    gateway.draining = true;
    controller.abort(restartAbort());

    expect(readAttemptTerminal(await run)).toMatchObject({
      aborted: true,
      externalAbort: true,
      promptError: null,
    });
    expect(cancellationRequests(harness)).toEqual([]);
  });

  it.each([
    ["an app-server the Gateway started", undefined, true, restartAbort],
    ["a remote turn stopped by the user", remoteAppServer, true, () => new Error("Stopped")],
    ["a remote turn reset while the Gateway runs", remoteAppServer, false, restartAbort],
  ])("interrupts %s", async (_name, options, draining, reason) => {
    const { harness, run, controller } = await startTurn(options);
    gateway.draining = draining;
    controller.abort(reason());

    expect(readAttemptTerminal(await run).aborted).toBe(true);
    expect(cancellationRequests(harness)[0]).toEqual(interruptRequest);
  });

  it("interrupts a remote turn that waits on this Gateway", async () => {
    const started = createDeferred<void>();
    const tool = createRuntimeDynamicTool("wait_here");
    tool.execute = vi.fn(async (_id, _args, signal) => {
      started.resolve();
      await new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }));
      return textToolResult("stopped");
    });
    const params = Object.assign(createTestParams(), {
      runtimePlan: createCodexRuntimePlanFixture(),
    });
    setCodexTestToolFactory(params, () => [tool]);
    setCodexTestModelSupportsTools(params, true);
    onTestFinished(await bindProductionHarnessHostCapabilitiesForTest(params));
    const { harness, run, controller } = await startTurn(remoteAppServer, undefined, params);
    const call = harness.handleServerRequest({
      id: "call-1",
      method: "item/tool/call",
      params: createDynamicToolCall("wait_here", {}, "call-1"),
    });
    await started.promise;
    gateway.draining = true;
    controller.abort(restartAbort());

    await call;
    expect(readAttemptTerminal(await run).aborted).toBe(true);
    expect(cancellationRequests(harness)[0]).toEqual(interruptRequest);
  });
});
