import { runInNewContext } from "node:vm";
import { beforeEach, expect, it, vi } from "vitest";
const { runCommandWithTimeout } = vi.hoisted(() => ({
  runCommandWithTimeout: vi.fn().mockResolvedValue({
    code: 0,
    killed: false,
    signal: null,
    stderr: "",
    stdout: "",
    termination: "exit",
    cleanup: "normal",
  }),
}));
vi.mock("openclaw/plugin-sdk/process-runtime", () => ({ runCommandWithTimeout }));
import {
  defaultMantisCommandRunner,
  MantisCommandCleanupError,
  runMantisCommand,
} from "./run-command.runtime.js";

beforeEach(() => {
  runCommandWithTimeout.mockClear();
});

it("refuses unowned Windows stages before spawning a command", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (!descriptor) {
    throw new Error("missing process platform descriptor");
  }
  Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
  try {
    await expect(
      runMantisCommand({
        command: "pnpm",
        args: ["build"],
        lane: "baseline",
        runner: defaultMantisCommandRunner,
        execution: { cwd: ".", env: {}, stage: "build", timeoutMs: 1000 },
      }),
    ).rejects.toBeInstanceOf(MantisCommandCleanupError);
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
});

it.skipIf(process.platform === "win32").each([false, true])(
  "keeps the generated command behind cwd identity admission (replaced=%s)",
  async (replaced) => {
    await defaultMantisCommandRunner("fixture-command", ["fixture-argument"], {
      cwd: ".",
      env: {},
      stage: "build",
      timeoutMs: 1000,
      expectedCwdIdentity: { dev: 1n, ino: 2n },
    });
    const argv = runCommandWithTimeout.mock.calls[0]?.[0];
    const script: unknown = argv?.[3];
    if (typeof script !== "string") {
      throw new Error("owner-bound command script was not prepared");
    }
    const spawnSync = vi.fn(() => ({ status: 7 }));
    const stderr = vi.fn();
    const childProcess = {
      argv: ["node", "1", "2", "fixture-command", "fixture-argument"],
      stderr: { write: stderr },
      exitCode: 0,
    };
    runInNewContext(script, {
      process: childProcess,
      require: (name: string) => {
        if (name === "node:fs") {
          return {
            lstatSync: () => ({ isDirectory: () => true, dev: 1n, ino: replaced ? 3n : 2n }),
          };
        }
        if (name === "node:child_process") {
          return { spawnSync };
        }
        throw new Error("unexpected generated command dependency");
      },
    });
    expect(childProcess.exitCode).toBe(replaced ? 78 : 7);
    if (replaced) {
      expect(spawnSync).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining("refused a replaced working directory"),
      );
    } else {
      expect(spawnSync).toHaveBeenCalledExactlyOnceWith("fixture-command", ["fixture-argument"], {
        stdio: "inherit",
        windowsHide: true,
      });
      expect(stderr).not.toHaveBeenCalled();
    }
  },
);
