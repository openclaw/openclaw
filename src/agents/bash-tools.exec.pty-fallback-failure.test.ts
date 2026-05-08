import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
let createExecTool: typeof import("./bash-tools.exec.js").createExecTool;
let listRunningSessions: typeof import("./bash-process-registry.js").listRunningSessions;
let resetProcessRegistryForTests: typeof import("./bash-process-registry.js").resetProcessRegistryForTests;

const { supervisorSpawnMock } = vi.hoisted(() => ({
  supervisorSpawnMock: vi.fn(),
}));

const makeSupervisor = () => {
  const noop = vi.fn();
  return {
    spawn: (...args: unknown[]) => supervisorSpawnMock(...args),
    cancel: noop,
    cancelScope: noop,
    reconcileOrphans: noop,
    getRecord: noop,
  };
};

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => makeSupervisor(),
}));

beforeAll(async () => {
  ({ createExecTool } = await import("./bash-tools.exec.js"));
  ({ listRunningSessions, resetProcessRegistryForTests } =
    await import("./bash-process-registry.js"));
});

beforeEach(() => {
  supervisorSpawnMock.mockReset();
});

afterEach(() => {
  resetProcessRegistryForTests();
  vi.clearAllMocks();
});

test("exec cleans session state when PTY fallback spawn also fails", async () => {
  supervisorSpawnMock
    .mockRejectedValueOnce(new Error("pty spawn failed"))
    .mockRejectedValueOnce(new Error("child fallback failed"));

  const tool = createExecTool({
    allowBackground: false,
    host: "gateway",
    security: "full",
    ask: "off",
  });

  await expect(
    tool.execute("toolcall", {
      command: "echo ok",
      pty: true,
    }),
  ).rejects.toThrow("child fallback failed");

  expect(listRunningSessions()).toHaveLength(0);
});
