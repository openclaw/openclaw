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
const backend = buildAnthropicCliBackend();

type Backend = ReturnType<typeof buildAnthropicCliBackend>;
type PrepareContext = Parameters<NonNullable<Backend["prepareExecution"]>>[0];
type Credential =
  | { type: "oauth"; provider: string; access: string; refresh: string; expires: number }
  | { type: "token"; provider: string; token: string }
  | { type: "api_key"; provider: string; key: string };
const oauth = (expires = Date.now() + 60_000): Credential => ({
  type: "oauth",
  provider: "claude-cli",
  access: "selected-access-token",
  refresh: "selected-refresh-token",
  expires,
});
const token = (value: string): Credential => ({
  type: "token",
  provider: "claude-cli",
  token: value,
});

function expectSecret(prepared: ClaudePreparedExecutionWithSecret, envName: string, value: string) {
  expect(prepared.env).toEqual({
    CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
    [envName]: "3",
  });
  expect(prepared.env).not.toHaveProperty("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB");
  expect(prepared.secretInput.fingerprint).not.toContain(value);
  expect(prepared.secretInput.createData().toString("utf8")).toBe(value);
}

async function expectSecretDestroyed(prepared: ClaudePreparedExecutionWithSecret) {
  await prepared.cleanup?.();
  expect(() => prepared.secretInput.createData()).toThrow(
    "Claude CLI credential input is no longer available",
  );
}
function prepare(
  adapter: Backend,
  overrides: Partial<PrepareContext> & {
    authCredential?: Credential;
    isolatedCompletionPrompt?: string;
    isolatedCompletionSystemPrompt?: string;
  } = {},
) {
  return adapter.prepareExecution?.({
    workspaceDir: "/tmp/openclaw-claude-cli",
    provider: "claude-cli",
    modelId: "claude-opus-4-7",
    ...overrides,
  });
}

function prepareSecret(authCredential: Credential, authProfileId?: string) {
  return prepare(backend, { authCredential, authProfileId }) as ClaudePreparedExecutionWithSecret;
}

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

function backendArgs(adapter: Backend) {
  return adapter.resolveExecutionArgs?.({
    workspaceDir: "/tmp",
    provider: "claude-cli",
    modelId: "claude-haiku-4-5",
    useResume: false,
    baseArgs: adapter.config.args ?? [],
  });
}

describe("Claude CLI adapter equivalence", () => {
  const commonArgs = argv(
    "-p --output-format stream-json --include-partial-messages --verbose",
    "--setting-sources user --allowedTools mcp__openclaw__* --disallowedTools",
    CLAUDE_CLI_DISALLOWED_TOOLS,
  );

  it("disables native Bash while retaining native denials for managed shell turns", () => {
    for (const baseArgs of [commonArgs, [...commonArgs, "--resume", "session"]]) {
      const args = executionArgs({
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
    const prepared = prepare(backend, {
      modelId: "claude-opus-4-8",
      isolatedCompletionPrompt: "TASK: return JSON",
      isolatedCompletionSystemPrompt: "Return JSON.",
    });

    expect(prepared).toEqual({
      env: { CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1" },
      isolatedCompletionEnforced: true,
    });
  });

  it("builds Claude Code's native manual compaction command", () => {
    const manualCompaction = backend.manualCompaction;
    // Redacted fixtures preserve the control fields observed from Claude Code 2.0.76-2.1.226.
    const compactingStatus = { type: "system", subtype: "status", status: "compacting" };
    const compactResult = { compact_result: "success" };
    const compactBoundary = { type: "system", subtype: "compact_boundary" };
    const validate = (events: Record<string, unknown>[], suffix = "\n") =>
      manualCompaction?.validateOutput(
        events.map((event) => JSON.stringify(event)).join("\n") + suffix,
      );

    expect(manualCompaction?.buildPrompt()).toBe("/compact");
    expect(manualCompaction?.buildPrompt(" keep operator decisions ")).toBe(
      "/compact keep operator decisions",
    );
    expect(manualCompaction?.input).toBe("arg");
    expect(validate([compactingStatus, compactResult, compactBoundary], "")).toEqual({ ok: true });
    expect(validate([compactResult])).toEqual({ ok: true });
    expect(validate([compactBoundary])).toEqual({ ok: true });
    expect(validate([compactingStatus, { type: "system", subtype: "local_command" }])).toEqual({
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
      const normalized = normalizeClaudeBackendConfig(backend.config);
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
    expect(backend.config.systemPromptWhen).toBe("always");
    const manualCompaction = backend.manualCompaction;
    const baseArgs = backend.config.resumeArgs?.map((arg) =>
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

function registeredBackend(
  readRuntime: () => {
    system: {
      runCommandWithTimeout: () => Promise<{ code: number; stdout: string; stderr: string }>;
    };
  },
) {
  const registerCliBackend = vi.fn();
  const registerHook = vi.fn();
  registerAnthropicPlugin({
    pluginConfig: { sessionCatalog: { enabled: false } },
    get runtime() {
      return readRuntime();
    },
    registerCliBackend,
    registerHook,
    registerProvider: vi.fn(),
    registerMediaUnderstandingProvider: vi.fn(),
    registerNodeInvokePolicy: vi.fn(),
  } as unknown as Parameters<typeof registerAnthropicPlugin>[0]);
  return { backend: registerCliBackend.mock.calls[0]?.[0] as Backend, registerHook };
}

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
    expect(unsupported.config.args).not.toContain(CLAUDE_CACHE_FLAG);
    expect(backendArgs(unsupported)).not.toContain(CLAUDE_CACHE_FLAG);
    expect(backendArgs(supported)).toContain(CLAUDE_CACHE_FLAG);
  });

  it("defers one shared Claude version probe until execution and awaits it before preparing argv", async () => {
    const version = createDeferred<{ code: number; stdout: string; stderr: string }>();
    const runCommandWithTimeout = vi.fn(() => version.promise);
    const readRuntime = vi.fn(() => ({ system: { runCommandWithTimeout } }));
    const { backend: adapter, registerHook } = registeredBackend(readRuntime);
    expect(readRuntime).not.toHaveBeenCalled();
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
    const prepared = vi.fn();
    const executions = [
      Promise.resolve(prepare(adapter)).then(prepared),
      Promise.resolve(prepare(adapter)).then(prepared),
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
    expect(backendArgs(adapter)).toContain(CLAUDE_CACHE_FLAG);
    await prepare(adapter);
    expect(runCommandWithTimeout).toHaveBeenCalledOnce();
  });

  it("keeps the established argv when the version probe fails", async () => {
    const runCommandWithTimeout = vi.fn().mockRejectedValue(new Error("claude is unavailable"));
    const { backend: adapter } = registeredBackend(() => ({ system: { runCommandWithTimeout } }));
    await prepare(adapter);
    expect(runCommandWithTimeout).toHaveBeenCalledOnce();
    expect(backendArgs(adapter)).not.toContain(CLAUDE_CACHE_FLAG);
  });

  it("leaves claude cli subscription-managed, restricts setting sources, and clears inherited env overrides", () => {
    expect(backend.config.env).toBeUndefined();
    expect(backend).toMatchObject({
      autoSelectAuthProfile: false,
      nativeToolMode: "selectable",
      config: { liveSession: "claude-stdio", output: "jsonl", input: "stdin" },
    });
    for (const args of [backend.config.args, backend.config.resumeArgs]) {
      expect(args).toEqual(expect.arrayContaining(["--setting-sources", "user"]));
      expect(args).not.toContain(CLAUDE_CACHE_FLAG);
      expectDefaultDisallowedTools(args);
    }
    expect(backend.config.clearEnv).toEqual([...CLAUDE_CLI_CLEAR_ENV]);
    expect(backend.config.clearEnv).not.toContain("CLAUDE_CONFIG_DIR");
    expect(backend.config.clearEnv).toEqual(
      expect.arrayContaining(
        argv(
          "ANTHROPIC_API_TOKEN ANTHROPIC_BASE_URL ANTHROPIC_CUSTOM_HEADERS ANTHROPIC_OAUTH_TOKEN",
          "CLAUDE_CODE_AUTO_COMPACT_WINDOW CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_OAUTH_TOKEN",
          "CLAUDE_CODE_PLUGIN_CACHE_DIR CLAUDE_CODE_PLUGIN_SEED_DIR CLAUDE_CODE_REMOTE",
          "CLAUDE_CODE_USE_COWORK_PLUGINS OTEL_METRICS_EXPORTER OTEL_EXPORTER_OTLP_PROTOCOL",
          "OTEL_SDK_DISABLED",
        ),
      ),
    );
  });

  it("passes the effective context budget to Claude Code's native compactor", () => {
    expect(prepare(backend, { contextTokenBudget: 100_000 })).toEqual({
      env: {
        CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: "100000",
      },
    });
  });

  it("forwards the selected OAuth profile through Claude's private descriptor", async () => {
    const prepared = prepareSecret(oauth(), "anthropic:claude-cli");

    expectSecret(prepared, "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "selected-access-token");
    expect(prepared.env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(prepared.clearEnv).toEqual([...CLAUDE_CLI_CLEAR_ENV]);
    expect(prepared.secretInput.fd).toBe(3);

    const sameToken = prepareSecret(token("selected-access-token"));
    const rotatedToken = prepareSecret(token("rotated-access-token"));
    expect(sameToken.secretInput.fingerprint).toBe(prepared.secretInput.fingerprint);
    expect(rotatedToken.secretInput.fingerprint).not.toBe(prepared.secretInput.fingerprint);

    await expectSecretDestroyed(prepared);
    await sameToken.cleanup?.();
    await rotatedToken.cleanup?.();
  });

  it("does not forward an expired selected OAuth profile", () => {
    expect(() =>
      prepare(backend, {
        authProfileId: "anthropic:claude-cli",
        authCredential: oauth(Date.now() - 60_000),
      }),
    ).toThrow("Selected Claude CLI OAuth credential is expired or invalid");
  });

  it("runs native Claude login through the CLI transport without forwarding credentials", () => {
    const prepared = prepare(backend, { executionMode: "agent" });

    expect(prepared).toEqual(expect.objectContaining({ execute: expect.any(Function) }));
    expect(prepared).not.toHaveProperty("secretInput");
    expect(prepared).not.toHaveProperty("env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR");
    expect(prepared).not.toHaveProperty("env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR");
  });

  it("forwards a selected API-key profile through Claude's private descriptor", async () => {
    const prepared = prepareSecret(
      { type: "api_key", provider: "claude-cli", key: "selected-api-key" },
      "claude-cli:api",
    );

    expectSecret(prepared, "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR", "selected-api-key");
    expect(prepared.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    await expectSecretDestroyed(prepared);
  });
});
