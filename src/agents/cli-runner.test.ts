import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliBackendConfig } from "../config/types.js";
import { runCliAgent } from "./cli-runner.js";
import { cleanupSuspendedCliProcesses } from "./cli-runner/helpers.js";

const runCommandWithTimeoutMock = vi.fn();
const runExecMock = vi.fn();

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
  runExec: (...args: unknown[]) => runExecMock(...args),
}));

describe("runCliAgent stateless invocation", () => {
  beforeEach(() => {
    runCommandWithTimeoutMock.mockReset();
    runExecMock.mockReset();
  });

  it("runs CLI without session resume", async () => {
    runExecMock.mockResolvedValueOnce({
      stdout: "  1 S /bin/launchd\n",
      stderr: "",
    }); // cleanupSuspendedCliProcesses (ps)
    runCommandWithTimeoutMock.mockResolvedValueOnce({
      stdout: '{"result":"ok"}',
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
    });

    const result = await runCliAgent({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "claude-cli",
      model: "opus",
      timeoutMs: 1_000,
      runId: "run-1",
    });

    expect(result.payloads?.[0]?.text).toBe("ok");
  });
});

describe("cleanupSuspendedCliProcesses", () => {
  beforeEach(() => {
    runExecMock.mockReset();
  });

  it("skips when no session tokens are configured", async () => {
    await cleanupSuspendedCliProcesses(
      {
        command: "tool",
      } as CliBackendConfig,
      0,
    );

    if (process.platform === "win32") {
      expect(runExecMock).not.toHaveBeenCalled();
      return;
    }

    expect(runExecMock).not.toHaveBeenCalled();
  });

  it("matches sessionArg-based commands", async () => {
    runExecMock
      .mockResolvedValueOnce({
        stdout: [
          "  40 T+ claude --session-id thread-1 -p",
          "  41 S  claude --session-id thread-2 -p",
        ].join("\n"),
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    await cleanupSuspendedCliProcesses(
      {
        command: "claude",
        sessionArg: "--session-id",
      } as CliBackendConfig,
      0,
    );

    if (process.platform === "win32") {
      expect(runExecMock).not.toHaveBeenCalled();
      return;
    }

    expect(runExecMock).toHaveBeenCalledTimes(2);
    const killCall = runExecMock.mock.calls[1] ?? [];
    expect(killCall[0]).toBe("kill");
    expect(killCall[1]).toEqual(["-9", "40"]);
  });

  it("matches resumeArgs with positional session id", async () => {
    runExecMock
      .mockResolvedValueOnce({
        stdout: [
          "  50 T  codex exec resume thread-99 --color never --sandbox read-only",
          "  51 T  codex exec resume other --color never --sandbox read-only",
        ].join("\n"),
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    await cleanupSuspendedCliProcesses(
      {
        command: "codex",
        resumeArgs: ["exec", "resume", "{sessionId}", "--color", "never", "--sandbox", "read-only"],
      } as CliBackendConfig,
      1,
    );

    if (process.platform === "win32") {
      expect(runExecMock).not.toHaveBeenCalled();
      return;
    }

    expect(runExecMock).toHaveBeenCalledTimes(2);
    const killCall = runExecMock.mock.calls[1] ?? [];
    expect(killCall[0]).toBe("kill");
    expect(killCall[1]).toEqual(["-9", "50", "51"]);
  });
});
