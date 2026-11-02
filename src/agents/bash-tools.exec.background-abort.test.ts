import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { withExecRequestTurn } from "../infra/exec-request-context.js";
import type { RunExit } from "../process/supervisor/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { captureExecRequestCancellation } from "./bash-process-control.js";
import { getFinishedSession, getSession, waitForExecScope } from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createRunExit } from "./bash-tools.exec-runtime.test-support.js";
import { createProcessTool } from "./bash-tools.process.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  createCodeModeHarness,
  resetCodeModeTestState,
  resultDetails,
} from "./code-mode.test-support.js";
import { createLazyExecTool } from "./lazy-exec-tool.js";
import { createAgentRunDirectAbortError } from "./run-termination.js";

const supervisorMockState = vi.hoisted(() => ({
  onSpawn: undefined as (() => void) | undefined,
  finish: new Map<string, () => void>(),
  cancelled: [] as string[],
}));

vi.mock("../process/supervisor/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../process/supervisor/index.js")>();
  let counter = 0;
  return {
    ...actual,
    getProcessSupervisor: () => ({
      spawn: async (input: { runId?: string }) => {
        supervisorMockState.onSpawn?.();
        const runId = input.runId ?? `mock-run-${++counter}`;
        const activity = { resultSettled: false, lastOutputAtMs: Date.now() };
        const completion = createDeferredCore<RunExit>();
        const settle = (reason: "manual-cancel" | "exit") => {
          if (activity.resultSettled) {
            return;
          }
          activity.resultSettled = true;
          completion.resolve(
            createRunExit({
              reason,
              exitCode: reason === "exit" ? 0 : null,
            }),
          );
        };
        supervisorMockState.finish.set(runId, () => settle("exit"));
        return {
          activity,
          runId,
          startedAtMs: Date.now(),
          stdin: undefined,
          wait: () => completion.promise,
          cancel: () => {
            supervisorMockState.cancelled.push(runId);
            settle("manual-cancel");
          },
        };
      },
      cancel: vi.fn(),
      cancelScope: vi.fn(),
    }),
  };
});

vi.mock("../infra/shell-env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/shell-env.js")>()),
  getShellPathFromLoginShell: vi.fn(() => null),
  resolveShellEnvFallbackTimeoutMs: vi.fn(() => 0),
}));

vi.mock("./bash-tools.exec-host-gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bash-tools.exec-host-gateway.js")>()),
  processGatewayAllowlist: vi.fn(async () => ({})),
}));

vi.mock("./bash-tools.exec-host-node.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bash-tools.exec-host-node.js")>()),
  executeNodeHostCommand: vi.fn(async () => {
    throw new Error("node host not expected in background abort tests");
  }),
}));

const command = { command: "fixture-command", timeoutSeconds: 60 };
function identity(runId: string, sessionKey: string, sessionId: string) {
  return { runId, sessionKey, sessionId, agentId: "main" };
}
const makeTool = (owner: Partial<ReturnType<typeof identity>>, scopeKey: string) =>
  createLazyExecTool({
    host: "gateway",
    security: "full",
    ask: "off",
    allowBackground: true,
    notifyOnExit: false,
    ...owner,
    scopeKey,
  });

async function finishProcesses() {
  for (const finish of supervisorMockState.finish.values()) {
    finish();
  }
  await vi.advanceTimersByTimeAsync(60_000);
}

function runningSession(details: ReturnType<typeof resultDetails>) {
  if (details.status !== "running" || typeof details.sessionId !== "string") {
    throw new Error("Expected a supervised command");
  }
  return details.sessionId;
}

async function yieldExec(
  tool: ReturnType<typeof createLazyExecTool>,
  runId: string,
  args: Parameters<typeof tool.execute>[1],
  signal: AbortSignal,
  codeMode = false,
  scopeKey?: string,
) {
  const spawned = createDeferredCore();
  supervisorMockState.onSpawn = () => spawned.resolve();
  const harness = codeMode ? createCodeModeHarness() : undefined;
  if (harness) {
    applyCodeModeCatalog({
      ...harness.ctx,
      tools: [...harness.tools, tool, createProcessTool({ scopeKey })],
    });
  }
  const pending = harness
    ? harness.tools[0]!.execute(
        runId,
        { code: `return await exec(${JSON.stringify(args)});` },
        signal,
      )
    : tool.execute(runId, args, signal);
  await Promise.race([
    spawned.promise,
    pending.then((result) => {
      throw new Error(`Exec did not start: ${JSON.stringify(resultDetails(result))}`);
    }),
  ]);
  await vi.advanceTimersByTimeAsync(10);
  const details = resultDetails(await pending);
  if (harness) {
    expect(details.status).toBe("completed");
  }
  return runningSession(harness ? resultDetails({ details: details.value }) : details);
}

beforeEach(() => {
  vi.clearAllMocks();
  supervisorMockState.onSpawn = undefined;
  supervisorMockState.finish.clear();
  supervisorMockState.cancelled.length = 0;
});

afterEach(async () => {
  resetProcessRegistryForTests();
  vi.useRealTimers();
  await resetCodeModeTestState();
});

test.each([false, true])(
  "invocation disposal preserves yielded exec until request Stop (owned=%s)",
  async (owned) => {
    vi.useFakeTimers();
    const returned = createDeferredCore<string>();
    const finishTurn = createDeferredCore();
    const owner = identity("yielded-stop", "agent:main:yielded-stop", "yielded-session");
    const request = new AbortController();
    const invocation = new AbortController();
    const execute = async () => {
      const tool = makeTool(owned ? owner : {}, owner.sessionKey);
      const args = { ...command, yieldMs: 10 };
      returned.resolve(await yieldExec(tool, "ordinary-command", args, invocation.signal));
      await finishTurn.promise;
    };
    const running = owned
      ? withExecRequestTurn({ identity: owner, abortSignal: request.signal }, execute)
      : execute();
    try {
      const sessionId = await returned.promise;
      invocation.abort();
      expect(supervisorMockState.cancelled).toEqual([]);
      if (owned) {
        request.abort(createAgentRunDirectAbortError());
      } else {
        supervisorMockState.finish.get(sessionId)?.();
      }
      finishTurn.resolve();
      await running;
      await waitForExecScope(owner.sessionKey);
      expect(supervisorMockState.cancelled).toEqual(owned ? [sessionId] : []);
      expect(getFinishedSession(sessionId)).toMatchObject({
        exited: true,
        exitReason: owned ? "manual-cancel" : "exit",
      });
    } finally {
      finishTurn.resolve();
      await finishProcesses();
      await running;
      await waitForExecScope(owner.sessionKey);
    }
  },
);

test.each([false, true])(
  "request Stop preserves tool disposal, services and new requests (Code Mode=%s)",
  async (codeMode) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const sessionKey = "agent:main:request-stop";
    const source = new AbortController();
    const toolLifetime = new AbortController();
    async function launch(runId: string, independent = false) {
      const owner = identity(runId, sessionKey, "request-stop-session");
      return withExecRequestTurn({ identity: owner, abortSignal: source.signal }, () =>
        yieldExec(
          makeTool(owner, sessionKey),
          runId,
          { ...command, ...(independent ? { background: true } : { yieldMs: 10 }) },
          toolLifetime.signal,
          codeMode,
          sessionKey,
        ),
      );
    }
    const ordinary = await launch("original");
    const service = await launch("service", true);
    const cancellation = captureExecRequestCancellation(
      identity("original", sessionKey, "request-stop-session"),
    );
    const next = await launch("new-human-request");
    toolLifetime.abort();
    expect(supervisorMockState.cancelled).toEqual([]);
    try {
      expect(cancellation.cancel()).toBe(true);
      await cancellation.settle();
      expect(supervisorMockState.cancelled).toEqual([ordinary]);
      expect(getFinishedSession(ordinary)).toMatchObject({
        exited: true,
        exitReason: "manual-cancel",
      });
      expect(getSession(service)?.exited).toBe(false);
      expect(getSession(next)?.exited).toBe(false);
      supervisorMockState.finish.get(service)?.();
      supervisorMockState.finish.get(next)?.();
      await waitForExecScope(sessionKey);
      expect(getFinishedSession(next)).toMatchObject({ exitCode: 0, exitReason: "exit" });
    } finally {
      await finishProcesses();
      await waitForExecScope(sessionKey);
    }
  },
);
