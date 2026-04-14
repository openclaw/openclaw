import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
let createExecTool: typeof import("./bash-tools.exec.js").createExecTool;
let resetProcessRegistryForTests: typeof import("./bash-process-registry.js").resetProcessRegistryForTests;

const { ptySpawnMock } = vi.hoisted(() => ({
  ptySpawnMock: vi.fn(),
}));

vi.mock("@lydell/node-pty", () => ({
  spawn: (...args: unknown[]) => ptySpawnMock(...args),
}));

beforeAll(async () => {
  ({ createExecTool } = await import("./bash-tools.exec.js"));
  ({ resetProcessRegistryForTests } = await import("./bash-process-registry.js"));
});

beforeEach(() => {
  ptySpawnMock.mockReset();
});

afterEach(() => {
  resetProcessRegistryForTests();
  vi.clearAllMocks();
});

test("exec disposes PTY listeners after normal exit", async () => {
  const disposeData = vi.fn();
  const disposeExit = vi.fn();

  ptySpawnMock.mockImplementation(() => ({
    pid: 0,
    write: vi.fn(),
    onData: (listener: (value: string) => void) => {
      listener("ok");
      return { dispose: disposeData };
    },
    onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => {
      listener({ exitCode: 0 });
      return { dispose: disposeExit };
    },
    kill: vi.fn(),
  }));

  const tool = createExecTool({
    allowBackground: false,
    host: "gateway",
    security: "full",
    ask: "off",
  });
  const result = await tool.execute("toolcall", {
    command: "echo ok",
    pty: true,
  });

  expect(result.details.status).toBe("completed");
  expect(disposeData).toHaveBeenCalledTimes(1);
  expect(disposeExit).toHaveBeenCalledTimes(1);
});

test("exec tears down PTY resources on timeout", async () => {
  const disposeData = vi.fn();
  const disposeExit = vi.fn();
  let exitListener: ((event: { exitCode: number; signal?: number }) => void) | undefined;
  const kill = vi.fn(() => {
    // Mirror real PTY behavior: process exits shortly after force-kill.
    exitListener?.({ exitCode: 137, signal: 9 });
  });

  ptySpawnMock.mockImplementation(() => ({
    pid: 0,
    write: vi.fn(),
    onData: () => ({ dispose: disposeData }),
    onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => {
      exitListener = listener;
      return { dispose: disposeExit };
    },
    kill,
  }));

  const tool = createExecTool({
    allowBackground: false,
    host: "gateway",
    security: "full",
    ask: "off",
  });
  const result = await tool.execute("toolcall", {
    command: "sleep 5",
    pty: true,
    timeout: 0.01,
  });

  expect(result.details).toMatchObject({
    status: "failed",
    timedOut: true,
    exitCode: 137,
  });
  expect((result.content[0] as { text?: string }).text).toMatch(/Command timed out/);
  expect(kill).toHaveBeenCalledTimes(1);
  expect(disposeData).toHaveBeenCalledTimes(1);
  expect(disposeExit).toHaveBeenCalledTimes(1);
});
