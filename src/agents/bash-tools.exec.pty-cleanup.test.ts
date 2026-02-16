import { afterEach, expect, test, vi } from "vitest";
import { resetProcessRegistryForTests } from "./bash-process-registry";

afterEach(() => {
  resetProcessRegistryForTests();
  vi.resetModules();
  vi.clearAllMocks();
});

test("exec disposes PTY listeners after normal exit", async () => {
  const disposeData = vi.fn();
  const disposeExit = vi.fn();

  vi.doMock("@lydell/node-pty", () => ({
    spawn: () => {
      return {
        pid: 0,
        write: vi.fn(),
        onData: (listener: (value: string) => void) => {
          setTimeout(() => listener("ok"), 0);
          return { dispose: disposeData };
        },
        onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => {
          setTimeout(() => listener({ exitCode: 0 }), 0);
          return { dispose: disposeExit };
        },
        kill: vi.fn(),
      };
    },
  }));

  const { createExecTool } = await import("./bash-tools.exec");
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
  const kill = vi.fn();

  vi.doMock("@lydell/node-pty", () => ({
    spawn: () => {
      return {
        pid: 0,
        write: vi.fn(),
        onData: () => ({ dispose: disposeData }),
        onExit: () => ({ dispose: disposeExit }),
        kill,
      };
    },
  }));

  const { createExecTool } = await import("./bash-tools.exec");
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
