import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeTmuxCliRun } from "./execute.js";
import type { TmuxExecutionInput, TmuxRuntimePaths } from "./types.js";

class FakeTmuxManager {
  paths?: TmuxRuntimePaths;
  sessionNames: string[] = [];

  async ensureSession(params: { paths: TmuxRuntimePaths; metadata: { sessionName: string } }) {
    this.paths = params.paths;
    this.sessionNames.push(params.metadata.sessionName);
    await fs.writeFile(params.paths.paneLogFile, "Claude Code v2.1.140\nprevious turn text");
    await fs.writeFile(params.paths.eventsFile, "");
  }

  async pastePrompt(params: { promptFile: string }) {
    if (!this.paths) {
      throw new Error("missing paths");
    }
    const promptEcho = await fs.readFile(params.promptFile, "utf8");
    await fs.appendFile(this.paths.paneLogFile, `> ${promptEcho}Hello from Claude`);
    await fs.appendFile(
      this.paths.eventsFile,
      `${JSON.stringify({
        event: "UserPromptSubmit",
        runId: "run-1",
        claudeSessionId: "claude-session",
        timestamp: Date.now(),
        stdin: { session_id: "claude-session" },
      })}\n`,
    );
    await fs.appendFile(
      this.paths.eventsFile,
      `${JSON.stringify({
        event: "Stop",
        runId: "run-1",
        claudeSessionId: "claude-session",
        timestamp: Date.now(),
        stdin: { session_id: "claude-session" },
      })}\n`,
    );
  }

  async captureTail() {
    return "tail";
  }

  async interrupt() {}
}

describe("executeTmuxCliRun", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("streams pane output and completes on current-run Stop hook", async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-test-"));
    tempDirs.push(runtimeDir);
    const onAssistantTurn = vi.fn();

    const output = await executeTmuxCliRun(
      {
        backend: {
          command: "claude",
          args: ["-p", "--bare", "--strict-mcp-config", "--mcp-config", "/tmp/mcp.json"],
          modelArg: "--model",
          execution: { mode: "tmux", tmux: { runtimeDir } },
        },
        backendId: "claude-cli",
        workspaceDir: runtimeDir,
        sessionId: "openclaw-session",
        runId: "run-1",
        modelId: "sonnet",
        systemPrompt: "system",
        prompt: "hello",
        timeoutMs: 5_000,
        env: {},
        onAssistantTurn,
      },
      new FakeTmuxManager() as never,
    );

    expect(output).toEqual({ text: "Hello from Claude", sessionId: "claude-session" });
    expect(onAssistantTurn).toHaveBeenCalledWith("Hello from Claude");
    expect(onAssistantTurn).not.toHaveBeenCalledWith(expect.stringContaining("previous turn text"));
    expect(onAssistantTurn).not.toHaveBeenCalledWith(expect.stringContaining("hello"));
  });

  it("keeps the tmux session name stable when Claude reports a session id", async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-test-"));
    tempDirs.push(runtimeDir);
    const manager = new FakeTmuxManager();
    const baseInput: Omit<TmuxExecutionInput, "runId" | "prompt" | "cliSessionId"> = {
      backend: {
        command: "claude",
        args: ["-p", "--bare"],
        modelArg: "--model",
        sessionArg: "--session-id",
        execution: { mode: "tmux", tmux: { runtimeDir } },
      },
      backendId: "claude-cli",
      workspaceDir: runtimeDir,
      sessionId: "openclaw-session",
      modelId: "sonnet",
      systemPrompt: "system",
      timeoutMs: 5_000,
      env: {},
    };

    await executeTmuxCliRun(
      { ...baseInput, runId: "run-1", prompt: "hello", cliSessionId: "openclaw-cli-uuid" },
      manager as never,
    );
    await executeTmuxCliRun(
      { ...baseInput, runId: "run-2", prompt: "again", cliSessionId: "claude-session" },
      manager as never,
    );

    expect(manager.sessionNames).toHaveLength(2);
    expect(manager.sessionNames[0]).toBe(manager.sessionNames[1]);
  });
});
