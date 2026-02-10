import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { CliBackendConfig } from "../config/types.js";
import { runCliAgent } from "./cli-runner.js";
import { cleanupSuspendedCliProcesses } from "./cli-runner/helpers.js";

const runCommandWithTimeoutMock = vi.fn();
const runExecMock = vi.fn();
const runCliWithStreamingMock = vi.fn();

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
  runExec: (...args: unknown[]) => runExecMock(...args),
}));

vi.mock("./cli-runner/streaming.js", () => ({
  runCliWithStreaming: (...args: unknown[]) => runCliWithStreamingMock(...args),
  mapCliStreamEvent: () => null,
}));

describe("runCliAgent resume cleanup", () => {
  beforeEach(() => {
    runCommandWithTimeoutMock.mockReset();
    runExecMock.mockReset();
    runCliWithStreamingMock.mockReset();
  });

  it("kills stale resume processes for codex sessions", async () => {
    runExecMock
      .mockResolvedValueOnce({
        stdout: "  1 S /bin/launchd\n",
        stderr: "",
      }) // cleanupSuspendedCliProcesses (ps)
      .mockResolvedValueOnce({ stdout: "", stderr: "" }); // cleanupResumeProcesses (pkill)
    // Codex CLI now uses streaming by default
    runCliWithStreamingMock.mockResolvedValueOnce({
      text: "ok",
      sessionId: "thread-123",
      events: [],
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

    expect(runExecMock).toHaveBeenCalledTimes(2);
    const pkillCall = runExecMock.mock.calls[1] ?? [];
    expect(pkillCall[0]).toBe("pkill");
    const pkillArgs = pkillCall[1] as string[];
    expect(pkillArgs[0]).toBe("-f");
    expect(pkillArgs[1]).toContain("codex");
    expect(pkillArgs[1]).toContain("resume");
    expect(pkillArgs[1]).toContain("thread-123");
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
