import { beforeEach, describe, expect, it, vi } from "vitest";

import { runCliAgent } from "./cli-runner.js";

const runCommandWithTimeoutMock = vi.fn();
const runExecMock = vi.fn();

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) =>
    runCommandWithTimeoutMock(...args),
  runExec: (...args: unknown[]) => runExecMock(...args),
}));

describe("runCliAgent resume cleanup", () => {
  beforeEach(() => {
    runCommandWithTimeoutMock.mockReset();
    runExecMock.mockReset();
  });

  it("kills stale resume processes for codex sessions", async () => {
    runExecMock.mockResolvedValue({ stdout: "", stderr: "" });
    runCommandWithTimeoutMock.mockResolvedValueOnce({
      stdout: "ok",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
    });

    await runCliAgent({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "codex-cli",
      model: "gpt-5.2-codex",
      timeoutMs: 1_000,
      runId: "run-1",
      cliSessionId: "thread-123",
    });

    if (process.platform === "win32") {
      expect(runExecMock).not.toHaveBeenCalled();
      return;
    }

    expect(runExecMock).toHaveBeenCalledTimes(1);
    const args = runExecMock.mock.calls[0] ?? [];
    expect(args[0]).toBe("pkill");
    const pkillArgs = args[1] as string[];
    expect(pkillArgs[0]).toBe("-f");
    expect(pkillArgs[1]).toContain("codex");
    expect(pkillArgs[1]).toContain("resume");
    expect(pkillArgs[1]).toContain("thread-123");
  });
});
