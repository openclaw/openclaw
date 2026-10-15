import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { withExecRequestTurn } from "../infra/exec-request-context.js";
import type { RunExit } from "../process/supervisor/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { captureExecRequestCancellation } from "./bash-process-control.js";
import { waitForExecScope } from "./bash-process-registry.js";
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
      spawn: async (input: { runId?: string; timeoutMs?: number }) => {
        supervisorMockState.onSpawn?.();
        const runId = input.runId ?? `mock-run-${++counter}`;
        let settled = false;
        const completion = createDeferredCore<RunExit>();
        const settle = (
          reason: "manual-cancel" | "overall-timeout" | "exit",
          timedOut: boolean,
        ) => {
          if (settled) {
            return;
          }
          settled = true;
          completion.resolve({
            reason,
            exitCode: reason === "exit" ? 0 : null,
            exitSignal: null,
            durationMs: input.timeoutMs ?? 0,
            stdout: "",
            stderr: "",
            timedOut,
            noOutputTimedOut: false,
          });
        };
        supervisorMockState.finish.set(runId, () => settle("exit", false));
        if (input.timeoutMs !== undefined) {
          setTimeout(() => settle("overall-timeout", true), Math.max(50, input.timeoutMs));
        }
        return {
          activity: {
            get resultSettled() {
              return settled;
            },
            lastOutputAtMs: Date.now(),
          },
          runId,
          startedAtMs: Date.now(),
          stdin: undefined,
          wait: () => completion.promise,
          cancel: () => {
            supervisorMockState.cancelled.push(runId);
            settle("manual-cancel", false);
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

const BACKGROUND_HOLD_CMD =
  process.platform === "win32" ? 'node -e "setTimeout(() => {}, 1000)"' : "exec sleep 1";
const TEST_EXEC_DEFAULTS = {
  host: "gateway" as const,
  security: "full" as const,
  ask: "off" as const,
};

let getFinishedSession: typeof import("./bash-process-registry.js").getFinishedSession;
let getSession: typeof import("./bash-process-registry.js").getSession;
let resetProcessRegistryForTests: typeof import("./bash-process-registry.test-support.js").resetProcessRegistryForTests;

beforeAll(async () => {
  ({ getFinishedSession, getSession } = await import("./bash-process-registry.js"));
  ({ resetProcessRegistryForTests } = await import("./bash-process-registry.test-support.js"));
});

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
    const spawned = createDeferredCore();
    const returned = createDeferredCore<string>();
    const finishTurn = createDeferredCore();
    supervisorMockState.onSpawn = () => spawned.resolve();
    const identity = {
      runId: "yielded-stop",
      sessionKey: "agent:main:yielded-stop",
      sessionId: "yielded-session",
      agentId: "main",
    };
    const request = new AbortController();
    const invocation = new AbortController();
    const execute = async () => {
      const tool = createLazyExecTool({
        ...TEST_EXEC_DEFAULTS,
        ...(owned ? identity : {}),
        allowBackground: true,
        scopeKey: identity.sessionKey,
        notifyOnExit: false,
      });
      const result = resultDetails(
        await tool.execute(
          "ordinary-command",
          {
            command: BACKGROUND_HOLD_CMD,
            yieldMs: 10,
            timeoutSeconds: 60,
          },
          invocation.signal,
        ),
      );
      if (result.status !== "running" || typeof result.sessionId !== "string") {
        throw new Error("Expected a yielded process");
      }
      returned.resolve(result.sessionId);
      await finishTurn.promise;
    };
    const running = owned
      ? withExecRequestTurn({ identity, abortSignal: request.signal }, execute)
      : execute();
    try {
      await spawned.promise;
      await vi.advanceTimersByTimeAsync(10);
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
      await waitForExecScope(identity.sessionKey);
      expect(supervisorMockState.cancelled).toEqual(owned ? [sessionId] : []);
      expect(getFinishedSession(sessionId)).toMatchObject({
        exited: true,
        exitReason: owned ? "manual-cancel" : "exit",
      });
    } finally {
      finishTurn.resolve();
      for (const finish of supervisorMockState.finish.values()) {
        finish();
      }
      await vi.advanceTimersByTimeAsync(60_000);
      await running;
      await waitForExecScope(identity.sessionKey);
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
      return withExecRequestTurn(
        {
          identity: { runId, sessionKey, sessionId: "request-stop-session", agentId: "main" },
          abortSignal: source.signal,
        },
        async () => {
          const spawned = createDeferredCore();
          supervisorMockState.onSpawn = () => spawned.resolve();
          const tool = createLazyExecTool({
            ...TEST_EXEC_DEFAULTS,
            runId,
            sessionKey,
            sessionId: "request-stop-session",
            agentId: "main",
            scopeKey: sessionKey,
            allowBackground: true,
            notifyOnExit: false,
          });
          const args = {
            command: BACKGROUND_HOLD_CMD,
            ...(independent ? { background: true } : { yieldMs: 10 }),
            timeoutSeconds: 60,
          };
          const harness = codeMode ? createCodeModeHarness() : undefined;
          if (harness) {
            applyCodeModeCatalog({
              ...harness.ctx,
              tools: [...harness.tools, tool, createProcessTool({ scopeKey: sessionKey })],
            });
          }
          const pending = harness
            ? harness.tools[0]!.execute(
                runId,
                {
                  code: `return await exec(${JSON.stringify(args)});`,
                },
                toolLifetime.signal,
              )
            : tool.execute(runId, args, toolLifetime.signal);
          await Promise.race([
            spawned.promise,
            pending.then((result) => {
              throw new Error(`Exec did not start: ${JSON.stringify(resultDetails(result))}`);
            }),
          ]);
          await vi.advanceTimersByTimeAsync(10);
          const result = await pending;
          const details = resultDetails(result);
          if (harness) {
            expect(details.status).toBe("completed");
          }
          const processDetails = harness ? resultDetails({ details: details.value }) : details;
          if (processDetails.status !== "running" || typeof processDetails.sessionId !== "string") {
            throw new Error("Expected a supervised command");
          }
          return processDetails.sessionId;
        },
      );
    }
    const ordinary = await launch("original");
    const service = await launch("service", true);
    const cancellation = captureExecRequestCancellation({
      runId: "original",
      sessionKey,
      sessionId: "request-stop-session",
      agentId: "main",
    });
    const next = await launch("new-human-request");
    // All foreground calls and the original turn have finished successfully.
    // Disposing their tool generation is not an explicit request cancellation.
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
      for (const finish of supervisorMockState.finish.values()) {
        finish();
      }
      await vi.advanceTimersByTimeAsync(60_000);
      await waitForExecScope(sessionKey);
    }
  },
);
