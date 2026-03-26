import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAnthropicCliBackend } from "../../extensions/anthropic/cli-backend.js";
import { buildGoogleGeminiCliBackend } from "../../extensions/google/cli-backend.js";
import { buildOpenAICodexCliBackend } from "../../extensions/openai/cli-backend.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { resolveCliNoOutputTimeoutMs } from "./cli-runner/helpers.js";
import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

const supervisorSpawnMock = vi.fn();
const enqueueSystemEventMock = vi.fn();
const requestHeartbeatNowMock = vi.fn();
const SMALL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";
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

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({
    spawn: (...args: unknown[]) => supervisorSpawnMock(...args),
    cancel: vi.fn(),
    cancelScope: vi.fn(),
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

let runCliAgent: typeof import("./cli-runner.js").runCliAgent;

async function loadFreshCliRunnerModuleForTest() {
  vi.resetModules();
  vi.doMock("../process/supervisor/index.js", () => ({
    getProcessSupervisor: () => ({
      spawn: (...args: unknown[]) => supervisorSpawnMock(...args),
      cancel: vi.fn(),
      cancelScope: vi.fn(),
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
}

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
  stdout: string;
  stderr: string;
  timedOut: boolean;
  noOutputTimedOut: boolean;
};

type TestCliBackendConfig = {
  command: string;
  env?: Record<string, string>;
  clearEnv?: string[];
};

function createManagedRun(exit: MockRunExit, pid = 1234) {
  return {
    runId: "run-supervisor",
    pid,
    startedAtMs: Date.now(),
    stdin: undefined,
    wait: vi.fn().mockResolvedValue(exit),
    cancel: vi.fn(),
  };
}

function mockSuccessfulCliRun() {
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
}

async function runCliAgentWithBackendConfig(params: {
  backend: TestCliBackendConfig;
  runId: string;
}) {
  await runCliAgent({
    sessionId: "s1",
    sessionFile: "/tmp/session.jsonl",
    workspaceDir: "/tmp",
    config: {
      agents: {
        defaults: {
          cliBackends: {
            "codex-cli": params.backend,
          },
        },
      },
    } satisfies OpenClawConfig,
    prompt: "hi",
    provider: "codex-cli",
    model: "gpt-5.2-codex",
    timeoutMs: 1_000,
    runId: params.runId,
    cliSessionId: "thread-123",
  });
}

const EXISTING_CODEX_CONFIG = {
  agents: {
    defaults: {
      cliBackends: {
        "codex-cli": {
          command: "codex",
          args: ["exec", "--json"],
          resumeArgs: ["exec", "resume", "{sessionId}", "--json"],
          output: "text",
          modelArg: "--model",
          sessionMode: "existing",
        },
      },
    },
  },
} satisfies OpenClawConfig;

async function runExistingCodexCliAgent(params: {
  runId: string;
  cliSessionBindingAuthProfileId: string;
  authProfileId: string;
}) {
  await runCliAgent({
    sessionId: "s1",
    sessionFile: "/tmp/session.jsonl",
    workspaceDir: "/tmp",
    config: EXISTING_CODEX_CONFIG,
    prompt: "hi",
    provider: "codex-cli",
    model: "gpt-5.4",
    timeoutMs: 1_000,
    runId: params.runId,
    cliSessionBinding: {
      sessionId: "thread-123",
      authProfileId: params.cliSessionBindingAuthProfileId,
    },
    authProfileId: params.authProfileId,
  });
}

describe("runCliAgent with process supervisor", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(async () => {
    const registry = createEmptyPluginRegistry();
    registry.cliBackends = [
      {
        pluginId: "anthropic",
        backend: buildAnthropicCliBackend(),
        source: "test",
      },
      {
        pluginId: "openai",
        backend: buildOpenAICodexCliBackend(),
        source: "test",
      },
      {
        pluginId: "google",
        backend: buildGoogleGeminiCliBackend(),
        source: "test",
      },
    ];
    setActivePluginRegistry(registry);
    supervisorSpawnMock.mockClear();
    enqueueSystemEventMock.mockClear();
    requestHeartbeatNowMock.mockClear();
    hoisted.resolveBootstrapContextForRunMock.mockReset().mockResolvedValue({
      bootstrapFiles: [],
      contextFiles: [],
    });
    await loadFreshCliRunnerModuleForTest();
  });

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

    expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
    const input = supervisorSpawnMock.mock.calls[0]?.[0] as {
      argv?: string[];
      input?: string;
    };
    // Use claude-cli because it defines systemPromptArg ("--append-system-prompt"),
    // so the system prompt is serialized into argv. The codex-cli backend lacks
    // systemPromptArg, meaning the prompt is dropped before reaching argv —
    // making the assertion vacuous. See: openclaw/openclaw#44135
    const allArgs = (input.argv ?? []).join("\n");
    expect(allArgs).not.toContain("Tools are disabled in this session");
    // Verify the user-supplied system prompt IS present (proves the arg path works)
    expect(allArgs).toContain("You are a helpful assistant.");
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
  });

  it("keeps resuming the CLI across model changes and passes the new model flag", async () => {
    mockSuccessfulCliRun();

    await runExistingCodexCliAgent({
      runId: "run-model-switch",
      cliSessionBindingAuthProfileId: "openai:default",
      authProfileId: "openai:default",
    });

    const input = supervisorSpawnMock.mock.calls[0]?.[0] as { argv?: string[] };
    expect(input.argv).toEqual([
      "codex",
      "exec",
      "resume",
      "thread-123",
      "--json",
      "--model",
      "gpt-5.4",
      "hi",
    ]);
  });

  it("starts a fresh CLI session when the auth profile changes", async () => {
    mockSuccessfulCliRun();

    await runExistingCodexCliAgent({
      runId: "run-auth-change",
      cliSessionBindingAuthProfileId: "openai:work",
      authProfileId: "openai:personal",
    });

    const input = supervisorSpawnMock.mock.calls[0]?.[0] as { argv?: string[]; scopeKey?: string };
    expect(input.argv).toEqual(["codex", "exec", "--json", "--model", "gpt-5.4", "hi"]);
    expect(input.scopeKey).toBeUndefined();
  });

  it("sanitizes dangerous backend env overrides before spawn", async () => {
    vi.stubEnv("PATH", "/usr/bin:/bin");
    vi.stubEnv("HOME", "/tmp/trusted-home");

    mockSuccessfulCliRun();
    await runCliAgentWithBackendConfig({
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
    expect(input.env?.PATH).toBe("/usr/bin:/bin");
    expect(input.env?.HOME).toBe("/tmp/trusted-home");
    expect(input.env?.NODE_OPTIONS).toBeUndefined();
    expect(input.env?.LD_PRELOAD).toBeUndefined();
  });

  it("applies clearEnv after sanitizing backend env overrides", async () => {
    vi.stubEnv("PATH", "/usr/bin:/bin");
    vi.stubEnv("SAFE_CLEAR", "from-base");

    mockSuccessfulCliRun();
    await runCliAgentWithBackendConfig({
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

  it("hydrates prompt media refs into CLI image args", async () => {
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
        model: "gpt-5.2-codex",
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
    const appendedPath = argv.find((value) => value.includes("openclaw-cli-images-"));
    expect(appendedPath).toBeDefined();
    expect(appendedPath).not.toBe(sourceImage);
    expect(promptCarrier).toContain(appendedPath ?? "");
  });

  it("prefers explicit images over prompt refs", async () => {
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
        model: "gpt-5.2-codex",
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
