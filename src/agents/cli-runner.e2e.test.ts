import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { CliBackendConfig } from "../config/types.js";
import { runCliAgent } from "./cli-runner.js";
import { cleanupResumeProcesses, cleanupSuspendedCliProcesses } from "./cli-runner/helpers.js";

const runCommandWithTimeoutMock = vi.fn();
const runExecMock = vi.fn();

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
  runExec: (...args: unknown[]) => runExecMock(...args),
}));

describe("runCliAgent resume cleanup", () => {
  beforeEach(() => {
    runCommandWithTimeoutMock.mockReset();
    runExecMock.mockReset();
  });

  it("kills stale resume processes for codex sessions", async () => {
    const selfPid = process.pid;

    runExecMock
      .mockResolvedValueOnce({
        stdout: "  1 999 S /bin/launchd\n",
        stderr: "",
      }) // cleanupSuspendedCliProcesses (ps) — ppid 999 != selfPid, no match
      .mockResolvedValueOnce({
        stdout: [
          `  ${selfPid + 1} ${selfPid} codex exec resume thread-123 --color never --sandbox read-only --skip-git-repo-check`,
          `  ${selfPid + 2} 999 codex exec resume thread-123 --color never --sandbox read-only --skip-git-repo-check`,
        ].join("\n"),
        stderr: "",
      }) // cleanupResumeProcesses (ps)
      .mockResolvedValueOnce({ stdout: "", stderr: "" }); // cleanupResumeProcesses (kill)
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

    expect(runExecMock).toHaveBeenCalledTimes(3);

    // Second call: cleanupResumeProcesses ps
    const psCall = runExecMock.mock.calls[1] ?? [];
    expect(psCall[0]).toBe("ps");

    // Third call: kill with only the child PID
    const killCall = runExecMock.mock.calls[2] ?? [];
    expect(killCall[0]).toBe("kill");
    const killArgs = killCall[1] as string[];
    expect(killArgs[0]).toBe("-9");
    expect(killArgs[1]).toBe(String(selfPid + 1));
    expect(killArgs).toHaveLength(2); // only -9 + one PID
  });

  it("falls back to per-agent workspace when workspaceDir is missing", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-runner-"));
    const fallbackWorkspace = path.join(tempDir, "workspace-main");
    await fs.mkdir(fallbackWorkspace, { recursive: true });
    const cfg = {
      agents: {
        defaults: {
          workspace: fallbackWorkspace,
        },
      },
    } satisfies OpenClawConfig;

    runExecMock.mockResolvedValue({ stdout: "", stderr: "" });
    runCommandWithTimeoutMock.mockResolvedValueOnce({
      stdout: "ok",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
    });

    try {
      await runCliAgent({
        sessionId: "s1",
        sessionKey: "agent:main:subagent:missing-workspace",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: undefined as unknown as string,
        config: cfg,
        prompt: "hi",
        provider: "codex-cli",
        model: "gpt-5.2-codex",
        timeoutMs: 1_000,
        runId: "run-1",
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    const options = runCommandWithTimeoutMock.mock.calls[0]?.[1] as { cwd?: string };
    expect(options.cwd).toBe(path.resolve(fallbackWorkspace));
  });

  it("throws when sessionKey is malformed", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-runner-"));
    const mainWorkspace = path.join(tempDir, "workspace-main");
    const researchWorkspace = path.join(tempDir, "workspace-research");
    await fs.mkdir(mainWorkspace, { recursive: true });
    await fs.mkdir(researchWorkspace, { recursive: true });
    const cfg = {
      agents: {
        defaults: {
          workspace: mainWorkspace,
        },
        list: [{ id: "research", workspace: researchWorkspace }],
      },
    } satisfies OpenClawConfig;

    try {
      await expect(
        runCliAgent({
          sessionId: "s1",
          sessionKey: "agent::broken",
          agentId: "research",
          sessionFile: "/tmp/session.jsonl",
          workspaceDir: undefined as unknown as string,
          config: cfg,
          prompt: "hi",
          provider: "codex-cli",
          model: "gpt-5.2-codex",
          timeoutMs: 1_000,
          runId: "run-2",
        }),
      ).rejects.toThrow("Malformed agent session key");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
    expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
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
    const selfPid = process.pid;
    runExecMock
      .mockResolvedValueOnce({
        stdout: [
          `  40 ${selfPid} T+ claude --session-id thread-1 -p`,
          `  41 ${selfPid} S  claude --session-id thread-2 -p`,
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
    const selfPid = process.pid;
    runExecMock
      .mockResolvedValueOnce({
        stdout: [
          `  50 ${selfPid} T  codex exec resume thread-99 --color never --sandbox read-only`,
          `  51 ${selfPid} T  codex exec resume other --color never --sandbox read-only`,
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

  it("only kills child processes of current process (ppid validation)", async () => {
    const selfPid = process.pid;
    const childPid = selfPid + 1;
    const unrelatedPid = 9999;

    runExecMock
      .mockResolvedValueOnce({
        stdout: [
          `  ${childPid} ${selfPid} T  claude --session-id thread-1 -p`,
          `  ${unrelatedPid} 100 T  claude --session-id thread-2 -p`,
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
    // Only childPid killed; unrelatedPid (ppid=100) excluded
    expect(killCall[1]).toEqual(["-9", String(childPid)]);
  });

  it("skips all processes when none are children of current process", async () => {
    runExecMock.mockResolvedValueOnce({
      stdout: [
        "  200 100 T  claude --session-id thread-1 -p",
        "  201 100 T  claude --session-id thread-2 -p",
      ].join("\n"),
      stderr: "",
    });

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

    // Only ps called — no kill because no matching ppid
    expect(runExecMock).toHaveBeenCalledTimes(1);
  });
});

describe("cleanupResumeProcesses", () => {
  beforeEach(() => {
    runExecMock.mockReset();
  });

  it("only kills resume processes owned by current process", async () => {
    const selfPid = process.pid;

    runExecMock
      .mockResolvedValueOnce({
        stdout: [
          `  ${selfPid + 1} ${selfPid} codex exec resume abc-123`,
          `  ${selfPid + 2} 999 codex exec resume abc-123`,
        ].join("\n"),
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    await cleanupResumeProcesses(
      {
        command: "codex",
        resumeArgs: ["exec", "resume", "{sessionId}"],
      } as CliBackendConfig,
      "abc-123",
    );

    if (process.platform === "win32") {
      expect(runExecMock).not.toHaveBeenCalled();
      return;
    }

    expect(runExecMock).toHaveBeenCalledTimes(2);
    const killCall = runExecMock.mock.calls[1] ?? [];
    expect(killCall[0]).toBe("kill");
    expect(killCall[1]).toEqual(["-9", String(selfPid + 1)]);
  });

  it("skips kill when no resume processes match ppid", async () => {
    runExecMock.mockResolvedValueOnce({
      stdout: ["  300 100 codex exec resume abc-123", "  301 200 codex exec resume abc-123"].join(
        "\n",
      ),
      stderr: "",
    });

    await cleanupResumeProcesses(
      {
        command: "codex",
        resumeArgs: ["exec", "resume", "{sessionId}"],
      } as CliBackendConfig,
      "abc-123",
    );

    if (process.platform === "win32") {
      expect(runExecMock).not.toHaveBeenCalled();
      return;
    }

    // Only ps called — no kill because no matching ppid
    expect(runExecMock).toHaveBeenCalledTimes(1);
  });
});
