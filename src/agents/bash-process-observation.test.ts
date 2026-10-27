import { afterEach, expect, it, vi } from "vitest";
import { withExecRequestTurn } from "../infra/exec-request-context.js";
import { readBackgroundProcesses, stopBackgroundProcess } from "./bash-process-observation.js";
import {
  addSession,
  appendOutput,
  deleteSession,
  markExited,
  waitForExecScope,
} from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { createRunExit } from "./bash-tools.exec-runtime.test-support.js";
import { runningSession } from "./bash-tools.lifecycle.test-support.js";

const { cancel, spawn } = vi.hoisted(() => ({
  cancel: vi.fn(() => true),
  spawn: vi.fn(),
}));
// mock-isolation: Only process I/O and approval setup are fixed; request ownership and observation are real.
vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({ cancel, spawn }),
}));
vi.mock("./bash-tools.exec-host-gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bash-tools.exec-host-gateway.js")>()),
  processGatewayAllowlist: vi.fn(async () => ({})),
}));
afterEach(() => {
  resetProcessRegistryForTests();
  cancel.mockClear();
  spawn.mockReset();
  vi.useRealTimers();
});
const scope = { scopeKeys: ["agent:main:owner"], agentId: "main" };
const seed = (id: string, scopeKey = scope.scopeKeys[0]) => {
  const session = createProcessSessionFixture({ id, backgrounded: true, startedAt: 1 });
  session.scopeKey = scopeKey;
  session.agentId = "main";
  session.processActivity = { resultSettled: false, lastOutputAtMs: session.startedAt };
  addSession(session);
  return session;
};

it("observes retained task ownership without mistaking detached or unknown commands for task work", async () => {
  vi.useFakeTimers();
  const completion = Promise.withResolvers<ReturnType<typeof createRunExit>>();
  const launched = Promise.withResolvers<void>();
  spawn.mockImplementation(async (input: { runId: string }) => {
    launched.resolve();
    return {
      runId: input.runId,
      activity: { resultSettled: false, lastOutputAtMs: 1 },
      wait: () => completion.promise,
    };
  });
  const identity = { runId: "task-run", sessionId: "task-session" };
  const launch = (background: boolean) =>
    withExecRequestTurn({ identity }, () =>
      createExecTool({
        ...identity,
        host: "gateway",
        security: "full",
        ask: "off",
        scopeKey: scope.scopeKeys[0],
        agentId: scope.agentId,
        allowBackground: true,
        notifyOnExit: false,
      }).execute("exec", { command: "fixture-command", background, yieldMs: 10 }),
    );
  const unknown = seed("unknown");
  try {
    const owned = launch(false);
    await Promise.race([
      launched.promise,
      owned.then((result) => {
        throw new Error(`Exec did not start: ${JSON.stringify(result.details)}`);
      }),
    ]);
    await vi.advanceTimersByTimeAsync(10);
    const ownedId = runningSession((await owned).details).sessionId;
    const serviceId = runningSession((await launch(true)).details).sessionId;
    const running = readBackgroundProcesses(scope).processes;
    expect(
      Object.fromEntries(
        running.map(({ processId, taskOwned, status }) => [processId, { taskOwned, status }]),
      ),
    ).toEqual({
      [unknown.id]: { taskOwned: false, status: "running" },
      [serviceId]: { taskOwned: false, status: "running" },
      [ownedId]: { taskOwned: true, status: "running" },
    });
  } finally {
    markExited(unknown, 0, null, "completed");
    completion.resolve(createRunExit());
    await waitForExecScope(scope.scopeKeys[0]!);
  }
  expect(readBackgroundProcesses(scope).processes.filter((row) => row.taskOwned)).toMatchObject([
    { status: "completed", taskOwned: true, canStop: false },
  ]);
});

it("keeps the observed incarnation through completion and refuses a same-slug successor", () => {
  const first = seed("same-slug");
  const observed = readBackgroundProcesses(scope).processes[0]!;
  expect(stopBackgroundProcess(scope, observed)).toEqual({ requested: true });
  expect(cancel).toHaveBeenCalledExactlyOnceWith(first.id, "manual-cancel");
  markExited(first, 0, null, "completed");
  expect(readBackgroundProcesses(scope).processes[0]?.instanceId).toBe(observed.instanceId);
  deleteSession(first.id);
  const replacement = seed(first.id);
  cancel.mockClear();
  expect(stopBackgroundProcess(scope, observed)).toEqual({ requested: false });
  expect(cancel).not.toHaveBeenCalled();
  expect(readBackgroundProcesses(scope).processes[0]?.instanceId).not.toBe(observed.instanceId);
  expect(
    stopBackgroundProcess(
      { ...scope, scopeKeys: ["another-session"] },
      {
        processId: replacement.id,
        instanceId: readBackgroundProcesses(scope).processes[0]!.instanceId,
      },
    ),
  ).toEqual({ requested: false });
});

it("bounds encoded output and rows without consuming agent output or crossing global agent scope", () => {
  for (let i = 0; i < 80; i++) {
    const session = seed(String(i));
    appendOutput(session, "stdout", "界".repeat(2200));
  }
  const result = readBackgroundProcesses(scope);
  expect(result.truncated).toBe(true);
  expect(result.processes.length).toBeGreaterThan(0);
  expect(result.processes.length).toBeLessThanOrEqual(50);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(50 * 1024);
  expect(result.processes.every((row) => row.tail.length <= 2000 && row.truncated)).toBe(true);
  const global = seed("global-main", "global");
  const readGlobal = { scopeKeys: ["global"], agentId: "other" };
  expect(readBackgroundProcesses(readGlobal).processes).toEqual([]);
  global.agentId = undefined;
  expect(readBackgroundProcesses({ ...readGlobal, agentId: "main" }).processes).toEqual([]);
});

it.each([
  { requested: true, reason: "manual-cancel", cleanupFailed: false, status: "killed" },
  { requested: true, reason: "overall-timeout", cleanupFailed: false, status: "failed" },
  { requested: true, reason: "manual-cancel", cleanupFailed: true, status: "failed" },
  { requested: false, reason: "manual-cancel", cleanupFailed: false, status: "failed" },
] as const)(
  "projects confirmed Stop without hiding other failures: $reason/$cleanupFailed/$requested",
  ({ requested, reason, cleanupFailed, status }) => {
    const session = seed("stop-outcome");
    session.cancellationRequested = requested;
    session.finalizationFailed = cleanupFailed;
    markExited(session, null, "SIGTERM", "failed", reason);
    expect(readBackgroundProcesses(scope).processes[0]).toMatchObject({ status, canStop: false });
  },
);
