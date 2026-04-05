import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { onAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import {
  makeBootstrapWarn as realMakeBootstrapWarn,
  resolveBootstrapContextForRun as realResolveBootstrapContextForRun,
} from "./bootstrap-files.js";
import {
  createManagedRun,
  mockSuccessfulCliRun,
  restoreCliRunnerPrepareTestDeps,
  runCliAgentWithBackendConfig,
  setupCliRunnerTestModule,
  SMALL_PNG_BASE64,
  stubBootstrapContext,
  supervisorSpawnMock,
} from "./cli-runner.test-support.js";
import { setCliRunnerPrepareTestDeps } from "./cli-runner/prepare.js";

beforeEach(() => {
  resetAgentEventsForTest();
  restoreCliRunnerPrepareTestDeps();
});

describe("runCliAgent spawn path", () => {
  it("does not inject hardcoded 'Tools are disabled' text into CLI arguments", async () => {
    const runCliAgent = await setupCliRunnerTestModule();
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
      prompt: "Run: node script.mjs",
      provider: "claude-cli",
      model: "sonnet",
      timeoutMs: 1_000,
      runId: "run-no-tools-disabled",
      extraSystemPrompt: "You are a helpful assistant.",
    });

    const input = supervisorSpawnMock.mock.calls[0]?.[0] as { argv?: string[] };
    const allArgs = (input.argv ?? []).join("\n");
    expect(allArgs).not.toContain("Tools are disabled in this session");
    expect(allArgs).toContain("You are a helpful assistant.");
  });

  it("pipes Claude prompts over stdin instead of argv", async () => {
    const runCliAgent = await setupCliRunnerTestModule();
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
      prompt: "Explain this diff",
      provider: "claude-cli",
      model: "sonnet",
      timeoutMs: 1_000,
      runId: "run-stdin-claude",
    });

    const input = supervisorSpawnMock.mock.calls[0]?.[0] as {
      argv?: string[];
      input?: string;
    };
    expect(input.input).toContain("Explain this diff");
    expect(input.argv).not.toContain("Explain this diff");
  });

  it("injects a strict empty MCP config for bundle-MCP-enabled Claude CLI runs", async () => {
    const runCliAgent = await setupCliRunnerTestModule();
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: JSON.stringify({
          session_id: "session-123",
          message: "ok",
        }),
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    await runCliAgent({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: {
        agents: {
          defaults: {
            cliBackends: {
              "claude-cli": {
                command: "node",
                args: ["/tmp/fake-claude.mjs"],
                clearEnv: [],
              },
            },
          },
        },
      } satisfies OpenClawConfig,
      prompt: "hi",
      provider: "claude-cli",
      model: "claude-sonnet-4-6",
      timeoutMs: 1_000,
      runId: "run-bundle-mcp-empty",
    });

    const input = supervisorSpawnMock.mock.calls[0]?.[0] as { argv?: string[] };
    expect(input.argv?.[0]).toBe("node");
    expect(input.argv).toContain("/tmp/fake-claude.mjs");
    expect(input.argv).toContain("--strict-mcp-config");
    const configFlagIndex = input.argv?.indexOf("--mcp-config") ?? -1;
    expect(configFlagIndex).toBeGreaterThanOrEqual(0);
    expect(input.argv?.[configFlagIndex + 1]).toMatch(/^\/.+\/mcp\.json$/);
  });

  it("runs CLI through supervisor and returns payload", async () => {
    const runCliAgent = await setupCliRunnerTestModule();
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
      model: "gpt-5.4",
      timeoutMs: 1_000,
      runId: "run-1",
      cliSessionId: "thread-123",
    });

    expect(result.payloads?.[0]?.text).toBe("ok");
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

  it("streams Claude text deltas from stream-json stdout", async () => {
    const runCliAgent = await setupCliRunnerTestModule();
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
      const result = await runCliAgent({
        sessionId: "s1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        prompt: "hi",
        provider: "claude-cli",
        model: "sonnet",
        timeoutMs: 1_000,
        runId: "run-claude-stream-json",
      });

      expect(result.payloads?.[0]?.text).toBe("Hello world");
      expect(agentEvents).toEqual([
        { stream: "assistant", text: "Hello", delta: "Hello" },
        { stream: "assistant", text: "Hello world", delta: " world" },
      ]);
    } finally {
      stop();
    }
  });

  it("sanitizes dangerous backend env overrides before spawn", async () => {
    const runCliAgent = await setupCliRunnerTestModule();
    mockSuccessfulCliRun();
    await runCliAgentWithBackendConfig({
      runCliAgent,
      backend: {
        command: "codex",
        env: {
          NODE_OPTIONS: "--require ./malicious.js",
          LD_PRELOAD: "/tmp/pwn.so",
          PATH: "/tmp/evil",
          HOME: "/tmp/evil-home",
          SAFE_KEY: "ok",
        },
      },
      runId: "run-env-sanitized",
    });

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
    const runCliAgent = await setupCliRunnerTestModule();
    process.env.SAFE_CLEAR = "from-base";
    mockSuccessfulCliRun();
    await runCliAgentWithBackendConfig({
      runCliAgent,
      backend: {
        command: "codex",
        env: {
          SAFE_KEEP: "keep-me",
        },
        clearEnv: ["SAFE_CLEAR"],
      },
      runId: "run-clear-env",
    });

    const input = supervisorSpawnMock.mock.calls[0]?.[0] as {
      env?: Record<string, string | undefined>;
    };
    expect(input.env?.SAFE_KEEP).toBe("keep-me");
    expect(input.env?.SAFE_CLEAR).toBeUndefined();
  });

  it("keeps explicit backend env overrides even when clearEnv drops inherited values", async () => {
    const runCliAgent = await setupCliRunnerTestModule();
    process.env.SAFE_OVERRIDE = "from-base";
    mockSuccessfulCliRun();
    await runCliAgentWithBackendConfig({
      runCliAgent,
      backend: {
        command: "codex",
        env: {
          SAFE_OVERRIDE: "from-override",
        },
        clearEnv: ["SAFE_OVERRIDE"],
      },
      runId: "run-clear-env-override",
    });

    const input = supervisorSpawnMock.mock.calls[0]?.[0] as {
      env?: Record<string, string | undefined>;
    };
    expect(input.env?.SAFE_OVERRIDE).toBe("from-override");
  });

  it("prepends bootstrap warnings to the CLI prompt body", async () => {
    const runCliAgent = await setupCliRunnerTestModule();
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
    stubBootstrapContext({
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
      model: "gpt-5.4",
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

  it("loads workspace bootstrap files into the Claude CLI system prompt", async () => {
    const runCliAgent = await setupCliRunnerTestModule();
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-cli-bootstrap-context-"),
    );
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
      await runCliAgent({
        sessionId: "s1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir,
        prompt: "BOOTSTRAP_CAPTURE_CHECK",
        provider: "claude-cli",
        model: "sonnet",
        timeoutMs: 1_000,
        runId: "run-bootstrap-context",
      });

      const input = supervisorSpawnMock.mock.calls[0]?.[0] as {
        argv?: string[];
        input?: string;
      };
      const allArgs = (input.argv ?? []).join("\n");
      const agentsPath = path.join(workspaceDir, "AGENTS.md");
      const soulPath = path.join(workspaceDir, "SOUL.md");
      const identityPath = path.join(workspaceDir, "IDENTITY.md");
      const userPath = path.join(workspaceDir, "USER.md");
      expect(input.input).toContain("BOOTSTRAP_CAPTURE_CHECK");
      expect(allArgs).toContain("--append-system-prompt");
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

  it("hydrates prompt media refs into CLI image args", async () => {
    const runCliAgent = await setupCliRunnerTestModule();
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

    const tempDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-cli-prompt-image-"),
    );
    const sourceImage = path.join(tempDir, "bb-image.png");
    await fs.writeFile(sourceImage, Buffer.from(SMALL_PNG_BASE64, "base64"));

    try {
      await runCliAgent({
        sessionId: "s1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: tempDir,
        prompt: `[media attached: ${sourceImage} (image/png)]\n\n<media:image>`,
        provider: "codex-cli",
        model: "gpt-5.4",
        timeoutMs: 1_000,
        runId: "run-prompt-image",
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    const input = supervisorSpawnMock.mock.calls[0]?.[0] as { argv?: string[] };
    const argv = input.argv ?? [];
    const imageArgIndex = argv.indexOf("--image");
    expect(imageArgIndex).toBeGreaterThanOrEqual(0);
    expect(argv[imageArgIndex + 1]).toContain("openclaw-cli-images-");
    expect(argv[imageArgIndex + 1]).not.toBe(sourceImage);
  });

  it("appends hydrated prompt media refs to generic backend prompts", async () => {
    const runCliAgent = await setupCliRunnerTestModule();
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

    const tempDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-cli-prompt-image-generic-"),
    );
    const sourceImage = path.join(tempDir, "claude-image.png");
    await fs.writeFile(sourceImage, Buffer.from(SMALL_PNG_BASE64, "base64"));

    try {
      await runCliAgent({
        sessionId: "s1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: tempDir,
        prompt: `[media attached: ${sourceImage} (image/png)]\n\n<media:image>`,
        provider: "claude-cli",
        model: "claude-opus-4-1",
        timeoutMs: 1_000,
        runId: "run-prompt-image-generic",
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    const input = supervisorSpawnMock.mock.calls[0]?.[0] as { argv?: string[]; input?: string };
    const argv = input.argv ?? [];
    expect(argv).not.toContain("--image");
    const promptCarrier = [input.input ?? "", ...argv].join("\n");
    const appendedPath = promptCarrier
      .split("\n")
      .find((value) => value.includes("openclaw-cli-images-"));
    expect(appendedPath).toBeDefined();
    expect(appendedPath).not.toBe(sourceImage);
    expect(promptCarrier).toContain(appendedPath ?? "");
  });

  it("prefers explicit images over prompt refs", async () => {
    const runCliAgent = await setupCliRunnerTestModule();
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

    const tempDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-cli-explicit-images-"),
    );
    const sourceImage = path.join(tempDir, "ignored-prompt-image.png");
    await fs.writeFile(sourceImage, Buffer.from(SMALL_PNG_BASE64, "base64"));

    try {
      await runCliAgent({
        sessionId: "s1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: tempDir,
        prompt: `[media attached: ${sourceImage} (image/png)]\n\n<media:image>`,
        images: [{ type: "image", data: SMALL_PNG_BASE64, mimeType: "image/png" }],
        provider: "codex-cli",
        model: "gpt-5.4",
        timeoutMs: 1_000,
        runId: "run-explicit-image-precedence",
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    const input = supervisorSpawnMock.mock.calls[0]?.[0] as { argv?: string[] };
    const argv = input.argv ?? [];
    expect(argv.filter((arg) => arg === "--image")).toHaveLength(1);
  });

  it("falls back to per-agent workspace when workspaceDir is missing", async () => {
    const runCliAgent = await setupCliRunnerTestModule();
    const tempDir = await fs.mkdtemp(
      path.join(process.env.TMPDIR ?? "/tmp", "openclaw-cli-runner-"),
    );
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
        model: "gpt-5.4",
        timeoutMs: 1_000,
        runId: "run-4",
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    const input = supervisorSpawnMock.mock.calls[0]?.[0] as { cwd?: string };
    expect(input.cwd).toBe(path.resolve(fallbackWorkspace));
  });
});
