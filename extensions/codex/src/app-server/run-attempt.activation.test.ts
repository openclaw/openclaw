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
import { keepsCodexTurnAtGatewayStop } from "./run-attempt-turn-state.js";

setupRunAttemptTestHooks();
afterEach(() => clearRuntimeConfigSnapshot());

// Core marks the shutdown abort of a session whose restart marker is written.
const restartAbort = (resumesAfterRestart = false) =>
  Object.assign(new Error("agent run aborted for restart"), {
    name: "AbortError",
    code: "OPENCLAW_RESTART_ABORT",
    ...(resumesAfterRestart ? { resumesAfterRestart } : {}),
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

  it("leaves a resumable remote turn running when the Gateway stops", async () => {
    const { harness, run, controller } = await startTurn(remoteAppServer);
    const sent = harness.requests.length;
    controller.abort(restartAbort(true));

    const terminal = readAttemptTerminal(await run);
    // Codex treats this unsubscribe like the disconnect after a crash: the turn keeps running.
    expect(harness.requests.slice(sent)).toEqual([
      { method: "thread/unsubscribe", params: { threadId: "thread-1" } },
    ]);
    expect(terminal).toMatchObject({ aborted: true, promptError: null });
  });

  it.each([
    ["an app-server the Gateway started", undefined, () => restartAbort(true)],
    ["a remote turn stopped by the user", remoteAppServer, () => new Error("Stopped")],
    // A session reset, or a shutdown of a session the next Gateway will not resume.
    ["a remote turn with a plain restart abort", remoteAppServer, () => restartAbort()],
  ])("interrupts %s", async (_name, options, reason) => {
    const { harness, run, controller } = await startTurn(options);
    controller.abort(reason());

    expect(readAttemptTerminal(await run).aborted).toBe(true);
    expect(cancellationRequests(harness)[0]).toEqual(interruptRequest);
  });

  const remoteTurn = {
    abortReason: restartAbort(true),
    transport: "websocket",
    openTurnRequests: 0,
  };
  // Sandboxed and worker placements need fixtures this block does not build, so the
  // predicate carries those rows.
  it.each([
    ["keeps a resumable remote turn", {}, true],
    ["interrupts a plain restart abort", { abortReason: restartAbort() }, false],
    ["interrupts an app-server the Gateway started", { transport: "stdio" }, false],
    ["interrupts a worker-hosted app-server", { workerHostedCloud: true }, false],
    [
      "interrupts a turn whose commands the Gateway admits",
      { requiresProcessAdmission: true },
      false,
    ],
    ["interrupts a turn that waits on this Gateway", { openTurnRequests: 1 }, false],
  ])("%s at a Gateway stop", (_name, change, kept) => {
    expect(keepsCodexTurnAtGatewayStop({ ...remoteTurn, ...change })).toBe(kept);
  });

  it("interrupts a remote turn that waits on this Gateway", async () => {
    const started = createDeferred<void>();
    const tool = createRuntimeDynamicTool("wait_here");
    tool.execute = vi.fn(async (_id, _args, signal) => {
      started.resolve();
      await new Promise((resolve) => {
        signal?.addEventListener("abort", resolve, { once: true });
      });
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
    controller.abort(restartAbort(true));

    await call;
    expect(readAttemptTerminal(await run).aborted).toBe(true);
    expect(cancellationRequests(harness)[0]).toEqual(interruptRequest);
  });
});
