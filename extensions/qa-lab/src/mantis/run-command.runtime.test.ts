import { expect, it, vi } from "vitest";
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
