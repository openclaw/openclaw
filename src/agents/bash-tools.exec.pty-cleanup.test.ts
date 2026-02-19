import { afterEach, expect, test, vi } from "vitest";
import { resetProcessRegistryForTests } from "./bash-process-registry.js";
import { createExecTool } from "./bash-tools.exec.js";

const { ptySpawnMock } = vi.hoisted(() => ({
  ptySpawnMock: vi.fn(),
}));

vi.mock("@lydell/node-pty", () => ({
  spawn: (...args: unknown[]) => ptySpawnMock(...args),
}));

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

  const tool = createExecTool({ allowBackground: false });
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

  const tool = createExecTool({ allowBackground: false });
  await expect(
    tool.execute("toolcall", {
      command: "sleep 5",
      pty: true,
      timeout: 0.01,
    }),
  ).rejects.toThrow("Command timed out");
  expect(kill).toHaveBeenCalledTimes(1);
  expect(disposeData).toHaveBeenCalledTimes(1);
  expect(disposeExit).toHaveBeenCalledTimes(1);
});
