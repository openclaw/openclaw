import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { ManagedRun, SpawnInput } from "../process/supervisor/index.js";

let listRunningSessions: typeof import("./bash-process-registry.js").listRunningSessions;
let resetProcessRegistryForTests: typeof import("./bash-process-registry.js").resetProcessRegistryForTests;
let runExecProcess: typeof import("./bash-tools.exec-runtime.js").runExecProcess;

const { supervisorSpawnMock } = vi.hoisted(() => ({
  supervisorSpawnMock: vi.fn(),
}));

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({
    spawn: supervisorSpawnMock,
    cancel: vi.fn(),
    cancelScope: vi.fn(),
    reconcileOrphans: vi.fn(),
    getRecord: vi.fn(),
  }),
}));

function createSuccessfulRun(input: SpawnInput): ManagedRun {
  input.onStdout?.("ok");
  return {
    runId: input.runId ?? "test-run",
    pid: 1234,
    startedAtMs: Date.now(),
    stdin: {
      write: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    },
    cancel: vi.fn(),
    wait: vi.fn(async () => ({
      reason: "exit" as const,
      exitCode: 0,
      exitSignal: null,
      durationMs: 1,
      stdout: "",
      stderr: "",
      timedOut: false,
      noOutputTimedOut: false,
    })),
  };
}

beforeAll(async () => {
  ({ listRunningSessions, resetProcessRegistryForTests } =
    await import("./bash-process-registry.js"));
  ({ runExecProcess } = await import("./bash-tools.exec-runtime.js"));
});

beforeEach(() => {
  supervisorSpawnMock.mockReset();
});

afterEach(() => {
  resetProcessRegistryForTests();
  vi.clearAllMocks();
});

function runPtyFallback(warnings: string[] = []) {
  return runExecProcess({
    command: "printf ok",
    workdir: process.cwd(),
    env: {},
    usePty: true,
    warnings,
    maxOutput: 20_000,
    pendingMaxOutput: 20_000,
    notifyOnExit: false,
    timeoutSec: 5,
  });
}

test("exec falls back when PTY spawn fails", async () => {
  supervisorSpawnMock
    .mockRejectedValueOnce(new Error("pty spawn failed"))
    .mockImplementationOnce(async (input: SpawnInput) => createSuccessfulRun(input));

  const warnings: string[] = [];
  const handle = await runPtyFallback(warnings);
  const outcome = await handle.promise;

  expect(outcome.status).toBe("completed");
  expect(outcome.aggregated).toContain("ok");
  expect(warnings.join("\n")).toContain("PTY spawn failed");
  expect(supervisorSpawnMock).toHaveBeenNthCalledWith(1, expect.objectContaining({ mode: "pty" }));
  expect(supervisorSpawnMock).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ mode: "child" }),
  );
});

test("exec cleans session state when PTY fallback spawn also fails", async () => {
  supervisorSpawnMock
    .mockRejectedValueOnce(new Error("pty spawn failed"))
    .mockRejectedValueOnce(new Error("child fallback failed"));

  await expect(runPtyFallback()).rejects.toThrow("child fallback failed");

  expect(listRunningSessions()).toHaveLength(0);
});
