import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import type { OpenClawPluginApi, ProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAnthropicPlugin } from "./register.runtime.js";
import { resolveClaudeTerminalExecutable } from "./session-catalog-executable.js";

vi.mock("./session-catalog-executable.js", () => ({
  resolveClaudeTerminalExecutable: vi.fn(),
}));

const subsystemLogMock = vi.hoisted(() => ({ warn: vi.fn(), verbose: vi.fn() }));

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>()),
  createSubsystemLogger: vi.fn(() => subsystemLogMock),
}));

type CommandRunner = OpenClawPluginApi["runtime"]["system"]["runCommandWithTimeout"];
type CommandResult = Awaited<ReturnType<CommandRunner>>;
type WrapperHook = "wrapStreamFn" | "wrapSimpleCompletionStreamFn";
const model = {
  id: "claude-fable-5-1",
  name: "Claude Fable 5.1",
  provider: "anthropic",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
} satisfies Parameters<StreamFn>[0];
const context = {
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
} satisfies Parameters<StreamFn>[1];
const oauthOptions = { apiKey: "sk-ant-oat01-synthetic", headers: { "x-test": "preserved" } };

function versionResult(stdout: string, overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    stdout,
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
    ...overrides,
  };
}

function register(
  runCommandWithTimeout = vi
    .fn<CommandRunner>()
    .mockResolvedValue(versionResult("2.1.400 (Claude Code)")),
) {
  const registerProvider = vi.fn<OpenClawPluginApi["registerProvider"]>();
  const registerCliBackend = vi.fn<OpenClawPluginApi["registerCliBackend"]>();
  const api = createTestPluginApi({
    pluginConfig: { sessionCatalog: { enabled: false } },
    registerProvider,
    registerCliBackend,
  });
  const readRuntime = vi.fn(() => ({ system: { runCommandWithTimeout } }));
  Object.defineProperty(api, "runtime", { get: readRuntime });
  registerAnthropicPlugin(api);
  const provider = registerProvider.mock.calls[0]?.[0];
  const backend = registerCliBackend.mock.calls[0]?.[0];
  if (!provider || !backend) {
    throw new Error("Missing Anthropic registration");
  }
  return { provider, backend, readRuntime, runCommandWithTimeout };
}

function capture(
  provider: ProviderPlugin,
  hook: WrapperHook,
  target: Parameters<StreamFn>[0] = model,
) {
  const stream = createAssistantMessageEventStream();
  const base = vi.fn<StreamFn>(() => stream);
  const wrapper = provider[hook]?.({
    provider: target.provider,
    modelId: target.id,
    sourceApi: target.api,
    streamFn: base,
  });
  if (!wrapper) {
    throw new Error(`Missing ${hook}`);
  }
  // Direct completion invokes the registered wrapper with an internal dispatch alias.
  const dispatchModel =
    hook === "wrapSimpleCompletionStreamFn"
      ? { ...target, api: "openclaw-provider-simple:anthropic" }
      : target;
  return {
    base,
    run: (options: Parameters<StreamFn>[2] = oauthOptions) =>
      wrapper(dispatchModel, context, options),
  };
}

beforeEach(() => {
  vi.mocked(resolveClaudeTerminalExecutable)
    .mockReset()
    .mockReturnValue({ executable: "/synthetic/claude" });
  vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  subsystemLogMock.warn.mockClear();
  subsystemLogMock.verbose.mockClear();
});

describe("Claude version probe failure diagnostics (#157541)", () => {
  it.each([
    {
      mode: "missing executable",
      setup: () => {
        vi.mocked(resolveClaudeTerminalExecutable).mockReturnValue(undefined);
        return vi.fn<CommandRunner>().mockResolvedValue(versionResult("2.1.281"));
      },
      expectWarn: "executable-missing",
    },
    {
      mode: "command failure",
      setup: () => vi.fn<CommandRunner>().mockRejectedValue(new Error("synthetic launch failure")),
      expectWarn: "probe-error",
    },
    {
      mode: "unparseable output",
      setup: () => vi.fn<CommandRunner>().mockResolvedValue(versionResult("unrecognized output")),
      expectWarn: "unparseable-output",
    },
  ])("warns with cause when probe fails: $mode", async ({ setup, expectWarn }) => {
    const fixture = register(setup());
    const request = capture(fixture.provider, "wrapStreamFn");
    await request.run();
    // The request still goes through without identity (transport floor intact),
    // but the failure must be visible instead of silent.
    expect(request.base.mock.calls[0]?.[2]?.headers).toEqual(oauthOptions.headers);
    expect(subsystemLogMock.warn).toHaveBeenCalledOnce();
    expect(subsystemLogMock.warn.mock.calls[0]?.[0]).toEqual(expect.stringContaining(expectWarn));
    // Security: warnings carry only bounded failure categories, never raw
    // subprocess output or error text that could hold private paths/values.
    for (const call of subsystemLogMock.warn.mock.calls) {
      expect(String(call[0])).not.toContain("synthetic launch failure");
      expect(String(call[0])).not.toContain("unrecognized output");
    }
  });
});

describe.each(["wrapStreamFn", "wrapSimpleCompletionStreamFn"] as const)(
  "Claude version through %s",
  (hook) => {
    it.each([
      ["2.1.400 (Claude Code)", "claude-cli/2.1.400"],
      ["Claude Code 2.1.75", "claude-cli/2.1.75"],
      ["2.1.400-beta.1 (Claude Code)", undefined],
      ["unrecognized output", undefined],
    ])("publishes only stable installed version evidence from %s", async (stdout, identity) => {
      const fixture = register(vi.fn<CommandRunner>().mockResolvedValue(versionResult(stdout)));
      const request = capture(fixture.provider, hook);
      await request.run();
      expect(request.base.mock.calls[0]?.[2]?.headers).toEqual({
        "x-test": "preserved",
        ...(identity ? { "user-agent": identity } : {}),
      });
      await request.run();
      expect(fixture.runCommandWithTimeout).toHaveBeenCalledOnce();
    });

    it.each(["failure", "missing", "output-limit"] as const)(
      "leaves the transport floor intact after %s",
      async (mode) => {
        const runner = vi
          .fn<CommandRunner>()
          .mockResolvedValue(versionResult("2.1.400", { outputLimitExceeded: true }));
        if (mode === "failure") {
          runner.mockRejectedValue(new Error("synthetic launch failure"));
        }
        if (mode === "missing") {
          vi.mocked(resolveClaudeTerminalExecutable).mockReturnValue(undefined);
        }
        const fixture = register(runner);
        const request = capture(fixture.provider, hook);
        await request.run();
        await request.run();
        expect(request.base.mock.calls.map((call) => call[2]?.headers)).toEqual([
          oauthOptions.headers,
          oauthOptions.headers,
        ]);
        expect(runner).toHaveBeenCalledTimes(mode === "missing" ? 0 : 1);
        expect(resolveClaudeTerminalExecutable).toHaveBeenCalledOnce();
      },
    );

    it.each(["anthropic", "github-copilot", "microsoft-foundry", "cloudflare-ai-gateway"])(
      "does not probe or alter identity on the %s non-OAuth route",
      async (provider) => {
        const fixture = register();
        const request = capture(fixture.provider, hook, { ...model, provider });
        const options = {
          apiKey: provider === "anthropic" ? "sk-ant-api-synthetic" : oauthOptions.apiKey,
          headers: { "user-agent": "existing-client" },
        };
        await request.run(options);
        expect(request.base.mock.calls[0]?.[2]?.headers).toEqual(options.headers);
        expect(fixture.readRuntime).not.toHaveBeenCalled();
        expect(resolveClaudeTerminalExecutable).not.toHaveBeenCalled();
      },
    );
  },
);

it("shares lazy CLI discovery across native execution and both OAuth wrappers", async () => {
  const pending = createDeferred<CommandResult>();
  const fixture = register(vi.fn<CommandRunner>(() => pending.promise));
  await fixture.provider.staticCatalog?.run({
    config: {},
    env: {},
    resolveProviderApiKey: () => ({ apiKey: undefined }),
    resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
  });
  expect(fixture.readRuntime).not.toHaveBeenCalled();
  const normal = capture(fixture.provider, "wrapStreamFn");
  const simple = capture(fixture.provider, "wrapSimpleCompletionStreamFn");
  const executions = [
    normal.run(),
    simple.run(),
    fixture.backend.prepareExecution?.({
      workspaceDir: "/synthetic",
      provider: "claude-cli",
      modelId: model.id,
    }),
  ].map((execution) => Promise.resolve(execution));
  await Promise.resolve();
  expect(fixture.runCommandWithTimeout).toHaveBeenCalledOnce();
  expect(resolveClaudeTerminalExecutable).toHaveBeenCalledWith(process.env, {
    pathStrategy: "direct",
  });
  expect(normal.base).not.toHaveBeenCalled();
  expect(simple.base).not.toHaveBeenCalled();
  pending.resolve(versionResult("2.1.400 (Claude Code)"));
  await Promise.all(executions);
  expect(normal.base.mock.calls[0]?.[2]?.headers?.["user-agent"]).toBe("claude-cli/2.1.400");
  expect(simple.base.mock.calls[0]?.[2]?.headers?.["user-agent"]).toBe("claude-cli/2.1.400");
  expect(
    fixture.backend.resolveExecutionArgs?.({
      workspaceDir: "/synthetic",
      provider: "claude-cli",
      modelId: model.id,
      useResume: false,
      baseArgs: fixture.backend.config.args ?? [],
    }),
  ).toContain("--exclude-dynamic-system-prompt-sections");
});

it("bounds requests even while process cleanup is pending and caches the fallback", async () => {
  vi.useFakeTimers();
  const pending = createDeferred<CommandResult>();
  const runner = vi.fn<CommandRunner>(() => pending.promise);
  const fixture = register(runner);
  const request = capture(fixture.provider, "wrapStreamFn");
  const response = request.run();
  await vi.advanceTimersByTimeAsync(1_499);
  expect(request.base).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await response;
  expect(request.base.mock.calls[0]?.[2]?.headers).toEqual(oauthOptions.headers);
  expect(runner).toHaveBeenCalledWith(["/synthetic/claude", "--version"], {
    timeoutMs: 1_500,
    killProcessTree: true,
    killGraceMs: 100,
    maxOutputBytes: { stdout: 1_024, stderr: 1_024 },
    terminateOnOutputLimit: true,
  });
  await request.run();
  expect(runner).toHaveBeenCalledOnce();
  pending.resolve(versionResult("2.1.400 (Claude Code)"));
  await request.run();
  expect(request.base.mock.calls[2]?.[2]?.headers).toEqual(oauthOptions.headers);
});

it("recognizes environment OAuth credentials while an explicit API key wins", async () => {
  vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", oauthOptions.apiKey);
  const fixture = register();
  const request = capture(fixture.provider, "wrapSimpleCompletionStreamFn");
  await request.run({ apiKey: "sk-ant-api-synthetic", headers: oauthOptions.headers });
  expect(fixture.runCommandWithTimeout).not.toHaveBeenCalled();
  const wrapper = fixture.provider.wrapSimpleCompletionStreamFn?.({
    provider: model.provider,
    modelId: model.id,
    sourceApi: model.api,
    streamFn: request.base,
  });
  await wrapper?.(model, context);
  expect(request.base.mock.calls[1]?.[2]?.headers?.["user-agent"]).toBe("claude-cli/2.1.400");
});
