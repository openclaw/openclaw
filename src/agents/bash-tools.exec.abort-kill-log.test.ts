// Verifies the exec tool logs which child process was killed by a run abort.
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { RunExit } from "../process/supervisor/types.js";
import { createDeferredCore } from "../shared/deferred.js";

const mockState = vi.hoisted(() => ({
  cancelCount: 0,
  spawnCount: 0,
  infoMessages: [] as string[],
}));

vi.mock("../logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logger.js")>()),
  logInfo: (message: string) => {
    mockState.infoMessages.push(message);
  },
}));

// mock-isolation: a counting fake supervisor observes kill behaviour without spawning real children.
vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({
    spawn: async () => {
      mockState.spawnCount += 1;
      let settled = false;
      const completion = createDeferredCore<RunExit>();
      return {
        activity: {
          get resultSettled() {
            return settled;
          },
          lastOutputAtMs: Date.now(),
        },
        runId: `mock-run-${mockState.spawnCount}`,
        startedAtMs: Date.now(),
        stdin: undefined,
        wait: () => completion.promise,
        cancel: () => {
          mockState.cancelCount += 1;
          if (settled) {
            return;
          }
          settled = true;
          completion.resolve({
            reason: "manual-cancel",
            exitCode: null,
            exitSignal: null,
            durationMs: 0,
            stdout: "",
            stderr: "",
            timedOut: false,
            noOutputTimedOut: false,
          });
        },
      };
    },
    cancel: vi.fn(),
    cancelScope: vi.fn(),
  }),
}));

// mock-isolation: keeps the tool off the real login shell, so the test cannot depend on the host.
vi.mock("../infra/shell-env.js", () => ({
  getShellPathFromLoginShell: vi.fn(() => null),
  resolveShellEnvFallbackTimeoutMs: vi.fn(() => 0),
}));
// mock-isolation: the gateway host executor is stubbed so no command leaves the test process.
vi.mock("./bash-tools.exec-host-gateway.js", () => ({
  processGatewayAllowlist: vi.fn(async () => ({})),
}));
// mock-isolation: the node host executor throws on purpose; reaching it means the wrong path ran.
vi.mock("./bash-tools.exec-host-node.js", () => ({
  executeNodeHostCommand: vi.fn(async () => {
    throw new Error("node host not expected in abort kill log tests");
  }),
}));

const TEST_EXEC_DEFAULTS = {
  host: "gateway" as const,
  security: "full" as const,
  ask: "off" as const,
};

let createExecTool: typeof import("./bash-tools.exec-run.js").createExecTool;
let resetProcessRegistryForTests: typeof import("./bash-process-registry.test-support.js").resetProcessRegistryForTests;

beforeAll(async () => {
  ({ createExecTool } = await import("./bash-tools.exec-run.js"));
  ({ resetProcessRegistryForTests } = await import("./bash-process-registry.test-support.js"));
});

beforeEach(() => {
  vi.clearAllMocks();
  mockState.cancelCount = 0;
  mockState.spawnCount = 0;
  mockState.infoMessages.length = 0;
});

afterEach(() => {
  resetProcessRegistryForTests();
});

function abortKillLogs(): string[] {
  return mockState.infoMessages.filter((message) => message.startsWith("exec: abort killed child"));
}

test("foreground exec logs the killed child when the run is aborted", async () => {
  const tool = createExecTool({ ...TEST_EXEC_DEFAULTS });
  const abortController = new AbortController();

  // Long timeout so only the abort can end this run.
  const pending = tool
    .execute("toolcall", { command: "sleep 30", timeoutSeconds: 30 }, abortController.signal)
    .catch((error: unknown) => error);

  // Let the spawn settle so the abort lands on a live child, not on startup.
  await vi.waitFor(() => {
    expect(mockState.spawnCount).toBe(1);
  });

  abortController.abort();
  await pending;

  // The child was actually killed...
  expect(mockState.cancelCount).toBe(1);
  // ...and the operator can now see which command died with the run.
  expect(abortKillLogs()).toHaveLength(1);
  const line = abortKillLogs()[0] ?? "";
  expect(line).toContain("session=");
  expect(line).toContain("pid=");
  // Safe label only: the derived verb+target, never the raw command string.
  expect(line).toContain("command=sleep 30");
});

test("aborting a backgrounded exec logs no kill line because the child survives", async () => {
  // Tool-call abort deliberately does not kill backgrounded sessions, so there
  // is no child death to report. Guards against logging a kill that never happened.
  const tool = createExecTool({ ...TEST_EXEC_DEFAULTS, allowBackground: true, backgroundMs: 0 });
  const abortController = new AbortController();

  const result = await tool.execute(
    "toolcall",
    { command: "sleep 30", background: true, timeoutSeconds: 30 },
    abortController.signal,
  );
  expect(result.details.status).toBe("running");

  abortController.abort();

  expect(mockState.cancelCount).toBe(0);
  expect(abortKillLogs()).toHaveLength(0);
});
