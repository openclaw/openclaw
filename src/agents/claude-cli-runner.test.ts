import { beforeEach, describe, expect, it, vi } from "vitest";

import { runClaudeCliAgent } from "./claude-cli-runner.js";

const runCommandWithTimeoutMock = vi.fn();

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

describe("runClaudeCliAgent", () => {
  beforeEach(() => {
    runCommandWithTimeoutMock.mockReset();
  });

  it("starts a new session without --session-id when no resume id", async () => {
    runCommandWithTimeoutMock.mockResolvedValueOnce({
      stdout: JSON.stringify({ message: "ok", session_id: "sid-1" }),
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
    });

    await runClaudeCliAgent({
      sessionId: "clawdbot-session",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      model: "opus",
      timeoutMs: 1_000,
      runId: "run-1",
    });

    expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(1);
    const argv = runCommandWithTimeoutMock.mock.calls[0]?.[0] as string[];
    expect(argv).toContain("claude");
    expect(argv).not.toContain("--session-id");
    expect(argv).not.toContain("--resume");
  });

  it("uses --resume when a resume session id is provided", async () => {
    runCommandWithTimeoutMock.mockResolvedValueOnce({
      stdout: JSON.stringify({ message: "ok", session_id: "sid-2" }),
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
    });

    await runClaudeCliAgent({
      sessionId: "clawdbot-session",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      model: "opus",
      timeoutMs: 1_000,
      runId: "run-2",
      resumeSessionId: "sid-1",
    });

    expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(1);
    const argv = runCommandWithTimeoutMock.mock.calls[0]?.[0] as string[];
    expect(argv).toContain("--resume");
    expect(argv).toContain("sid-1");
    expect(argv).not.toContain("--session-id");
  });
});
