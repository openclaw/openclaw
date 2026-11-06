// Anthropic tests cover cli shared plugin behavior.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { buildAnthropicCliBackend } from "./cli-backend.js";
import { CLAUDE_CLI_CLEAR_ENV } from "./cli-constants.js";
import {
  normalizeClaudeBackendConfig,
  resolveClaudeCliExecutionArgs,
  supportsClaudeDynamicSystemPromptSections,
} from "./cli-shared.js";
import { registerAnthropicPlugin } from "./register.runtime.js";

vi.mock("./session-catalog-executable.js", () => ({
  resolveClaudeTerminalExecutable: () => ({ executable: "claude" }),
}));

type ClaudePreparedExecutionWithSecret = {
  env?: Record<string, string>;
  clearEnv?: string[];
  cleanup?: () => Promise<void>;
  secretInput: {
    fd: number;
    fingerprint: string;
    createData: () => Buffer;
  };
};

const CLAUDE_CLI_DISALLOWED_TOOLS =
  "ScheduleWakeup,CronCreate,Bash(run_in_background:true),Monitor";
const CLAUDE_CACHE_FLAG = "--exclude-dynamic-system-prompt-sections";

const argv = (...parts: string[]) => parts.flatMap((part) => part.split(" "));
const defaultBackend = buildAnthropicCliBackend();
function executionArgs(overrides: Partial<Parameters<typeof resolveClaudeCliExecutionArgs>[0]>) {
  return resolveClaudeCliExecutionArgs({
    workspaceDir: "/tmp",
    provider: "claude-cli",
    modelId: "claude-opus-4-8",
    config: { tools: { exec: { mode: "ask" } } },
    useResume: false,
    baseArgs: ["-p"],
    ...overrides,
  });
}

describe("Claude CLI adapter equivalence", () => {
  const commonArgs = [
    "-p",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--setting-sources",
    "user",
    "--allowedTools",
    "mcp__openclaw__*",
    "--disallowedTools",
    CLAUDE_CLI_DISALLOWED_TOOLS,
  ];

  it("disables native Bash while retaining native denials for managed shell turns", () => {
    for (const baseArgs of [commonArgs, [...commonArgs, "--resume", "session"]]) {
      const args = resolveClaudeCliExecutionArgs({
        workspaceDir: "/tmp/managed-shell",
        provider: "claude-cli",
        modelId: "claude-sonnet-4-6",
        useResume: baseArgs.includes("--resume"),
        baseArgs,
        hostOwnedTools: ["exec", "process"],
      });
      expect(args.filter((arg) => arg === "--disallowedTools")).toHaveLength(1);
      const denials = args[args.indexOf("--disallowedTools") + 1]?.split(",");
      expect(denials).toEqual(
        expect.arrayContaining(["Bash", "CronCreate", "ScheduleWakeup", "Monitor"]),
      );
      expect(args).not.toContain("--tools");
    }
  });

  it("privately acknowledges isolated completion preparation", () => {
    const backend = buildAnthropicCliBackend();
    const prepared = backend.prepareExecution?.({
      workspaceDir: "/tmp/openclaw-claude-cli",
      provider: "claude-cli",
      modelId: "claude-opus-4-8",
      isolatedCompletionPrompt: "TASK: return JSON",
      isolatedCompletionSystemPrompt: "Return JSON.",
    } as Parameters<NonNullable<typeof backend.prepareExecution>>[0] & {
      isolatedCompletionPrompt: string;
      isolatedCompletionSystemPrompt: string;
    }) as { env?: Record<string, string>; isolatedCompletionEnforced?: true };

    expect(prepared).toEqual({
      env: { CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1" },
      isolatedCompletionEnforced: true,
    });
  });

  it("builds Claude Code's native manual compaction command", () => {
    const backend = buildAnthropicCliBackend();
    const manualCompaction = backend.manualCompaction;
    // Redacted fixtures preserve the control fields observed from Claude Code 2.0.76-2.1.226.
    const compactingStatus = { type: "system", subtype: "status", status: "compacting" };
    const compactResult = { compact_result: "success" };
    const compactBoundary = { type: "system", subtype: "compact_boundary" };

    expect(manualCompaction?.buildPrompt()).toBe("/compact");
    expect(manualCompaction?.buildPrompt(" keep operator decisions ")).toBe(
      "/compact keep operator decisions",
    );
    expect(manualCompaction?.input).toBe("arg");
    expect(
      manualCompaction?.validateOutput(
        [compactingStatus, compactResult, compactBoundary]
          .map((event) => JSON.stringify(event))
          .join("\n"),
      ),
    ).toEqual({ ok: true });
    expect(manualCompaction?.validateOutput(`${JSON.stringify(compactResult)}\n`)).toEqual({
      ok: true,
    });
    expect(manualCompaction?.validateOutput(`${JSON.stringify(compactBoundary)}\n`)).toEqual({
      ok: true,
    });
    expect(
      manualCompaction?.validateOutput(
        `${JSON.stringify(compactingStatus)}\n${JSON.stringify({ type: "system", subtype: "local_command" })}\n`,
      ),
    ).toEqual({
      ok: false,
      reason: "Claude CLI did not confirm that native compaction ran.",
    });
  });
});

function expectDefaultDisallowedTools(args: readonly string[] | undefined) {
  const disallowedIndex = args?.indexOf("--disallowedTools") ?? -1;
  expect(disallowedIndex).toBeGreaterThanOrEqual(0);
  expect(args?.[disallowedIndex + 1]).toBe(CLAUDE_CLI_DISALLOWED_TOOLS);
}

it.each([
  ["--dangerously-skip-permissions --verbose", "--verbose --setting-sources user"],
  ["--permission-mode acceptEdits", "--permission-mode acceptEdits --setting-sources user"],
  ["--permission-mode=acceptEdits", "--permission-mode=acceptEdits --setting-sources user"],
  ["--setting-sources project", "--setting-sources user"],
  ["--setting-sources=local,user", "--setting-sources=user"],
])("normalizes Claude permission and setting args: %s", (input, expected) => {
  expect(executionArgs({ baseArgs: argv("-p", input) })).toEqual(argv("-p", expected));
});

describe("resolveClaudeCliExecutionArgs", () => {
  it.each([
    [undefined, true],
    [{ mode: "full" }, true],
    [{ mode: "ask" }, false],
    [{ security: "allowlist", ask: "always" }, false],
  ] as const)(
    "derives permission mode from global exec policy %j for normal runs",
    (exec, bypass) => {
      const args = executionArgs({ config: { tools: { exec } } });
      expect(args.includes("bypassPermissions")).toBe(bypass);
    },
  );

  it("keeps per-agent exec policy for normal runs and omits only the injected mode for compaction", () => {
    const forAgent = (
      globalMode: "ask" | "full",
      agentMode: "ask" | "full",
      controlOperation?: "compact",
    ) =>
      executionArgs({
        agentId: "worker",
        controlOperation,
        config: {
          tools: { exec: { mode: globalMode } },
          agents: { entries: { worker: { tools: { exec: { mode: agentMode } } } } },
        },
      });

    expect(forAgent("full", "ask")).not.toContain("bypassPermissions");
    expect(forAgent("ask", "full")).toContain("bypassPermissions");
    expect(forAgent("ask", "full", "compact")).not.toContain("bypassPermissions");
  });

  it.each([false, true])(
    "keeps yolo bypass on ordinary turns but omits it for manual compaction (resume=%s)",
    (useResume) => {
      const normalized = normalizeClaudeBackendConfig(defaultBackend.config);
      const context = {
        config: { tools: { exec: { mode: "full" as const } } },
        useResume,
        baseArgs: (useResume ? normalized.resumeArgs : normalized.args) ?? [],
      };
      expect(executionArgs(context)).toEqual(
        expect.arrayContaining(["--permission-mode", "bypassPermissions"]),
      );
      const compactArgs = executionArgs({ ...context, controlOperation: "compact" });
      expect(compactArgs).not.toContain("--permission-mode");
      expect(compactArgs).not.toContain("bypassPermissions");
    },
  );

  it.each([
    "--permission-mode acceptEdits",
    "--permission-mode=acceptEdits",
    "--permission-mode bypassPermissions",
  ])("preserves explicit %s during manual compaction", (permissionArgs) => {
    const args = executionArgs({
      config: { tools: { exec: { mode: "full" } } },
      controlOperation: "compact",
      baseArgs: argv("-p", permissionArgs),
    });
    expect(args).toEqual(argv("-p", permissionArgs, "--setting-sources user"));
  });

  it("keeps the real resumed manual-compaction command enabled", () => {
    expect(defaultBackend.config.systemPromptWhen).toBe("always");
    const manualCompaction = defaultBackend.manualCompaction;
    const baseArgs = defaultBackend.config.resumeArgs?.map((arg) =>
      arg.replaceAll("{sessionId}", "native-session"),
    );
    if (!manualCompaction || !baseArgs) {
      throw new Error("Anthropic CLI backend must expose resumed manual compaction");
    }

    const args = [
      ...executionArgs({ useResume: true, baseArgs, controlOperation: "compact" }),
      manualCompaction.buildPrompt(),
    ];

    expect(args).toContain("/compact");
    expect(args).not.toContain("--disable-slash-commands");
  });

  it("denies every configured MCP tool when the allowlist is empty", () => {
    expect(
      executionArgs({
        baseArgs: argv(
          "-p --tools Bash,Edit --allowedTools mcp__openclaw__* --disallowedTools",
          "mcp__other__*",
        ),
        toolAvailability: { native: [], openClaw: [] },
      }),
    ).toEqual([
      ...argv("-p --setting-sources"),
      "",
      "--settings",
      '{"disableAllHooks":true,"enabledPlugins":{},"autoMemoryEnabled":false,"claudeMdExcludes":["**/CLAUDE.md","**/CLAUDE.local.md","**/.claude/rules/**"]}',
      ...argv("--disable-slash-commands --no-chrome --strict-mcp-config --tools"),
      "",
      ...argv("--disallowedTools mcp__*,mcp__other__*"),
    ]);
  });

  it.each([
    ["claude-sonnet-4-6", "off", "--effort xhigh --effort=low", "--effort xhigh --effort=low"],
    ["claude-fable-5", "off", "--effort high", "--effort low"],
    ["claude-opus-4-7", "minimal", "", "--effort low"],
    ["claude-opus-4-7", "medium", "", "--effort medium"],
  ] as const)("maps %s thinking=%s to %s", (modelId, thinkingLevel, configured, expected) => {
    const baseArgs = argv("-p --setting-sources user", ...(configured ? [configured] : []));
    expect(executionArgs({ modelId, thinkingLevel, baseArgs })).toEqual(
      argv("-p --setting-sources user", expected),
    );
  });

  it("strips configured effort args when thinking is adaptive", () => {
    expect(
      executionArgs({
        thinkingLevel: "adaptive",
        useResume: true,
        baseArgs: argv(
          "-p --effort xhigh --output-format stream-json --effort=low --verbose --resume",
          "{sessionId}",
        ),
      }),
    ).toEqual(
      argv("-p --output-format stream-json --verbose --resume {sessionId} --setting-sources user"),
    );
  });

  it("forces isolated no-tool one-shot args for side-question execution", () => {
    expect(
      executionArgs({
        modelId: "claude-opus-4-7",
        thinkingLevel: "max",
        useResume: true,
        executionMode: "side-question",
        baseArgs: argv(
          "-p --output-format stream-json --allowedTools=mcp__openclaw__* --allowedTools",
          "Read Grep --permission-mode bypassPermissions --session-id=abc --resume",
          "old-session --resume-session-at old-message",
          "--resume-session-at=old-message-equals --mcp-config /tmp/side-question-mcp.json",
          "--bare --safe-mode --strict-mcp-config --no-session-persistence --max-turns 4",
          "--effort high",
        ),
      }),
    ).toEqual([
      ...argv("-p --output-format stream-json --setting-sources user --safe-mode --tools"),
      "",
      ...argv(
        "--disallowedTools mcp__* --strict-mcp-config --no-session-persistence",
        "--max-turns 1 --permission-mode default",
      ),
    ]);
  });
});

describe("normalizeClaudeBackendConfig", () => {
  it("normalizes I/O defaults while deferring argument normalization until execution", () => {
    const streamArgs = argv("-p --output-format stream-json --verbose");
    const resumeArgs = [...streamArgs, "--resume", "{sessionId}"];
    const normalized = normalizeClaudeBackendConfig({
      command: "claude",
      args: [...streamArgs],
      resumeArgs: [...resumeArgs],
    });

    expect(normalized).toMatchObject({
      args: streamArgs,
      resumeArgs,
      output: "jsonl",
      liveSession: "claude-stdio",
      input: "stdin",
    });
  });

  it("gates the Claude cache-control flag on the capability probe", () => {
    expect(supportsClaudeDynamicSystemPromptSections("Claude Code 2.1.97")).toBe(false);
    expect(supportsClaudeDynamicSystemPromptSections("Claude Code 2.1.98")).toBe(true);
    expect(supportsClaudeDynamicSystemPromptSections("Claude Code 2.1.98-beta.1")).toBe(false);
    expect(supportsClaudeDynamicSystemPromptSections("2.1.98 (Claude Code)")).toBe(true);
    expect(supportsClaudeDynamicSystemPromptSections("unparseable")).toBe(false);

    const unsupported = buildAnthropicCliBackend({
      supportsDynamicSystemPromptSections: () => false,
    });
    const supported = buildAnthropicCliBackend({
      supportsDynamicSystemPromptSections: () => true,
    });
    const context = {
      workspaceDir: "/tmp",
      provider: "claude-cli",
      modelId: "claude-haiku-4-5",
      useResume: false,
      baseArgs: unsupported.config.args ?? [],
    };

    expect(unsupported.config.args).not.toContain(CLAUDE_CACHE_FLAG);
    expect(unsupported.resolveExecutionArgs?.(context)).not.toContain(CLAUDE_CACHE_FLAG);
    expect(supported.resolveExecutionArgs?.(context)).toContain(CLAUDE_CACHE_FLAG);
  });

  it("defers one shared Claude version probe until execution and awaits it before preparing argv", async () => {
    const version = createDeferred<{ code: number; stdout: string; stderr: string }>();
    const runCommandWithTimeout = vi.fn(() => version.promise);
    const readRuntime = vi.fn(() => ({ system: { runCommandWithTimeout } }));
    const registerCliBackend = vi.fn();
    const registerHook = vi.fn();
    const api = {
      pluginConfig: { sessionCatalog: { enabled: false } },
      get runtime() {
        return readRuntime();
      },
      registerCliBackend,
      registerHook,
      registerProvider: vi.fn(),
      registerMediaUnderstandingProvider: vi.fn(),
      registerNodeInvokePolicy: vi.fn(),
    };

    registerAnthropicPlugin(api as unknown as Parameters<typeof registerAnthropicPlugin>[0]);
    const backend = registerCliBackend.mock.calls[0]?.[0] as ReturnType<
      typeof buildAnthropicCliBackend
    >;
    expect(readRuntime).not.toHaveBeenCalled();
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
    const context = {
      workspaceDir: "/tmp",
      provider: "claude-cli",
      modelId: "claude-haiku-4-5",
    };
    const prepared = vi.fn();
    const executions = [
      Promise.resolve(backend.prepareExecution?.(context)).then(prepared),
      Promise.resolve(backend.prepareExecution?.(context)).then(prepared),
    ];
    await Promise.resolve();
    expect(runCommandWithTimeout).toHaveBeenCalledOnce();
    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      ["claude", "--version"],
      expect.objectContaining({ timeoutMs: 1_500 }),
    );
    expect(registerHook).not.toHaveBeenCalled();
    expect(prepared).not.toHaveBeenCalled();
    version.resolve({ code: 0, stdout: "2.1.98 (Claude Code)", stderr: "" });
    await Promise.all(executions);
    expect(prepared).toHaveBeenCalledTimes(2);
    expect(
      backend.resolveExecutionArgs?.({
        workspaceDir: "/tmp",
        provider: "claude-cli",
        modelId: "claude-haiku-4-5",
        useResume: false,
        baseArgs: backend.config.args ?? [],
      }),
    ).toContain(CLAUDE_CACHE_FLAG);
    await backend.prepareExecution?.(context);
    expect(runCommandWithTimeout).toHaveBeenCalledOnce();
  });

  it("keeps the established argv when the version probe fails", async () => {
    const runCommandWithTimeout = vi.fn().mockRejectedValue(new Error("claude is unavailable"));
    const registerCliBackend = vi.fn();
    const registerHook = vi.fn();
    const api = {
      pluginConfig: { sessionCatalog: { enabled: false } },
      runtime: { system: { runCommandWithTimeout } },
      registerCliBackend,
      registerHook,
      registerProvider: vi.fn(),
      registerMediaUnderstandingProvider: vi.fn(),
      registerNodeInvokePolicy: vi.fn(),
    };

    registerAnthropicPlugin(api as unknown as Parameters<typeof registerAnthropicPlugin>[0]);
    const backend = registerCliBackend.mock.calls[0]?.[0] as ReturnType<
      typeof buildAnthropicCliBackend
    >;
    await backend.prepareExecution?.({
      workspaceDir: "/tmp",
      provider: "claude-cli",
      modelId: "claude-haiku-4-5",
    });
    expect(runCommandWithTimeout).toHaveBeenCalledOnce();
    expect(
      backend.resolveExecutionArgs?.({
        workspaceDir: "/tmp",
        provider: "claude-cli",
        modelId: "claude-haiku-4-5",
        useResume: false,
        baseArgs: backend.config.args ?? [],
      }),
    ).not.toContain(CLAUDE_CACHE_FLAG);
  });

  it("leaves claude cli subscription-managed, restricts setting sources, and clears inherited env overrides", () => {
    const backend = buildAnthropicCliBackend();

    expect(backend.autoSelectAuthProfile).toBe(false);
    expect(backend.config.env).toBeUndefined();
    expect(backend.config.liveSession).toBe("claude-stdio");
    expect(backend.config.output).toBe("jsonl");
    expect(backend.config.input).toBe("stdin");
    expect(backend.nativeToolMode).toBe("selectable");
    expect(backend.config.args).toContain("--setting-sources");
    expect(backend.config.args).toContain("user");
    expect(backend.config.args).not.toContain(CLAUDE_CACHE_FLAG);
    expectDefaultDisallowedTools(backend.config.args);
    expect(backend.config.resumeArgs).toContain("--setting-sources");
    expect(backend.config.resumeArgs).toContain("user");
    expect(backend.config.resumeArgs).not.toContain(CLAUDE_CACHE_FLAG);
    expectDefaultDisallowedTools(backend.config.resumeArgs);
    expect(backend.config.clearEnv).toEqual([...CLAUDE_CLI_CLEAR_ENV]);
    expect(backend.config.clearEnv).toContain("ANTHROPIC_API_TOKEN");
    expect(backend.config.clearEnv).toContain("ANTHROPIC_BASE_URL");
    expect(backend.config.clearEnv).toContain("ANTHROPIC_CUSTOM_HEADERS");
    expect(backend.config.clearEnv).toContain("ANTHROPIC_OAUTH_TOKEN");
    expect(backend.config.clearEnv).not.toContain("CLAUDE_CONFIG_DIR");
    expect(backend.config.clearEnv).toContain("CLAUDE_CODE_AUTO_COMPACT_WINDOW");
    expect(backend.config.clearEnv).toContain("CLAUDE_CODE_USE_BEDROCK");
    expect(backend.config.clearEnv).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(backend.config.clearEnv).toContain("CLAUDE_CODE_PLUGIN_CACHE_DIR");
    expect(backend.config.clearEnv).toContain("CLAUDE_CODE_PLUGIN_SEED_DIR");
    expect(backend.config.clearEnv).toContain("CLAUDE_CODE_REMOTE");
    expect(backend.config.clearEnv).toContain("CLAUDE_CODE_USE_COWORK_PLUGINS");
    expect(backend.config.clearEnv).toContain("OTEL_METRICS_EXPORTER");
    expect(backend.config.clearEnv).toContain("OTEL_EXPORTER_OTLP_PROTOCOL");
    expect(backend.config.clearEnv).toContain("OTEL_SDK_DISABLED");
  });

  it("passes the effective context budget to Claude Code's native compactor", () => {
    const backend = buildAnthropicCliBackend();

    expect(
      backend.prepareExecution?.({
        workspaceDir: "/tmp/openclaw-claude-cli",
        provider: "claude-cli",
        modelId: "claude-opus-4-7",
        contextTokenBudget: 100_000,
      }),
    ).toEqual({
      env: {
        CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: "100000",
      },
    });
  });

  it("forwards the selected OAuth profile through Claude's private descriptor", async () => {
    const backend = buildAnthropicCliBackend();

    const prepared = backend.prepareExecution?.({
      workspaceDir: "/tmp/openclaw-claude-cli",
      provider: "claude-cli",
      modelId: "claude-opus-4-7",
      authProfileId: "anthropic:claude-cli",
      authCredential: {
        type: "oauth",
        provider: "claude-cli",
        access: "selected-access-token",
        refresh: "selected-refresh-token",
        expires: Date.now() + 60_000,
      },
    } as Parameters<NonNullable<typeof backend.prepareExecution>>[0] & {
      authCredential: {
        type: "oauth";
        provider: string;
        access: string;
        refresh: string;
        expires: number;
      };
    }) as ClaudePreparedExecutionWithSecret;

    expect(prepared.env).toEqual({
      CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
      CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3",
    });
    expect(prepared.env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(prepared.env).not.toHaveProperty("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB");
    expect(prepared.clearEnv).toEqual([...CLAUDE_CLI_CLEAR_ENV]);
    expect(prepared.secretInput.fd).toBe(3);
    expect(prepared.secretInput.fingerprint).not.toContain("selected-access-token");
    expect(prepared.secretInput.createData().toString("utf8")).toBe("selected-access-token");

    const sameToken = backend.prepareExecution?.({
      workspaceDir: "/tmp/openclaw-claude-cli",
      provider: "claude-cli",
      modelId: "claude-opus-4-7",
      authCredential: {
        type: "token",
        provider: "claude-cli",
        token: "selected-access-token",
      },
    } as Parameters<NonNullable<typeof backend.prepareExecution>>[0] & {
      authCredential: { type: "token"; provider: string; token: string };
    }) as ClaudePreparedExecutionWithSecret;
    const rotatedToken = backend.prepareExecution?.({
      workspaceDir: "/tmp/openclaw-claude-cli",
      provider: "claude-cli",
      modelId: "claude-opus-4-7",
      authCredential: {
        type: "token",
        provider: "claude-cli",
        token: "rotated-access-token",
      },
    } as Parameters<NonNullable<typeof backend.prepareExecution>>[0] & {
      authCredential: { type: "token"; provider: string; token: string };
    }) as ClaudePreparedExecutionWithSecret;
    expect(sameToken.secretInput.fingerprint).toBe(prepared.secretInput.fingerprint);
    expect(rotatedToken.secretInput.fingerprint).not.toBe(prepared.secretInput.fingerprint);

    await prepared.cleanup?.();
    await sameToken.cleanup?.();
    await rotatedToken.cleanup?.();
    expect(() => prepared.secretInput.createData()).toThrow(
      "Claude CLI credential input is no longer available",
    );
  });

  it("does not forward an expired selected OAuth profile", () => {
    const backend = buildAnthropicCliBackend();

    expect(() =>
      backend.prepareExecution?.({
        workspaceDir: "/tmp/openclaw-claude-cli",
        provider: "claude-cli",
        modelId: "claude-opus-4-7",
        authProfileId: "anthropic:claude-cli",
        authCredential: {
          type: "oauth",
          provider: "claude-cli",
          access: "expired-access-token",
          refresh: "expired-refresh-token",
          expires: Date.now() - 60_000,
        },
      } as Parameters<NonNullable<typeof backend.prepareExecution>>[0] & {
        authCredential: {
          type: "oauth";
          provider: string;
          access: string;
          refresh: string;
          expires: number;
        };
      }),
    ).toThrow("Selected Claude CLI OAuth credential is expired or invalid");
  });

  it("runs native Claude login through the CLI transport without forwarding credentials", () => {
    const backend = buildAnthropicCliBackend();

    const prepared = backend.prepareExecution?.({
      workspaceDir: "/tmp/openclaw-claude-cli",
      provider: "claude-cli",
      modelId: "claude-opus-4-7",
      executionMode: "agent",
    });

    expect(prepared).toEqual(expect.objectContaining({ execute: expect.any(Function) }));
    expect(prepared).not.toHaveProperty("secretInput");
    expect(prepared).not.toHaveProperty("env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR");
    expect(prepared).not.toHaveProperty("env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR");
  });

  it("forwards a selected API-key profile through Claude's private descriptor", async () => {
    const backend = buildAnthropicCliBackend();

    const prepared = backend.prepareExecution?.({
      workspaceDir: "/tmp/openclaw-claude-cli",
      provider: "claude-cli",
      modelId: "claude-opus-4-7",
      authProfileId: "claude-cli:api",
      authCredential: {
        type: "api_key",
        provider: "claude-cli",
        key: "selected-api-key",
      },
    } as Parameters<NonNullable<typeof backend.prepareExecution>>[0] & {
      authCredential: {
        type: "api_key";
        provider: string;
        key: string;
      };
    }) as ClaudePreparedExecutionWithSecret;

    expect(prepared.env).toEqual({
      CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
      CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: "3",
    });
    expect(prepared.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(prepared.env).not.toHaveProperty("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB");
    expect(prepared.secretInput.fingerprint).not.toContain("selected-api-key");
    expect(prepared.secretInput.createData().toString("utf8")).toBe("selected-api-key");

    await prepared.cleanup?.();
    expect(() => prepared.secretInput.createData()).toThrow(
      "Claude CLI credential input is no longer available",
    );
  });
});
