import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { RunExit } from "../process/supervisor/types.js";
import { createDeferredCore } from "../shared/deferred.js";

const supervisorMockState = vi.hoisted(() => ({
  cancelReasons: [] as Array<"manual-cancel" | "overall-timeout">,
  spawnInputs: [] as Array<{ timeoutMs?: number }>,
}));

vi.mock("../process/supervisor/index.js", () => {
  let counter = 0;
  return {
    getProcessSupervisor: () => ({
      spawn: async (input: { timeoutMs?: number }) => {
        supervisorMockState.spawnInputs.push(input);
        const runId = `mock-run-${++counter}`;
        let settled = false;
        const completion = createDeferredCore<RunExit>();
        const settle = (reason: "manual-cancel" | "overall-timeout", timedOut: boolean) => {
          if (settled) {
            return;
          }
          settled = true;
          completion.resolve({
            reason,
            exitCode: null,
            exitSignal: null,
            durationMs: input.timeoutMs ?? 0,
            stdout: "",
            stderr: "",
            timedOut,
            noOutputTimedOut: false,
          });
        };
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
            supervisorMockState.cancelReasons.push("manual-cancel");
            settle("manual-cancel", false);
          },
        };
      },
      cancel: vi.fn(),
      cancelScope: vi.fn(),
    }),
  };
});

vi.mock("../infra/shell-env.js", () => ({
  getShellPathFromLoginShell: vi.fn(() => null),
  resolveShellEnvFallbackTimeoutMs: vi.fn(() => 0),
}));

vi.mock("./bash-tools.exec-host-gateway.js", () => ({
  processGatewayAllowlist: vi.fn(async () => ({})),
}));

vi.mock("./bash-tools.exec-host-node.js", () => ({
  executeNodeHostCommand: vi.fn(async () => {
    throw new Error("node host not expected in background abort tests");
  }),
}));

const BACKGROUND_HOLD_CMD =
  process.platform === "win32" ? 'node -e "setTimeout(() => {}, 1000)"' : "exec sleep 1";
const POLL_INTERVAL_MS = process.platform === "win32" ? 15 : 5;
const FINISHED_WAIT_TIMEOUT_MS = process.platform === "win32" ? 8_000 : 1_000;
const BACKGROUND_TIMEOUT_SEC = process.platform === "win32" ? 0.2 : 0.02;
const YIELDED_BACKGROUND_TIMEOUT_SEC = process.platform === "win32" ? 0.4 : 0.2;
const TEST_EXEC_DEFAULTS = {
  host: "gateway" as const,
  security: "full" as const,
  ask: "off" as const,
};

let createExecTool: typeof import("./bash-tools.exec-run.js").createExecTool;
let getFinishedSession: typeof import("./bash-process-registry.js").getFinishedSession;
let getSession: typeof import("./bash-process-registry.js").getSession;
let resetProcessRegistryForTests: typeof import("./bash-process-registry.test-support.js").resetProcessRegistryForTests;
type ExecToolExecuteParams = Parameters<ReturnType<typeof createExecTool>["execute"]>[1];

const createTestExecTool = (
  defaults?: Parameters<typeof createExecTool>[0],
): ReturnType<typeof createExecTool> => createExecTool({ ...TEST_EXEC_DEFAULTS, ...defaults });

beforeAll(async () => {
  ({ createExecTool } = await import("./bash-tools.exec-run.js"));
  ({ getFinishedSession, getSession } = await import("./bash-process-registry.js"));
  ({ resetProcessRegistryForTests } = await import("./bash-process-registry.test-support.js"));
});

beforeEach(() => {
  vi.clearAllMocks();
  supervisorMockState.cancelReasons.length = 0;
  supervisorMockState.spawnInputs.length = 0;
});

afterEach(() => {
  resetProcessRegistryForTests();
});

async function waitForFinishedSession(sessionId: string) {
  let finished = getFinishedSession(sessionId);
  await expect
    .poll(
      () => {
        finished = getFinishedSession(sessionId);
        return Boolean(finished);
      },
      {
        timeout: FINISHED_WAIT_TIMEOUT_MS,
        interval: POLL_INTERVAL_MS,
      },
    )
    .toBe(true);
  return finished;
}

async function expectBackgroundSessionTimesOut(params: {
  tool: ReturnType<typeof createExecTool>;
  executeParams: ExecToolExecuteParams;
  abortAfterStart?: boolean;
  expectedTimeoutSec: number;
}) {
  const abortController = new AbortController();
  const result = await params.tool.execute(
    "toolcall",
    params.executeParams,
    abortController.signal,
  );
  expect(result.details.status).toBe("running");
  const sessionId = (result.details as { sessionId: string }).sessionId;
  expect(supervisorMockState.spawnInputs.at(-1)?.timeoutMs).toBe(
    Math.floor(params.expectedTimeoutSec * 1000),
  );

  if (params.abortAfterStart) {
    abortController.abort();
    expect(supervisorMockState.cancelReasons).toStrictEqual([]);
    expect(getFinishedSession(sessionId)).toBeUndefined();
    expect(getSession(sessionId)?.exited).toBe(false);
  }

  const finished = await waitForFinishedSession(sessionId);
  expect(finished?.terminalStatus).toBe("failed");
}

test("background exec still times out after tool signal abort", async () => {
  const tool = createTestExecTool({ allowBackground: true, backgroundMs: 0 });
  await expectBackgroundSessionTimesOut({
    tool,
    executeParams: {
      command: BACKGROUND_HOLD_CMD,
      background: true,
      timeoutSeconds: BACKGROUND_TIMEOUT_SEC,
    },
    abortAfterStart: true,
    expectedTimeoutSec: BACKGROUND_TIMEOUT_SEC,
  });
});

test("background exec with timeout zero bypasses default timeout", async () => {
  const tool = createTestExecTool({
    allowBackground: true,
    backgroundMs: 0,
    timeoutSec: BACKGROUND_TIMEOUT_SEC,
  });
  const result = await tool.execute("toolcall", {
    command: BACKGROUND_HOLD_CMD,
    background: true,
    timeoutSeconds: 0,
  });
  expect(result.details.status).toBe("running");
  const sessionId = (result.details as { sessionId: string }).sessionId;
  expect(supervisorMockState.spawnInputs.at(-1)?.timeoutMs).toBeUndefined();
  expect(getFinishedSession(sessionId)).toBeUndefined();
  expect(getSession(sessionId)?.exited).toBe(false);
});

test("yieldMs exec without explicit timeout applies default timeout", async () => {
  const tool = createTestExecTool({
    allowBackground: true,
    backgroundMs: 10,
    timeoutSec: YIELDED_BACKGROUND_TIMEOUT_SEC,
  });
  await expectBackgroundSessionTimesOut({
    tool,
    executeParams: {
      command: BACKGROUND_HOLD_CMD,
      yieldMs: 5,
    },
    expectedTimeoutSec: YIELDED_BACKGROUND_TIMEOUT_SEC,
  });
});
