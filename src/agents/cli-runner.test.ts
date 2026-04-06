import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

let runCliAgent: typeof import("./cli-runner.js").runCliAgent;
let resolveCliNoOutputTimeoutMs: typeof import("./cli-runner/helpers.js").resolveCliNoOutputTimeoutMs;

const supervisorSpawnMock = vi.fn();
const enqueueSystemEventMock = vi.fn();
const requestHeartbeatNowMock = vi.fn();
const hoisted = vi.hoisted(() => {
  type BootstrapContext = {
    bootstrapFiles: WorkspaceBootstrapFile[];
    contextFiles: EmbeddedContextFile[];
  };

  return {
    resolveBootstrapContextForRunMock: vi.fn<() => Promise<BootstrapContext>>(async () => ({
      bootstrapFiles: [],
      contextFiles: [],
    })),
  };
});
const ensureMcpConfigFileMock = vi.hoisted(() => vi.fn(() => "/tmp/openclaw-mcp.json"));
const getGlobalHookRunnerMock = vi.hoisted(() => vi.fn(() => null));

vi.mock("../gateway/mcp-http.js", () => ({
  MCP_PORT_OFFSET: 1,
  ensureMcpConfigFile: (...args: unknown[]) => (ensureMcpConfigFileMock as Function)(...args),
  getActiveMcpLoopbackRuntime: () => undefined,
  createMcpLoopbackServerConfig: () => undefined,
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: (...args: unknown[]) => (getGlobalHookRunnerMock as Function)(...args),
}));

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({
    spawn: async (...args: unknown[]) => {
      const input = args[0] as { onStdout?: (chunk: string) => void } | undefined;
      const managedRun = (await supervisorSpawnMock(...args)) as
        | { __stdoutForStreaming?: string; wait?: () => Promise<{ stdout?: string }> }
        | undefined;
      if (input?.onStdout && typeof managedRun?.__stdoutForStreaming === "string") {
        input.onStdout(managedRun.__stdoutForStreaming);
      }
      if (input?.onStdout && managedRun?.wait) {
        const originalWait = managedRun.wait.bind(managedRun);
        managedRun.wait = async () => {
          const result = await originalWait();
          if (typeof result?.stdout === "string") {
            input.onStdout?.(result.stdout);
          }
          return result;
        };
      }
      return managedRun;
    },
    cancel: vi.fn(),
    cancelScope: vi.fn(),
    cancelSession: vi.fn(() => 0),
    reconcileOrphans: vi.fn(),
    getRecord: vi.fn(),
  }),
}));

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
}));

vi.mock("../infra/heartbeat-wake.js", () => ({
  requestHeartbeatNow: (...args: unknown[]) => requestHeartbeatNowMock(...args),
}));

vi.mock("./bootstrap-files.js", () => ({
  makeBootstrapWarn: () => () => {},
  resolveBootstrapContextForRun: hoisted.resolveBootstrapContextForRunMock,
}));

type MockRunExit = {
  reason:
    | "manual-cancel"
    | "overall-timeout"
    | "no-output-timeout"
    | "spawn-error"
    | "signal"
    | "exit";
  exitCode: number | null;
  exitSignal: NodeJS.Signals | number | null;
  durationMs: number;
  stdout: string | (() => string);
  stderr: string;
  timedOut: boolean;
  noOutputTimedOut: boolean;
};

function createManagedRun(exit: MockRunExit, pid = 1234) {
  return {
    runId: "run-supervisor",
    pid,
    startedAtMs: Date.now(),
    stdin: undefined,
    __stdoutForStreaming: exit.stdout,
    wait: vi.fn().mockResolvedValue(exit),
    cancel: vi.fn(),
  };
}

function resolveClaudePromptFilePath(sessionFile: string): string {
  const ext = path.extname(sessionFile);
  const base = path.basename(sessionFile, ext);
  return path.join(path.dirname(sessionFile), `${base}.claude-system-prompt.txt`);
}

function listClaudePromptChunkPaths(sessionFile: string): string[] {
  const resolvedPromptFile = resolveClaudePromptFilePath(sessionFile);
  const dir = path.dirname(resolvedPromptFile);
  const base = path.basename(sessionFile, path.extname(sessionFile));
  const entries = fsSync.existsSync(dir) ? fsSync.readdirSync(dir) : [];
  const promptFiles = entries
    .filter(
      (entry) =>
        entry === `${base}.claude-system-prompt.txt` ||
        /^.+\.part\d+\.claude-system-prompt\.txt$/.test(entry),
    )
    .filter((entry) => entry.startsWith(base))
    .map((entry) => path.join(dir, entry))
    .toSorted((a, b) => {
      const aMatch = a.match(/\.part(\d+)\.claude-system-prompt\.txt$/);
      const bMatch = b.match(/\.part(\d+)\.claude-system-prompt\.txt$/);
      const aIndex = aMatch ? Number.parseInt(aMatch[1] ?? "0", 10) - 1 : 0;
      const bIndex = bMatch ? Number.parseInt(bMatch[1] ?? "0", 10) - 1 : 0;
      return aIndex - bIndex;
    });
  return promptFiles.length > 0 ? promptFiles : [resolvedPromptFile];
}

function createClaudeStreamSuccess(
  sessionFile: string,
  text = "ok",
  sessionId = "sid-1",
): () => string {
  return () => {
    const records = [JSON.stringify({ type: "system", subtype: "init", session_id: sessionId })];
    const promptPaths = listClaudePromptChunkPaths(sessionFile);
    for (const [index, promptPath] of promptPaths.entries()) {
      const toolUseId = `toolu_test_read_${index + 1}`;
      records.push(
        JSON.stringify({
          type: "assistant",
          session_id: sessionId,
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: toolUseId,
                name: "Read",
                input: { file_path: promptPath },
              },
            ],
          },
        }),
      );
      records.push(
        JSON.stringify({
          type: "user",
          session_id: sessionId,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: toolUseId,
                startLine: 1,
                numLines: 2,
                totalLines: 2,
                content: `prompt file ${index + 1}`,
              },
            ],
          },
        }),
      );
    }
    records.push(
      JSON.stringify({
        type: "assistant",
        session_id: sessionId,
        message: { role: "assistant", content: [{ type: "text", text }] },
      }),
    );
    records.push(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: text,
        session_id: sessionId,
      }),
    );
    return records.join("\n");
  };
}

describe("runCliAgent with process supervisor", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("../gateway/mcp-http.js", () => ({
      MCP_PORT_OFFSET: 1,
      ensureMcpConfigFile: (...args: unknown[]) => (ensureMcpConfigFileMock as Function)(...args),
      getActiveMcpLoopbackRuntime: () => undefined,
      createMcpLoopbackServerConfig: () => undefined,
    }));
    vi.doMock("../plugins/hook-runner-global.js", () => ({
      getGlobalHookRunner: (...args: unknown[]) => (getGlobalHookRunnerMock as Function)(...args),
    }));
    vi.doMock("../process/supervisor/index.js", () => ({
      getProcessSupervisor: () => ({
        spawn: async (...args: unknown[]) => {
          const input = args[0] as { onStdout?: (chunk: string) => void } | undefined;
          const managedRun = (await supervisorSpawnMock(...args)) as
            | {
                __stdoutForStreaming?: string | (() => string);
                wait?: () => Promise<{ stdout?: string }>;
              }
            | undefined;
          const streamingOutput =
            typeof managedRun?.__stdoutForStreaming === "function"
              ? managedRun.__stdoutForStreaming()
              : managedRun?.__stdoutForStreaming;
          if (input?.onStdout && typeof streamingOutput === "string") {
            input.onStdout(streamingOutput);
          }
          if (input?.onStdout && managedRun?.wait) {
            const originalWait = managedRun.wait.bind(managedRun);
            managedRun.wait = async () => {
              const result = await originalWait();
              if (typeof result?.stdout === "string") {
                input.onStdout?.(result.stdout);
              }
              return result;
            };
          }
          return managedRun;
        },
        cancel: vi.fn(),
        cancelScope: vi.fn(),
        cancelSession: vi.fn(() => 0),
        reconcileOrphans: vi.fn(),
        getRecord: vi.fn(),
      }),
    }));
    vi.doMock("../infra/system-events.js", () => ({
      enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
    }));
    vi.doMock("../infra/heartbeat-wake.js", () => ({
      requestHeartbeatNow: (...args: unknown[]) => requestHeartbeatNowMock(...args),
    }));
    vi.doMock("./bootstrap-files.js", () => ({
      makeBootstrapWarn: () => () => {},
      resolveBootstrapContextForRun: hoisted.resolveBootstrapContextForRunMock,
    }));
    ({ runCliAgent } = await import("./cli-runner.js"));
    ({ resolveCliNoOutputTimeoutMs } = await import("./cli-runner/helpers.js"));
    supervisorSpawnMock.mockClear();
    enqueueSystemEventMock.mockClear();
    requestHeartbeatNowMock.mockClear();
    hoisted.resolveBootstrapContextForRunMock.mockReset().mockResolvedValue({
      bootstrapFiles: [],
      contextFiles: [],
    });
    ensureMcpConfigFileMock.mockClear();
    ensureMcpConfigFileMock.mockReturnValue("/tmp/openclaw-mcp.json");
    getGlobalHookRunnerMock.mockReset();
    getGlobalHookRunnerMock.mockReturnValue(null);
    await fs.rm("/tmp/session.jsonl", { force: true }).catch(() => undefined);
    await fs
      .rm(resolveClaudePromptFilePath("/tmp/session.jsonl"), { force: true })
      .catch(() => undefined);
  });

  it("runs CLI through supervisor and returns payload", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "ok",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    const result = await runCliAgent({
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

    expect(result.payloads?.[0]?.text).toBe("ok");
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
    const input = supervisorSpawnMock.mock.calls[0]?.[0] as {
      argv?: string[];
      mode?: string;
      timeoutMs?: number;
      noOutputTimeoutMs?: number;
      replaceExistingScope?: boolean;
      scopeKey?: string;
    };
    expect(input.mode).toBe("child");
    expect(input.argv?.[0]).toBe("codex");
    expect(input.timeoutMs).toBe(1_000);
    expect(input.noOutputTimeoutMs).toBeGreaterThanOrEqual(1_000);
    expect(input.replaceExistingScope).toBe(true);
    expect(input.scopeKey).toContain("thread-123");
    expect(ensureMcpConfigFileMock).not.toHaveBeenCalled();
  });

  it("forwards Claude streaming callbacks for assistant, thinking, and tool events", async () => {
    const sessionFile = "/tmp/session.jsonl";
    const onAssistantTurn = vi.fn();
    const onThinkingTurn = vi.fn();
    const onToolUseEvent = vi.fn();
    const onToolResult = vi.fn();
    const streamOutput = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "sid-stream" }),
      JSON.stringify({
        type: "stream_event",
        session_id: "sid-stream",
        event: {
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: "Inspecting files" },
        },
      }),
      JSON.stringify({
        type: "stream_event",
        session_id: "sid-stream",
        event: {
          type: "content_block_start",
          content_block: {
            type: "tool_use",
            id: "toolu_stream",
            name: "Read",
            input: { file_path: resolveClaudePromptFilePath(sessionFile) },
          },
        },
      }),
      JSON.stringify({
        type: "user",
        session_id: "sid-stream",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_stream",
              content: "prompt file",
            },
          ],
        },
      }),
      JSON.stringify({
        type: "stream_event",
        session_id: "sid-stream",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Hello" },
        },
      }),
      JSON.stringify({
        type: "result",
        session_id: "sid-stream",
        result: "Hello",
      }),
    ].join("\n");
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: streamOutput,
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    const result = await runCliAgent({
      sessionId: "s-stream",
      sessionFile,
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "claude-cli",
      model: "opus",
      timeoutMs: 1_000,
      runId: "run-stream",
      onAssistantTurn,
      onThinkingTurn,
      onToolUseEvent,
      onToolResult,
    });

    expect(result.payloads?.[0]?.text).toBe("Hello");
    expect(onThinkingTurn).toHaveBeenCalledWith({
      text: "Inspecting files",
      delta: "Inspecting files",
    });
    expect(onToolUseEvent).toHaveBeenCalledWith({
      name: "Read",
      toolUseId: "toolu_stream",
      input: { file_path: resolveClaudePromptFilePath(sessionFile) },
    });
    expect(onToolResult).toHaveBeenCalledWith({
      toolUseId: "toolu_stream",
      text: "prompt file",
    });
    expect(onAssistantTurn).toHaveBeenCalledWith("Hello");
  });

  it("retries incomplete prompt-file reads in the same session until the full file is read", async () => {
    const sessionFile = "/tmp/session.jsonl";
    const promptFilePath = resolveClaudePromptFilePath(sessionFile);
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: [
          JSON.stringify({ type: "system", subtype: "init", session_id: "sid-rich" }),
          JSON.stringify({
            type: "stream_event",
            session_id: "sid-rich",
            event: {
              type: "content_block_start",
              content_block: {
                type: "tool_use",
                id: "toolu_rich",
                name: "Read",
                input: {},
              },
            },
          }),
          JSON.stringify({
            type: "assistant",
            session_id: "sid-rich",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "toolu_partial",
                  name: "Read",
                  input: { file_path: promptFilePath, limit: 200 },
                },
              ],
            },
          }),
          JSON.stringify({
            type: "user",
            session_id: "sid-rich",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "toolu_partial",
                  content: "prompt chunk",
                },
              ],
            },
          }),
          JSON.stringify({
            type: "result",
            session_id: "sid-rich",
            result: "ok",
          }),
        ].join("\n"),
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: [
          JSON.stringify({ type: "system", subtype: "init", session_id: "sid-rich" }),
          JSON.stringify({
            type: "assistant",
            session_id: "sid-rich",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "toolu_complete",
                  name: "Read",
                  input: { file_path: promptFilePath },
                },
              ],
            },
          }),
          JSON.stringify({
            type: "user",
            session_id: "sid-rich",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "toolu_complete",
                  startLine: 1,
                  numLines: 2,
                  totalLines: 2,
                  content: "full prompt file",
                },
              ],
            },
          }),
          JSON.stringify({
            type: "assistant",
            session_id: "sid-rich",
            message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
          }),
          JSON.stringify({
            type: "result",
            session_id: "sid-rich",
            result: "ok",
          }),
        ].join("\n"),
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    const result = await runCliAgent({
      sessionId: "s-rich",
      sessionFile,
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "claude-cli",
      model: "sonnet",
      timeoutMs: 1_000,
      runId: "run-rich",
    });

    expect(result.payloads?.[0]?.text).toBe("ok");
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(2);
    const firstInput = supervisorSpawnMock.mock.calls[0]?.[0] as { argv?: string[] };
    const secondInput = supervisorSpawnMock.mock.calls[1]?.[0] as {
      argv?: string[];
      input?: string;
    };
    expect(firstInput.argv).toContain("--session-id");
    expect(secondInput.argv).toContain("--resume");
    expect(secondInput.argv).toContain("sid-rich");
    expect(secondInput.argv).not.toContain("--session-id");
    expect(secondInput.input).toContain("continue reading the remaining files in exact order");
    expect(result.meta.agentMeta?.cliPromptLoad).toEqual(
      expect.objectContaining({
        loaderMode: "strict",
        verifiedRead: true,
      }),
    );
  });

  it("keeps retrying in the same session when a completion prompt gets no read at all", async () => {
    const sessionFile = "/tmp/session.jsonl";
    const promptFilePath = resolveClaudePromptFilePath(sessionFile);
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: [
          JSON.stringify({ type: "system", subtype: "init", session_id: "sid-sticky" }),
          JSON.stringify({
            type: "assistant",
            session_id: "sid-sticky",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "toolu_partial_again",
                  name: "Read",
                  input: { file_path: promptFilePath, limit: 200 },
                },
              ],
            },
          }),
          JSON.stringify({
            type: "user",
            session_id: "sid-sticky",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "toolu_partial_again",
                  content: "prompt chunk",
                },
              ],
            },
          }),
          JSON.stringify({ type: "result", session_id: "sid-sticky", result: "partial" }),
        ].join("\n"),
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: [
          JSON.stringify({ type: "system", subtype: "init", session_id: "sid-sticky" }),
          JSON.stringify({
            type: "assistant",
            session_id: "sid-sticky",
            message: { role: "assistant", content: [{ type: "text", text: "still thinking" }] },
          }),
          JSON.stringify({ type: "result", session_id: "sid-sticky", result: "no read" }),
        ].join("\n"),
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: [
          JSON.stringify({ type: "system", subtype: "init", session_id: "sid-sticky" }),
          JSON.stringify({
            type: "assistant",
            session_id: "sid-sticky",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "toolu_complete_again",
                  name: "Read",
                  input: { file_path: promptFilePath },
                },
              ],
            },
          }),
          JSON.stringify({
            type: "user",
            session_id: "sid-sticky",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "toolu_complete_again",
                  startLine: 1,
                  numLines: 2,
                  totalLines: 2,
                  content: "full prompt file",
                },
              ],
            },
          }),
          JSON.stringify({
            type: "assistant",
            session_id: "sid-sticky",
            message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
          }),
          JSON.stringify({ type: "result", session_id: "sid-sticky", result: "ok" }),
        ].join("\n"),
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    const result = await runCliAgent({
      sessionId: "s-sticky",
      sessionFile,
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "claude-cli",
      model: "sonnet",
      timeoutMs: 1_000,
      runId: "run-sticky",
    });

    expect(result.payloads?.[0]?.text).toBe("ok");
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(3);
    const secondInput = supervisorSpawnMock.mock.calls[1]?.[0] as {
      argv?: string[];
      input?: string;
    };
    const thirdInput = supervisorSpawnMock.mock.calls[2]?.[0] as {
      argv?: string[];
      input?: string;
    };
    expect(secondInput.argv).toContain("--resume");
    expect(secondInput.argv).toContain("sid-sticky");
    expect(secondInput.input).toContain("continue reading the remaining files in exact order");
    expect(thirdInput.argv).toContain("--resume");
    expect(thirdInput.argv).toContain("sid-sticky");
    expect(thirdInput.input).toContain("continue reading the remaining files in exact order");
  });

  it("writes prompt and assistant reply into the OpenClaw session transcript", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-runner-transcript-"));
    const sessionFile = path.join(tempDir, "session.jsonl");
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "CLI answer",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    try {
      await runCliAgent({
        sessionId: "s-transcript",
        sessionFile,
        workspaceDir: tempDir,
        prompt: "What changed today?",
        provider: "codex-cli",
        model: "gpt-5.2-codex",
        timeoutMs: 1_000,
        runId: "run-cli-transcript",
      });
      const lines = (await fs.readFile(sessionFile, "utf-8")).trim().split("\n");
      const entries = lines.map((line) => JSON.parse(line));
      const messages = entries.filter((entry) => entry.type === "message");
      expect(messages.length).toBe(2);
      const userLine = messages[0];
      const assistantLine = messages[1];
      expect(userLine.message.role).toBe("user");
      expect(userLine.message.content[0].text).toBe("What changed today?");
      expect(assistantLine.message.role).toBe("assistant");
      expect(assistantLine.message.content[0].text).toBe("CLI answer");
      expect(assistantLine.message.provider).toBe("codex-cli");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not apply skill env overrides for non-claude CLI backends", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-runner-codex-env-"));
    const skillDir = path.join(tempDir, "skills", "demo-skill");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      ["---", "name: demo-skill", "description: demo", "---", ""].join("\n"),
      "utf-8",
    );
    const envKey = "OPENCLAW_TEST_SKILL_ENV_OVERRIDE";
    const previous = process.env[envKey];
    delete process.env[envKey];

    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "ok",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    try {
      await runCliAgent({
        sessionId: "s1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: tempDir,
        config: {
          skills: {
            entries: {
              "demo-skill": {
                env: {
                  [envKey]: "should-not-be-injected-for-codex",
                },
              },
            },
          },
        } as OpenClawConfig,
        prompt: "hi",
        provider: "codex-cli",
        model: "gpt-5.2-codex",
        timeoutMs: 1_000,
        runId: "run-codex-skill-env",
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
      if (previous === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = previous;
      }
    }

    const input = supervisorSpawnMock.mock.calls[0]?.[0] as {
      env?: Record<string, string | undefined>;
    };
    expect(input.env?.[envKey]).toBeUndefined();
    expect(process.env[envKey]).toBeUndefined();
  });

  it("adds strict MCP config flags for claude-cli", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: createClaudeStreamSuccess("/tmp/session.jsonl"),
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    await runCliAgent({
      sessionId: "s1",
      sessionKey: "agent:main:main",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: {
        gateway: {
          port: 19000,
        },
      } as OpenClawConfig,
      prompt: "hi",
      provider: "claude-cli",
      model: "sonnet",
      timeoutMs: 1_000,
      runId: "run-claude-mcp",
    });

    expect(ensureMcpConfigFileMock).toHaveBeenCalledTimes(1);
    expect(ensureMcpConfigFileMock).toHaveBeenCalledWith(
      path.join(os.homedir(), ".openclaw"),
      19001,
    );
    const input = supervisorSpawnMock.mock.calls[0]?.[0] as { argv?: string[] };
    expect(input.argv).toContain("--strict-mcp-config");
    expect(input.argv).toContain("--mcp-config");
    const mcpConfigIndex = input.argv?.indexOf("--mcp-config") ?? -1;
    expect(mcpConfigIndex).toBeGreaterThanOrEqual(0);
    expect(input.argv?.[mcpConfigIndex + 1]).toBe("/tmp/openclaw-mcp.json");
  });

  it("omits strict MCP flag when claude-cli backend mcp.strict is false", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: createClaudeStreamSuccess("/tmp/session.jsonl"),
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    await runCliAgent({
      sessionId: "s1",
      sessionKey: "agent:main:main",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: {
        agents: {
          defaults: {
            cliBackends: {
              "claude-cli": {
                command: "claude",
                mcp: {
                  strict: false,
                },
              },
            },
          },
        },
      } as OpenClawConfig,
      prompt: "hi",
      provider: "claude-cli",
      model: "sonnet",
      timeoutMs: 1_000,
      runId: "run-claude-mcp-no-strict",
    });

    const input = supervisorSpawnMock.mock.calls[0]?.[0] as { argv?: string[] };
    expect(input.argv).not.toContain("--strict-mcp-config");
    expect(input.argv).toContain("--mcp-config");
  });

  it("disables MCP flags when claude-cli backend mcp.enabled is false", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: createClaudeStreamSuccess("/tmp/session.jsonl"),
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    await runCliAgent({
      sessionId: "s1",
      sessionKey: "agent:main:main",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: {
        agents: {
          defaults: {
            cliBackends: {
              "claude-cli": {
                command: "claude",
                mcp: {
                  enabled: false,
                },
              },
            },
          },
        },
      } as OpenClawConfig,
      prompt: "hi",
      provider: "claude-cli",
      model: "sonnet",
      timeoutMs: 1_000,
      runId: "run-claude-mcp-disabled",
    });

    expect(ensureMcpConfigFileMock).not.toHaveBeenCalled();
    const input = supervisorSpawnMock.mock.calls[0]?.[0] as { argv?: string[] };
    expect(input.argv).not.toContain("--mcp-config");
    expect(input.argv).not.toContain("--strict-mcp-config");
  });

  it("falls back to default MCP config when default file cannot be read", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-runner-mcp-fallback-"));
    const missingDefaultPath = path.join(tempDir, "missing-default-mcp.json");
    const extraMcpPath = path.join(tempDir, "mcp-extra.json");
    await fs.writeFile(
      extraMcpPath,
      `${JSON.stringify(
        {
          mcpServers: {
            remote: {
              type: "stdio",
              command: "node",
              args: ["remote-mcp.js"],
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    ensureMcpConfigFileMock.mockReturnValue(missingDefaultPath);

    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: createClaudeStreamSuccess("/tmp/session.jsonl"),
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    try {
      await runCliAgent({
        sessionId: "s1",
        sessionKey: "agent:main:main",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: {
          agents: {
            defaults: {
              cliBackends: {
                "claude-cli": {
                  command: "claude",
                  mcp: {
                    mergeConfigPath: extraMcpPath,
                  },
                },
              },
            },
          },
        } as OpenClawConfig,
        prompt: "hi",
        provider: "claude-cli",
        model: "sonnet",
        timeoutMs: 1_000,
        runId: "run-claude-mcp-default-read-fallback",
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    const input = supervisorSpawnMock.mock.calls[0]?.[0] as { argv?: string[] };
    const mcpConfigIndex = input.argv?.indexOf("--mcp-config") ?? -1;
    expect(mcpConfigIndex).toBeGreaterThanOrEqual(0);
    expect(input.argv?.[mcpConfigIndex + 1]).toBe(missingDefaultPath);
  });

  it("falls back to openclaw MCP servers when primary config file cannot be read", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-runner-mcp-primary-"));
    const baseMcpPath = path.join(tempDir, "mcp-base.json");
    const missingPrimaryPath = path.join(tempDir, "mcp-primary-missing.json");
    await fs.writeFile(
      baseMcpPath,
      `${JSON.stringify(
        {
          mcpServers: {
            openclaw: {
              type: "http",
              url: "http://127.0.0.1:19001/mcp",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    ensureMcpConfigFileMock.mockReturnValue(baseMcpPath);

    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: createClaudeStreamSuccess("/tmp/session.jsonl"),
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    try {
      await runCliAgent({
        sessionId: "s1",
        sessionKey: "agent:main:main",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: {
          agents: {
            defaults: {
              cliBackends: {
                "claude-cli": {
                  command: "claude",
                  mcp: {
                    configPath: missingPrimaryPath,
                  },
                },
              },
            },
          },
        } as OpenClawConfig,
        prompt: "hi",
        provider: "claude-cli",
        model: "sonnet",
        timeoutMs: 1_000,
        runId: "run-claude-mcp-primary-read-fallback",
      });

      const input = supervisorSpawnMock.mock.calls[0]?.[0] as { argv?: string[] };
      const mcpConfigIndex = input.argv?.indexOf("--mcp-config") ?? -1;
      expect(mcpConfigIndex).toBeGreaterThanOrEqual(0);
      const mergedPath = input.argv?.[mcpConfigIndex + 1];
      expect(mergedPath).not.toBe(missingPrimaryPath);
      const mergedRaw = await fs.readFile(String(mergedPath), "utf-8");
      const merged = JSON.parse(mergedRaw) as { mcpServers?: Record<string, unknown> };
      expect(merged.mcpServers?.openclaw).toBeTruthy();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("merges configured MCP servers into claude-cli MCP config", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-runner-mcp-merge-"));
    const baseMcpPath = path.join(tempDir, "mcp-base.json");
    const extraMcpPath = path.join(tempDir, "mcp-extra.json");
    await fs.writeFile(
      baseMcpPath,
      `${JSON.stringify(
        {
          mcpServers: {
            openclaw: {
              type: "http",
              url: "http://127.0.0.1:19001/mcp",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    await fs.writeFile(
      extraMcpPath,
      `${JSON.stringify(
        {
          mcpServers: {
            remote: {
              type: "stdio",
              command: "node",
              args: ["remote-mcp.js"],
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    ensureMcpConfigFileMock.mockReturnValue(baseMcpPath);

    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: createClaudeStreamSuccess("/tmp/session.jsonl"),
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    try {
      await runCliAgent({
        sessionId: "s1",
        sessionKey: "agent:main:main",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: {
          agents: {
            defaults: {
              cliBackends: {
                "claude-cli": {
                  command: "claude",
                  mcp: {
                    mergeConfigPath: extraMcpPath,
                  },
                },
              },
            },
          },
        } as OpenClawConfig,
        prompt: "hi",
        provider: "claude-cli",
        model: "sonnet",
        timeoutMs: 1_000,
        runId: "run-claude-mcp-merged",
      });

      const input = supervisorSpawnMock.mock.calls[0]?.[0] as { argv?: string[] };
      const mcpConfigIndex = input.argv?.indexOf("--mcp-config") ?? -1;
      expect(mcpConfigIndex).toBeGreaterThanOrEqual(0);
      const mergedPath = input.argv?.[mcpConfigIndex + 1];
      expect(typeof mergedPath).toBe("string");
      const mergedRaw = await fs.readFile(String(mergedPath), "utf-8");
      const merged = JSON.parse(mergedRaw) as { mcpServers?: Record<string, unknown> };
      expect(merged.mcpServers?.openclaw).toBeTruthy();
      expect(merged.mcpServers?.remote).toBeTruthy();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("cleans up stale merged MCP config files while keeping recent snapshots", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-runner-mcp-prune-"));
    const baseMcpPath = path.join(tempDir, "mcp-base.json");
    const extraMcpPath = path.join(tempDir, "mcp-extra.json");
    await fs.writeFile(
      baseMcpPath,
      `${JSON.stringify(
        {
          mcpServers: {
            openclaw: {
              type: "http",
              url: "http://127.0.0.1:19001/mcp",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    await fs.writeFile(
      extraMcpPath,
      `${JSON.stringify(
        {
          mcpServers: {
            remote: {
              type: "stdio",
              command: "node",
              args: ["remote-mcp.js"],
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    const oldTime = Date.now() - 2 * 60 * 60 * 1000;
    for (let index = 0; index < 30; index += 1) {
      const hash = index.toString(16).padStart(16, "0");
      const filePath = path.join(tempDir, `mcp.cli-merged.${hash}.json`);
      await fs.writeFile(filePath, '{"mcpServers":{}}\n', "utf-8");
      const oldDate = new Date(oldTime);
      await fs.utimes(filePath, oldDate, oldDate);
    }
    ensureMcpConfigFileMock.mockReturnValue(baseMcpPath);

    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: createClaudeStreamSuccess("/tmp/session.jsonl"),
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    try {
      await runCliAgent({
        sessionId: "s1",
        sessionKey: "agent:main:main",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: {
          agents: {
            defaults: {
              cliBackends: {
                "claude-cli": {
                  command: "claude",
                  mcp: {
                    mergeConfigPath: extraMcpPath,
                  },
                },
              },
            },
          },
        } as OpenClawConfig,
        prompt: "hi",
        provider: "claude-cli",
        model: "sonnet",
        timeoutMs: 1_000,
        runId: "run-claude-mcp-merged-prune",
      });

      const files = await fs.readdir(tempDir);
      const mergedFiles = files.filter((file) =>
        /^mcp\.cli-merged\.[a-f0-9]{16}\.json$/.test(file),
      );
      expect(mergedFiles.length).toBeLessThanOrEqual(20);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("injects workspace skills into claude system prompt", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-runner-skills-"));
    const skillDir = path.join(tempDir, "skills", "demo-skill");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: demo-skill",
        "description: Demo skill for CLI prompt injection",
        "---",
        "",
        "Run demo steps from {baseDir}.",
      ].join("\n"),
      "utf-8",
    );

    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: createClaudeStreamSuccess("/tmp/session.jsonl"),
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    try {
      await runCliAgent({
        sessionId: "s1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: tempDir,
        prompt: "hi",
        provider: "claude-cli",
        model: "sonnet",
        timeoutMs: 1_000,
        runId: "run-claude-plugin-dir",
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    const input = supervisorSpawnMock.mock.calls[0]?.[0] as { argv?: string[] };
    expect(input.argv).toContain("--append-system-prompt");
    const systemPromptIndex = input.argv?.indexOf("--append-system-prompt") ?? -1;
    expect(systemPromptIndex).toBeGreaterThanOrEqual(0);
    const systemPrompt = input.argv?.[systemPromptIndex + 1] ?? "";
    expect(systemPrompt).toContain("Read tool");
    const promptFile = resolveClaudePromptFilePath("/tmp/session.jsonl");
    expect(systemPrompt).toContain(promptFile);
    const fileContents = await fs.readFile(promptFile, "utf-8");
    expect(fileContents).toContain("keep a short plan updated with `update_plan`.");
    expect(fileContents).toContain("<available_skills>");
    expect(fileContents).toContain("demo-skill");
  });

  it("uses provided skillsSnapshot prompt for claude runs", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-runner-noskills-"));

    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: createClaudeStreamSuccess("/tmp/session.jsonl"),
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    try {
      await runCliAgent({
        sessionId: "s1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: tempDir,
        prompt: "hi",
        provider: "claude-cli",
        model: "sonnet",
        timeoutMs: 1_000,
        runId: "run-claude-no-plugin-dir",
        skillsSnapshot: {
          prompt:
            "<available_skills><skill><name>snapshot-skill</name><description>from snapshot</description><location>/tmp/snapshot-skill/SKILL.md</location></skill></available_skills>",
          skills: [{ name: "snapshot-skill" }],
        },
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    const input = supervisorSpawnMock.mock.calls[0]?.[0] as { argv?: string[] };
    expect(input.argv).toContain("--append-system-prompt");
    const systemPromptIndex = input.argv?.indexOf("--append-system-prompt") ?? -1;
    expect(systemPromptIndex).toBeGreaterThanOrEqual(0);
    const promptFile = resolveClaudePromptFilePath("/tmp/session.jsonl");
    expect(input.argv?.[systemPromptIndex + 1]).toContain(promptFile);
    const fileContents = await fs.readFile(promptFile, "utf-8");
    expect(fileContents).toContain("keep a short plan updated with `update_plan`.");
    expect(fileContents).toContain("snapshot-skill");
  });

  it("applies before_prompt_build hooks in CLI mode", async () => {
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "before_prompt_build"),
      runBeforePromptBuild: vi.fn(async () => ({
        prependContext: "HOOK_CONTEXT",
        systemPrompt: "HOOK_SYSTEM",
      })),
      runBeforeAgentStart: vi.fn(async () => undefined),
      runLlmOutput: vi.fn(async () => undefined),
    };
    getGlobalHookRunnerMock.mockReturnValue(hookRunner as never);

    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: createClaudeStreamSuccess("/tmp/session.jsonl"),
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    await runCliAgent({
      sessionId: "s1",
      sessionKey: "agent:main:main",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "claude-cli",
      model: "sonnet",
      timeoutMs: 1_000,
      runId: "run-cli-hook-before-prompt-build",
      trigger: "user",
      messageChannel: "whatsapp",
    });

    const input = supervisorSpawnMock.mock.calls[0]?.[0] as { argv?: string[] };
    expect(input.argv).toContain("HOOK_CONTEXT\n\nhi");
    const systemPromptIndex = input.argv?.indexOf("--append-system-prompt") ?? -1;
    expect(systemPromptIndex).toBeGreaterThanOrEqual(0);
    const promptFile = resolveClaudePromptFilePath("/tmp/session.jsonl");
    expect(input.argv?.[systemPromptIndex + 1]).toContain(promptFile);
    const fileContents = await fs.readFile(promptFile, "utf-8");
    expect(fileContents).toBe("HOOK_SYSTEM\n");
    expect(hookRunner.runBeforePromptBuild).toHaveBeenCalledWith(
      {
        prompt: "hi",
        messages: [],
      },
      expect.objectContaining({
        sessionId: "s1",
        sessionKey: "agent:main:main",
        workspaceDir: "/tmp",
        trigger: "user",
        messageProvider: "whatsapp",
        channelId: "whatsapp",
      }),
    );
  });

  it("passes transcript messages to before_prompt_build hooks in CLI mode", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-hook-messages-"));
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({ type: "meta", foo: "bar" }),
        JSON.stringify({ type: "tool", message: { role: "tool", content: "should-ignore" } }),
        JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }),
        JSON.stringify({ type: "message", message: { role: "assistant", content: "world" } }),
        "not-json",
        "",
      ].join("\n"),
      "utf-8",
    );

    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "before_prompt_build"),
      runBeforePromptBuild: vi.fn(async () => undefined),
      runBeforeAgentStart: vi.fn(async () => undefined),
      runLlmOutput: vi.fn(async () => undefined),
    };
    getGlobalHookRunnerMock.mockReturnValue(hookRunner as never);

    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: createClaudeStreamSuccess(sessionFile),
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    try {
      await runCliAgent({
        sessionId: "s1",
        sessionFile,
        workspaceDir: tempDir,
        prompt: "hi",
        provider: "claude-cli",
        model: "sonnet",
        timeoutMs: 1_000,
        runId: "run-cli-hook-message-history",
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    expect(hookRunner.runBeforePromptBuild).toHaveBeenCalledWith(
      {
        prompt: "hi",
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "world" },
        ],
      },
      expect.any(Object),
    );
  });

  it("emits llm_output hooks in CLI mode", async () => {
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "llm_output"),
      runBeforePromptBuild: vi.fn(async () => undefined),
      runBeforeAgentStart: vi.fn(async () => undefined),
      runLlmOutput: vi.fn(async () => undefined),
    };
    getGlobalHookRunnerMock.mockReturnValue(hookRunner as never);

    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "ok",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    await runCliAgent({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "codex-cli",
      model: "gpt-5.2-codex",
      timeoutMs: 1_000,
      runId: "run-cli-hook-llm-output",
      trigger: "user",
      messageChannel: "telegram",
    });

    expect(hookRunner.runLlmOutput).toHaveBeenCalledTimes(1);
    expect(hookRunner.runLlmOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-cli-hook-llm-output",
        sessionId: "s1",
        provider: "codex-cli",
        model: "gpt-5.2-codex",
        assistantTexts: ["ok"],
      }),
      expect.objectContaining({
        sessionId: "s1",
        workspaceDir: "/tmp",
        messageProvider: "telegram",
        channelId: "telegram",
      }),
    );
  });

  it("reports normalized model id in llm_output hooks", async () => {
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "llm_output"),
      runBeforePromptBuild: vi.fn(async () => undefined),
      runBeforeAgentStart: vi.fn(async () => undefined),
      runLlmOutput: vi.fn(async () => undefined),
    };
    getGlobalHookRunnerMock.mockReturnValue(hookRunner as never);

    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: createClaudeStreamSuccess("/tmp/session.jsonl"),
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    await runCliAgent({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "claude-cli",
      model: "claude-sonnet-4-6",
      timeoutMs: 1_000,
      runId: "run-cli-hook-normalized-model",
    });

    expect(hookRunner.runLlmOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "sonnet",
      }),
      expect.any(Object),
    );
  });

  it("reloads the session prompt file on resumed claude sessions when binding metadata is missing", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-runner-resume-"));
    const skillDir = path.join(tempDir, "skills", "resume-skill");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: resume-skill",
        "description: Resume-skill description",
        "---",
        "",
        "Use this skill after resume.",
      ].join("\n"),
      "utf-8",
    );

    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: createClaudeStreamSuccess("/tmp/session.jsonl", "ok", "existing-claude-session"),
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    try {
      await runCliAgent({
        sessionId: "s1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: tempDir,
        prompt: "hi",
        provider: "claude-cli",
        model: "sonnet",
        timeoutMs: 1_000,
        runId: "run-claude-resume-plugin-dir",
        cliSessionId: "existing-claude-session",
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    const input = supervisorSpawnMock.mock.calls[0]?.[0] as { argv?: string[] };
    expect(input.argv).toContain("--resume");
    expect(input.argv).toContain("existing-claude-session");
    expect(input.argv).toContain("--append-system-prompt");
    const systemPromptIndex = input.argv?.indexOf("--append-system-prompt") ?? -1;
    expect(systemPromptIndex).toBeGreaterThanOrEqual(0);
    const systemPrompt = input.argv?.[systemPromptIndex + 1] ?? "";
    expect(systemPrompt).toContain("Read tool");
    const promptFile = resolveClaudePromptFilePath("/tmp/session.jsonl");
    expect(systemPrompt).toContain(promptFile);
    const fileContents = await fs.readFile(promptFile, "utf-8");
    expect(fileContents).toContain("resume-skill");
  });

  it("skips loader prompt on resumed claude sessions when binding metadata is current", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-runner-resume-first-"));
    const sessionFile = "/tmp/session.jsonl";
    const skillDir = path.join(tempDir, "skills", "resume-skill-first");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: resume-skill-first",
        "description: Resume-skill description for first mode",
        "---",
        "",
        "Use this skill only on first run.",
      ].join("\n"),
      "utf-8",
    );

    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: createClaudeStreamSuccess(sessionFile, "ok", "existing-claude-session"),
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: createClaudeStreamSuccess(sessionFile, "ok", "existing-claude-session"),
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    let binding:
      | {
          sessionId: string;
          systemPromptFile?: string;
          systemPromptHash?: string;
          systemPromptCompactionCount?: number;
        }
      | undefined;
    let resumedPromptLoad:
      | {
          sessionPromptFile?: string;
          loaderMode: "normal" | "strict" | "disabled";
          verifiedRead: boolean;
          fallbackReason?:
            | "write_failed"
            | "verification_retry"
            | "direct_injection_fallback"
            | "direct_fallback_disabled";
        }
      | undefined;

    try {
      const firstResult = await runCliAgent({
        sessionId: "s1",
        sessionFile,
        workspaceDir: tempDir,
        prompt: "hi",
        provider: "claude-cli",
        model: "sonnet",
        timeoutMs: 1_000,
        runId: "run-claude-resume-first-seed",
      });
      binding = firstResult.meta.agentMeta?.cliSessionBinding;
      const resumedResult = await runCliAgent({
        sessionId: "s1",
        sessionFile,
        workspaceDir: tempDir,
        prompt: "hi",
        provider: "claude-cli",
        model: "sonnet",
        timeoutMs: 1_000,
        runId: "run-claude-resume-first",
        cliSessionId: "existing-claude-session",
        cliSessionBinding: binding,
      });
      resumedPromptLoad = resumedResult.meta.agentMeta?.cliPromptLoad;
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    expect(binding?.sessionId).toBe("existing-claude-session");
    const input = supervisorSpawnMock.mock.calls[1]?.[0] as { argv?: string[] };
    expect(input.argv).toContain("--resume");
    expect(input.argv).toContain("existing-claude-session");
    expect(input.argv).not.toContain("--append-system-prompt");
    expect(resumedPromptLoad).toMatchObject({
      loaderMode: "normal",
      verifiedRead: true,
    });
  });

  it("reloads the session prompt file on resume after compaction count increases", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-runner-resume-compact-"));

    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: createClaudeStreamSuccess("/tmp/session.jsonl", "ok", "existing-claude-session"),
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: createClaudeStreamSuccess("/tmp/session.jsonl", "ok", "existing-claude-session"),
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    let binding:
      | {
          sessionId: string;
          systemPromptFile?: string;
          systemPromptHash?: string;
          systemPromptCompactionCount?: number;
        }
      | undefined;
    try {
      const firstResult = await runCliAgent({
        sessionId: "s1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: tempDir,
        prompt: "hi",
        provider: "claude-cli",
        model: "sonnet",
        timeoutMs: 1_000,
        runId: "run-claude-resume-compact-seed",
      });
      binding = firstResult.meta.agentMeta?.cliSessionBinding;

      await runCliAgent({
        sessionId: "s1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: tempDir,
        prompt: "hi again",
        provider: "claude-cli",
        model: "sonnet",
        timeoutMs: 1_000,
        runId: "run-claude-resume-compact",
        cliSessionId: "existing-claude-session",
        cliSessionBinding: binding,
        sessionCompactionCount: 1,
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    const input = supervisorSpawnMock.mock.calls[1]?.[0] as { argv?: string[] };
    expect(input.argv).toContain("--resume");
    expect(input.argv).toContain("--append-system-prompt");
    const systemPromptIndex = input.argv?.indexOf("--append-system-prompt") ?? -1;
    expect(input.argv?.[systemPromptIndex + 1]).toContain("compacted or summarized");
  });

  it("prepends bootstrap warnings to the CLI prompt body", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "ok",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );
    hoisted.resolveBootstrapContextForRunMock.mockResolvedValueOnce({
      bootstrapFiles: [
        {
          name: "AGENTS.md",
          path: "/tmp/AGENTS.md",
          content: "A".repeat(200),
          missing: false,
        },
      ],
      contextFiles: [{ path: "AGENTS.md", content: "A".repeat(20) }],
    });

    await runCliAgent({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: {
        agents: {
          defaults: {
            bootstrapMaxChars: 50,
            bootstrapTotalMaxChars: 50,
          },
        },
      } satisfies OpenClawConfig,
      prompt: "hi",
      provider: "codex-cli",
      model: "gpt-5.2-codex",
      timeoutMs: 1_000,
      runId: "run-warning",
      cliSessionId: "thread-123",
    });

    const input = supervisorSpawnMock.mock.calls[0]?.[0] as {
      argv?: string[];
      input?: string;
    };
    const promptCarrier = [input.input ?? "", ...(input.argv ?? [])].join("\n");

    expect(promptCarrier).toContain("[Bootstrap truncation warning]");
    expect(promptCarrier).toContain("- AGENTS.md: 200 raw -> 20 injected");
    expect(promptCarrier).toContain("hi");
  });

  it("fails with timeout when no-output watchdog trips", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "no-output-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 200,
        stdout: "",
        stderr: "",
        timedOut: true,
        noOutputTimedOut: true,
      }),
    );

    await expect(
      runCliAgent({
        sessionId: "s1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        prompt: "hi",
        provider: "codex-cli",
        model: "gpt-5.2-codex",
        timeoutMs: 1_000,
        runId: "run-2",
        cliSessionId: "thread-123",
      }),
    ).rejects.toThrow("produced no output");
  });

  it("enqueues a system event and heartbeat wake on no-output watchdog timeout for session runs", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "no-output-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 200,
        stdout: "",
        stderr: "",
        timedOut: true,
        noOutputTimedOut: true,
      }),
    );

    await expect(
      runCliAgent({
        sessionId: "s1",
        sessionKey: "agent:main:main",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        prompt: "hi",
        provider: "codex-cli",
        model: "gpt-5.2-codex",
        timeoutMs: 1_000,
        runId: "run-2b",
        cliSessionId: "thread-123",
      }),
    ).rejects.toThrow("produced no output");

    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const [notice, opts] = enqueueSystemEventMock.mock.calls[0] ?? [];
    expect(String(notice)).toContain("produced no output");
    expect(String(notice)).toContain("interactive input or an approval prompt");
    expect(opts).toMatchObject({ sessionKey: "agent:main:main" });
    expect(requestHeartbeatNowMock).toHaveBeenCalledWith({
      reason: "cli:watchdog:stall",
      sessionKey: "agent:main:main",
    });
  });

  it("fails with timeout when overall timeout trips", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "overall-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 200,
        stdout: "",
        stderr: "",
        timedOut: true,
        noOutputTimedOut: false,
      }),
    );

    await expect(
      runCliAgent({
        sessionId: "s1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        prompt: "hi",
        provider: "codex-cli",
        model: "gpt-5.2-codex",
        timeoutMs: 1_000,
        runId: "run-3",
        cliSessionId: "thread-123",
      }),
    ).rejects.toThrow("exceeded timeout");
  });

  it("rethrows the retry failure when session-expired recovery retry also fails", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 1,
        exitSignal: null,
        durationMs: 150,
        stdout: "",
        stderr: "session expired",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 1,
        exitSignal: null,
        durationMs: 150,
        stdout: "",
        stderr: "rate limit exceeded",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    await expect(
      runCliAgent({
        sessionId: "s1",
        sessionKey: "agent:main:subagent:retry",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        prompt: "hi",
        provider: "codex-cli",
        model: "gpt-5.2-codex",
        timeoutMs: 1_000,
        runId: "run-retry-failure",
        cliSessionId: "thread-123",
      }),
    ).rejects.toThrow("rate limit exceeded");

    expect(supervisorSpawnMock).toHaveBeenCalledTimes(2);
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

    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 25,
        stdout: "ok",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

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
        runId: "run-4",
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    const input = supervisorSpawnMock.mock.calls[0]?.[0] as { cwd?: string };
    expect(input.cwd).toBe(path.resolve(fallbackWorkspace));
  });

  it("cancels running CLI process on abort signal", async () => {
    const managedRun = createManagedRun({
      reason: "manual-cancel",
      exitCode: null,
      exitSignal: "SIGTERM",
      durationMs: 25,
      stdout: "",
      stderr: "",
      timedOut: false,
      noOutputTimedOut: false,
    });
    managedRun.wait = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        reason: "manual-cancel",
        exitCode: null,
        exitSignal: "SIGTERM",
        durationMs: 25,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      };
    });
    supervisorSpawnMock.mockResolvedValueOnce(managedRun);
    const abortController = new AbortController();
    const runPromise = runCliAgent({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "codex-cli",
      model: "gpt-5.2-codex",
      timeoutMs: 1_000,
      runId: "run-abort",
      abortSignal: abortController.signal,
    });

    await vi.waitFor(() => expect(supervisorSpawnMock).toHaveBeenCalledTimes(1));
    abortController.abort("stop");
    await expect(runPromise).rejects.toMatchObject({ name: "FailoverError" });
    expect(managedRun.cancel).toHaveBeenCalledWith("manual-cancel");
  });

  it("treats supervisor-driven manual session cancels as aborts", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "manual-cancel",
        exitCode: null,
        exitSignal: "SIGTERM",
        durationMs: 25,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    await expect(
      runCliAgent({
        sessionId: "s1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        prompt: "hi",
        provider: "codex-cli",
        model: "gpt-5.2-codex",
        timeoutMs: 1_000,
        runId: "run-session-cancel",
      }),
    ).rejects.toMatchObject({ name: "FailoverError" });
  });
});

describe("resolveCliNoOutputTimeoutMs", () => {
  it("uses backend-configured resume watchdog override", () => {
    const timeoutMs = resolveCliNoOutputTimeoutMs({
      backend: {
        command: "codex",
        reliability: {
          watchdog: {
            resume: {
              noOutputTimeoutMs: 42_000,
            },
          },
        },
      },
      timeoutMs: 120_000,
      useResume: true,
    });
    expect(timeoutMs).toBe(42_000);
  });
});
