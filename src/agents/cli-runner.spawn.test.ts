import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { onAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import {
  makeBootstrapWarn as realMakeBootstrapWarn,
  resolveBootstrapContextForRun as realResolveBootstrapContextForRun,
} from "./bootstrap-files.js";
import {
  createManagedRun,
  mockSuccessfulCliRun,
  restoreCliRunnerPrepareTestDeps,
  supervisorSpawnMock,
} from "./cli-runner.test-support.js";
import { executePreparedCliRun } from "./cli-runner/execute.js";
import { buildSystemPrompt } from "./cli-runner/helpers.js";
import { setCliRunnerPrepareTestDeps } from "./cli-runner/prepare.js";
import type { PreparedCliRunContext } from "./cli-runner/types.js";

beforeEach(() => {
  resetAgentEventsForTest();
  restoreCliRunnerPrepareTestDeps();
  supervisorSpawnMock.mockClear();
});

function buildPreparedCliRunContext(params: {
  provider: "claude-cli" | "codex-cli";
  model: string;
  runId: string;
  prompt?: string;
  backend?: Partial<PreparedCliRunContext["preparedBackend"]["backend"]>;
}): PreparedCliRunContext {
  const baseBackend =
    params.provider === "claude-cli"
      ? {
          command: "claude",
          args: ["-p", "--output-format", "stream-json"],
          output: "jsonl" as const,
          input: "stdin" as const,
          modelArg: "--model",
          systemPromptArg: "--append-system-prompt",
          systemPromptWhen: "first" as const,
          serialize: true,
        }
      : {
          command: "codex",
          args: ["exec", "--json"],
          resumeArgs: ["exec", "resume", "{sessionId}", "--json"],
          output: "text" as const,
          input: "arg" as const,
          modelArg: "--model",
          sessionMode: "existing" as const,
          systemPromptFileConfigArg: "-c",
          systemPromptFileConfigKey: "model_instructions_file",
          systemPromptWhen: "first" as const,
          serialize: true,
        };
  const backend = { ...baseBackend, ...params.backend };
  return {
    params: {
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: params.prompt ?? "hi",
      provider: params.provider,
      model: params.model,
      timeoutMs: 1_000,
      runId: params.runId,
    },
    started: Date.now(),
    workspaceDir: "/tmp",
    backendResolved: {
      id: params.provider,
      config: backend,
      bundleMcp: params.provider === "claude-cli",
      pluginId: params.provider === "claude-cli" ? "anthropic" : "openai",
    },
    preparedBackend: {
      backend,
      env: {},
    },
    reusableCliSession: {},
    modelId: params.model,
    normalizedModel: params.model,
    systemPrompt: "You are a helpful assistant.",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    bootstrapPromptWarningLines: [],
  };
}

describe("runCliAgent spawn path", () => {
  it("does not inject hardcoded 'Tools are disabled' text into CLI arguments", async () => {
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

    const backendConfig = {
      command: "claude",
      args: ["-p", "--output-format", "stream-json"],
      output: "jsonl" as const,
      input: "stdin" as const,
      modelArg: "--model",
      systemPromptArg: "--append-system-prompt",
      systemPromptWhen: "first" as const,
      serialize: true,
    };
    const context: PreparedCliRunContext = {
      params: {
        sessionId: "s1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        prompt: "Run: node script.mjs",
        provider: "claude-cli",
        model: "sonnet",
        timeoutMs: 1_000,
        runId: "run-no-tools-disabled",
        extraSystemPrompt: "You are a helpful assistant.",
      },
      started: Date.now(),
      workspaceDir: "/tmp",
      backendResolved: {
        id: "claude-cli",
        config: backendConfig,
        bundleMcp: true,
        pluginId: "anthropic",
      },
      preparedBackend: {
        backend: backendConfig,
        env: {},
      },
      reusableCliSession: {},
      modelId: "sonnet",
      normalizedModel: "sonnet",
      systemPrompt: "You are a helpful assistant.",
      systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
      bootstrapPromptWarningLines: [],
    };
    await executePreparedCliRun(context);

    const input = supervisorSpawnMock.mock.calls[0]?.[0] as { argv?: string[] };
    const allArgs = (input.argv ?? []).join("\n");
    expect(allArgs).not.toContain("Tools are disabled in this session");
    expect(allArgs).toContain("You are a helpful assistant.");
  });

  it("pipes Claude prompts over stdin instead of argv", async () => {
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

    await executePreparedCliRun(
      buildPreparedCliRunContext({
        provider: "claude-cli",
        model: "sonnet",
        runId: "run-stdin-claude",
        prompt: "Explain this diff",
      }),
    );

    const input = supervisorSpawnMock.mock.calls[0]?.[0] as {
      argv?: string[];
      input?: string;
    };
    expect(input.input).toContain("Explain this diff");
    expect(input.argv).not.toContain("Explain this diff");
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

    const context = buildPreparedCliRunContext({
      provider: "codex-cli",
      model: "gpt-5.4",
      runId: "run-1",
    });
    context.reusableCliSession = { sessionId: "thread-123" };

    const result = await executePreparedCliRun(context, "thread-123");

    expect(result.text).toBe("ok");
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
  });

  it("passes Codex system prompts through model_instructions_file", async () => {
    let promptFileText = "";
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { argv?: string[] };
      const configArgIndex = input.argv?.indexOf("-c") ?? -1;
      expect(configArgIndex).toBeGreaterThanOrEqual(0);
      const configArg = input.argv?.[configArgIndex + 1] ?? "";
      const match = /^model_instructions_file="(.+)"$/.exec(configArg);
      expect(match?.[1]).toBeTruthy();
      promptFileText = await fs.readFile(match?.[1] ?? "", "utf-8");
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "ok",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    await executePreparedCliRun(
      buildPreparedCliRunContext({
        provider: "codex-cli",
        model: "gpt-5.4",
        runId: "run-codex-system-prompt-file",
      }),
    );

    expect(promptFileText).toBe("You are a helpful assistant.");
  });

  it("cancels the managed CLI run when the abort signal fires", async () => {
    const abortController = new AbortController();
    let resolveWait!: (value: {
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
      stdout: string;
      stderr: string;
      timedOut: boolean;
      noOutputTimedOut: boolean;
    }) => void;
    const cancel = vi.fn((reason?: string) => {
      resolveWait({
        reason: reason === "manual-cancel" ? "manual-cancel" : "signal",
        exitCode: null,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });
    supervisorSpawnMock.mockResolvedValueOnce({
      runId: "run-supervisor",
      pid: 1234,
      startedAtMs: Date.now(),
      stdin: undefined,
      wait: vi.fn(
        async () =>
          await new Promise((resolve) => {
            resolveWait = resolve;
          }),
      ),
      cancel,
    });

    const context = buildPreparedCliRunContext({
      provider: "codex-cli",
      model: "gpt-5.4",
      runId: "run-abort",
    });
    context.params.abortSignal = abortController.signal;

    const runPromise = executePreparedCliRun(context);

    await vi.waitFor(() => {
      expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
    });
    abortController.abort();

    await expect(runPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledWith("manual-cancel");
  });

  it("streams Claude text deltas from stream-json stdout", async () => {
    const agentEvents: Array<{ stream: string; text?: string; delta?: string }> = [];
    const stop = onAgentEvent((evt) => {
      agentEvents.push({
        stream: evt.stream,
        text: typeof evt.data.text === "string" ? evt.data.text : undefined,
        delta: typeof evt.data.delta === "string" ? evt.data.delta : undefined,
      });
    });
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      input.onStdout?.(
        [
          JSON.stringify({ type: "init", session_id: "session-123" }),
          JSON.stringify({
            type: "stream_event",
            event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
          }),
        ].join("\n") + "\n",
      );
      input.onStdout?.(
        JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: " world" } },
        }) + "\n",
      );
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: [
          JSON.stringify({ type: "init", session_id: "session-123" }),
          JSON.stringify({
            type: "stream_event",
            event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
          }),
          JSON.stringify({
            type: "stream_event",
            event: { type: "content_block_delta", delta: { type: "text_delta", text: " world" } },
          }),
          JSON.stringify({
            type: "result",
            session_id: "session-123",
            result: "Hello world",
          }),
        ].join("\n"),
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    try {
      const result = await executePreparedCliRun(
        buildPreparedCliRunContext({
          provider: "claude-cli",
          model: "sonnet",
          runId: "run-claude-stream-json",
        }),
      );

      expect(result.text).toBe("Hello world");
      expect(agentEvents).toEqual([
        { stream: "assistant", text: "Hello", delta: "Hello" },
        { stream: "assistant", text: "Hello world", delta: " world" },
      ]);
    } finally {
      stop();
    }
  });

  it("surfaces nested Claude stream-json API errors instead of raw event output", async () => {
    const message =
      "Third-party apps now draw from your extra usage, not your plan limits. We've added a $200 credit to get you started. Claim it at claude.ai/settings/usage and keep going.";
    const apiError = `API Error: 400 ${JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message,
      },
      request_id: "req_011CZqHuXhFetYCnr8325DQc",
    })}`;

    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 1,
        exitSignal: null,
        durationMs: 50,
        stdout: [
          JSON.stringify({ type: "system", subtype: "init", session_id: "session-api-error" }),
          JSON.stringify({
            type: "assistant",
            message: {
              model: "<synthetic>",
              role: "assistant",
              content: [{ type: "text", text: apiError }],
            },
            session_id: "session-api-error",
            error: "unknown",
          }),
          JSON.stringify({
            type: "result",
            subtype: "success",
            is_error: true,
            result: apiError,
            session_id: "session-api-error",
          }),
        ].join("\n"),
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    const run = executePreparedCliRun(
      buildPreparedCliRunContext({
        provider: "claude-cli",
        model: "sonnet",
        runId: "run-claude-api-error",
      }),
    );

    await expect(run).rejects.toMatchObject({
      name: "FailoverError",
      message,
      reason: "billing",
      status: 402,
    });
  });

  it("sanitizes dangerous backend env overrides before spawn", async () => {
    mockSuccessfulCliRun();
    await executePreparedCliRun(
      buildPreparedCliRunContext({
        provider: "codex-cli",
        model: "gpt-5.4",
        runId: "run-env-sanitized",
        backend: {
          env: {
            NODE_OPTIONS: "--require ./malicious.js",
            LD_PRELOAD: "/tmp/pwn.so",
            PATH: "/tmp/evil",
            HOME: "/tmp/evil-home",
            SAFE_KEY: "ok",
          },
        },
      }),
      "thread-123",
    );

    const input = supervisorSpawnMock.mock.calls[0]?.[0] as {
      env?: Record<string, string | undefined>;
    };
    expect(input.env?.SAFE_KEY).toBe("ok");
    expect(input.env?.PATH).toBe(process.env.PATH);
    expect(input.env?.HOME).toBe(process.env.HOME);
    expect(input.env?.NODE_OPTIONS).toBeUndefined();
    expect(input.env?.LD_PRELOAD).toBeUndefined();
  });

  it("applies clearEnv after sanitizing backend env overrides", async () => {
    process.env.SAFE_CLEAR = "from-base";
    mockSuccessfulCliRun();
    await executePreparedCliRun(
      buildPreparedCliRunContext({
        provider: "codex-cli",
        model: "gpt-5.4",
        runId: "run-clear-env",
        backend: {
          env: {
            SAFE_KEEP: "keep-me",
          },
          clearEnv: ["SAFE_CLEAR"],
        },
      }),
      "thread-123",
    );

    const input = supervisorSpawnMock.mock.calls[0]?.[0] as {
      env?: Record<string, string | undefined>;
    };
    expect(input.env?.SAFE_KEEP).toBe("keep-me");
    expect(input.env?.SAFE_CLEAR).toBeUndefined();
  });

  it("keeps explicit backend env overrides even when clearEnv drops inherited values", async () => {
    process.env.SAFE_OVERRIDE = "from-base";
    mockSuccessfulCliRun();
    await executePreparedCliRun(
      buildPreparedCliRunContext({
        provider: "codex-cli",
        model: "gpt-5.4",
        runId: "run-clear-env-override",
        backend: {
          env: {
            SAFE_OVERRIDE: "from-override",
          },
          clearEnv: ["SAFE_OVERRIDE"],
        },
      }),
      "thread-123",
    );

    const input = supervisorSpawnMock.mock.calls[0]?.[0] as {
      env?: Record<string, string | undefined>;
    };
    expect(input.env?.SAFE_OVERRIDE).toBe("from-override");
  });

  it("clears claude-cli provider-routing, auth, and telemetry env while keeping host-managed hardening", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://proxy.example.com/v1");
    vi.stubEnv("CLAUDE_CODE_USE_BEDROCK", "1");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "env-auth-token");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "env-oauth-token");
    vi.stubEnv("CLAUDE_CODE_REMOTE", "1");
    vi.stubEnv("ANTHROPIC_UNIX_SOCKET", "/tmp/anthropic.sock");
    vi.stubEnv("OTEL_LOGS_EXPORTER", "none");
    vi.stubEnv("OTEL_METRICS_EXPORTER", "none");
    vi.stubEnv("OTEL_TRACES_EXPORTER", "none");
    vi.stubEnv("OTEL_EXPORTER_OTLP_PROTOCOL", "none");
    vi.stubEnv("OTEL_SDK_DISABLED", "true");
    mockSuccessfulCliRun();

    await executePreparedCliRun(
      buildPreparedCliRunContext({
        provider: "claude-cli",
        model: "claude-sonnet-4-6",
        runId: "run-claude-env-hardened",
        backend: {
          env: {
            SAFE_KEEP: "ok",
            ANTHROPIC_BASE_URL: "https://override.example.com/v1",
            CLAUDE_CODE_OAUTH_TOKEN: "override-oauth-token",
            CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
          },
          clearEnv: [
            "ANTHROPIC_BASE_URL",
            "CLAUDE_CODE_USE_BEDROCK",
            "ANTHROPIC_AUTH_TOKEN",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "CLAUDE_CODE_REMOTE",
            "ANTHROPIC_UNIX_SOCKET",
            "OTEL_LOGS_EXPORTER",
            "OTEL_METRICS_EXPORTER",
            "OTEL_TRACES_EXPORTER",
            "OTEL_EXPORTER_OTLP_PROTOCOL",
            "OTEL_SDK_DISABLED",
          ],
        },
      }),
    );

    const input = supervisorSpawnMock.mock.calls[0]?.[0] as {
      env?: Record<string, string | undefined>;
    };
    expect(input.env?.SAFE_KEEP).toBe("ok");
    expect(input.env?.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe("1");
    expect(input.env?.ANTHROPIC_BASE_URL).toBe("https://override.example.com/v1");
    expect(input.env?.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(input.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(input.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("override-oauth-token");
    expect(input.env?.CLAUDE_CODE_REMOTE).toBeUndefined();
    expect(input.env?.ANTHROPIC_UNIX_SOCKET).toBeUndefined();
    expect(input.env?.OTEL_LOGS_EXPORTER).toBeUndefined();
    expect(input.env?.OTEL_METRICS_EXPORTER).toBeUndefined();
    expect(input.env?.OTEL_TRACES_EXPORTER).toBeUndefined();
    expect(input.env?.OTEL_EXPORTER_OTLP_PROTOCOL).toBeUndefined();
    expect(input.env?.OTEL_SDK_DISABLED).toBeUndefined();
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
    const context = buildPreparedCliRunContext({
      provider: "codex-cli",
      model: "gpt-5.4",
      runId: "run-warning",
    });
    context.reusableCliSession = { sessionId: "thread-123" };
    context.bootstrapPromptWarningLines = [
      "[Bootstrap truncation warning]",
      "- AGENTS.md: 200 raw -> 20 injected",
    ];

    await executePreparedCliRun(context, "thread-123");

    const input = supervisorSpawnMock.mock.calls[0]?.[0] as {
      argv?: string[];
      input?: string;
    };
    const promptCarrier = [input.input ?? "", ...(input.argv ?? [])].join("\n");

    expect(promptCarrier).toContain("[Bootstrap truncation warning]");
    expect(promptCarrier).toContain("- AGENTS.md: 200 raw -> 20 injected");
    expect(promptCarrier).toContain("hi");
  });

  it("loads workspace bootstrap files into the Claude CLI system prompt", async () => {
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-cli-bootstrap-context-"),
    );

    await fs.writeFile(
      path.join(workspaceDir, "AGENTS.md"),
      [
        "# AGENTS.md",
        "",
        "Read SOUL.md and IDENTITY.md before replying.",
        "Use the injected workspace bootstrap files as standing instructions.",
      ].join("\n"),
      "utf-8",
    );
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "SOUL-SECRET\n", "utf-8");
    await fs.writeFile(path.join(workspaceDir, "IDENTITY.md"), "IDENTITY-SECRET\n", "utf-8");
    await fs.writeFile(path.join(workspaceDir, "USER.md"), "USER-SECRET\n", "utf-8");

    setCliRunnerPrepareTestDeps({
      makeBootstrapWarn: realMakeBootstrapWarn,
      resolveBootstrapContextForRun: realResolveBootstrapContextForRun,
    });

    try {
      const { contextFiles } = await realResolveBootstrapContextForRun({
        workspaceDir,
      });
      const allArgs = buildSystemPrompt({
        workspaceDir,
        modelDisplay: "claude-cli/sonnet",
        contextFiles,
        tools: [],
      });
      const agentsPath = path.join(workspaceDir, "AGENTS.md");
      const soulPath = path.join(workspaceDir, "SOUL.md");
      const identityPath = path.join(workspaceDir, "IDENTITY.md");
      const userPath = path.join(workspaceDir, "USER.md");
      expect(allArgs).toContain("# Project Context");
      expect(allArgs).toContain(`## ${agentsPath}`);
      expect(allArgs).toContain("Read SOUL.md and IDENTITY.md before replying.");
      expect(allArgs).toContain(`## ${soulPath}`);
      expect(allArgs).toContain("SOUL-SECRET");
      expect(allArgs).toContain(
        "If SOUL.md is present, embody its persona and tone. Avoid stiff, generic replies; follow its guidance unless higher-priority instructions override it.",
      );
      expect(allArgs).toContain(`## ${identityPath}`);
      expect(allArgs).toContain("IDENTITY-SECRET");
      expect(allArgs).toContain(`## ${userPath}`);
      expect(allArgs).toContain("USER-SECRET");
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      restoreCliRunnerPrepareTestDeps();
    }
  });
});
