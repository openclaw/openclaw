import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TmuxSessionManager } from "./manager.js";
import type { NormalizedTmuxConfig, TmuxRuntimePaths } from "./types.js";

function buildPaths(rootDir: string): TmuxRuntimePaths {
  return {
    rootDir,
    activeRunFile: path.join(rootDir, "active-run.json"),
    eventsFile: path.join(rootDir, "events.jsonl"),
    paneLogFile: path.join(rootDir, "pane.log"),
    launcherFile: path.join(rootDir, "launch-claude.mjs"),
    managedSettingsFile: path.join(rootDir, "managed-settings.json"),
    settingsFile: path.join(rootDir, "settings.json"),
    systemPromptFile: path.join(rootDir, "system-prompt.txt"),
    hookWriterFile: path.join(rootDir, "hook-writer.mjs"),
    promptBufferFile: path.join(rootDir, "prompt-buffer.txt"),
    metadataFile: path.join(rootDir, "metadata.json"),
  };
}

const config: NormalizedTmuxConfig = {
  sessionNamePrefix: "openclaw-claude",
  startupTimeoutMs: 1_000,
  turnTimeoutMs: 5_000,
  turnIdleMs: 100,
  captureLines: 20,
  stopOnAbort: true,
  memoryMode: "managed-disabled",
  hookMode: "managed",
  authMode: "openclaw",
};

describe("TmuxSessionManager", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("starts tmux through a launcher so injected env reaches Claude even with an existing tmux server", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-manager-test-"));
    tempDirs.push(rootDir);
    const paths = buildPaths(rootDir);
    const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const manager = new TmuxSessionManager(async (command, args, options) => {
      calls.push({ command, args, env: options?.env });
      if (args[0] === "has-session") {
        throw new Error("missing");
      }
      return { stdout: "", stderr: "" };
    });

    await manager.ensureSession({
      paths,
      metadata: {
        backendId: "claude-cli",
        workspaceDir: rootDir,
        sessionName: "openclaw-claude-test",
        launchHash: "launch-hash",
        model: "sonnet",
        systemPromptHash: "hash",
        memoryMode: "managed-disabled",
        hookMode: "managed",
        createdAt: 1,
        lastUsedAt: 1,
      },
      command: "claude",
      args: ["--model", "sonnet"],
      cwd: rootDir,
      env: {
        ANTHROPIC_API_KEY: "test-key",
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      },
      config,
    });

    const newSession = calls.find((call) => call.args[0] === "new-session");
    expect(newSession?.args.slice(-2)).toEqual(["node", paths.launcherFile]);
    expect(newSession?.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(newSession?.args).toContain("-e");
    expect(newSession?.args).toContain("ANTHROPIC_API_KEY=test-key");

    const launcher = await fs.readFile(paths.launcherFile, "utf8");
    expect(launcher).toContain('"ANTHROPIC_API_KEY"');
    expect(launcher).not.toContain("test-key");
    expect(launcher).toContain('"CLAUDE_CODE_DISABLE_AUTO_MEMORY"');
    expect(launcher).toContain("spawn(command, args");
  });

  it("recreates an existing session when the launch hash changes", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-manager-test-"));
    tempDirs.push(rootDir);
    const paths = buildPaths(rootDir);
    await fs.writeFile(
      paths.metadataFile,
      `${JSON.stringify({
        backendId: "claude-cli",
        workspaceDir: rootDir,
        sessionName: "openclaw-claude-test",
        launchHash: "old-launch-hash",
        model: "sonnet",
        systemPromptHash: "hash",
        memoryMode: "managed-disabled",
        hookMode: "managed",
        createdAt: 1,
        lastUsedAt: 1,
      })}\n`,
    );
    const calls: Array<{ args: string[] }> = [];
    const manager = new TmuxSessionManager(async (_command, args) => {
      calls.push({ args });
      return { stdout: "", stderr: "" };
    });

    await manager.ensureSession({
      paths,
      metadata: {
        backendId: "claude-cli",
        workspaceDir: rootDir,
        sessionName: "openclaw-claude-test",
        launchHash: "new-launch-hash",
        model: "sonnet",
        systemPromptHash: "hash",
        memoryMode: "managed-disabled",
        hookMode: "managed",
        createdAt: 1,
        lastUsedAt: 1,
      },
      command: "claude",
      args: ["--model", "sonnet"],
      cwd: rootDir,
      env: {},
      config,
    });

    expect(calls.some((call) => call.args[0] === "kill-session")).toBe(true);
    expect(calls.some((call) => call.args[0] === "new-session")).toBe(true);
  });

  it("truncates stale pane and event logs when creating a fresh session", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tmux-manager-test-"));
    tempDirs.push(rootDir);
    const paths = buildPaths(rootDir);
    await fs.writeFile(paths.paneLogFile, "Claude Code v0.0.0\nold output");
    await fs.writeFile(
      paths.eventsFile,
      `${JSON.stringify({ event: "SessionStart", timestamp: 1 })}\n`,
    );
    const manager = new TmuxSessionManager(async (_command, args) => {
      if (args[0] === "has-session") {
        throw new Error("missing");
      }
      return { stdout: "", stderr: "" };
    });

    await manager.ensureSession({
      paths,
      metadata: {
        backendId: "claude-cli",
        workspaceDir: rootDir,
        sessionName: "openclaw-claude-test",
        launchHash: "launch-hash",
        model: "sonnet",
        systemPromptHash: "hash",
        memoryMode: "managed-disabled",
        hookMode: "managed",
        createdAt: 1,
        lastUsedAt: 1,
      },
      command: "claude",
      args: ["--model", "sonnet"],
      cwd: rootDir,
      env: {},
      config,
    });

    await expect(fs.readFile(paths.paneLogFile, "utf8")).resolves.toBe("");
    await expect(fs.readFile(paths.eventsFile, "utf8")).resolves.toBe("");
  });
});
