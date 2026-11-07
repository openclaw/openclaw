import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import type { OpenClawPluginApi, ProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { runCommandWithTimeout as runFixtureCommand } from "openclaw/plugin-sdk/process-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commandResult } from "../test-support/command-result.test-support.js";
import { makeModel } from "./model-contract-cases.test-support.js";
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
const model = makeModel("claude-fable-5-1");
const context = {
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
} satisfies Parameters<StreamFn>[1];
const oauthOptions = { apiKey: "sk-ant-oat01-synthetic", headers: { "x-test": "preserved" } };
let cliDirectory: string;
let cliPath: string;

function writeCli(version: string, target = cliPath) {
  writeFileSync(target, `process.stdout.write(${JSON.stringify(version)});\n`, { mode: 0o700 });
}

const executionContext = { workspaceDir: "/synthetic", provider: "claude-cli", modelId: model.id };

function register(
  runCommandWithTimeout = vi
    .fn<CommandRunner>()
    .mockResolvedValue(commandResult({ stdout: "2.1.400 (Claude Code)" })),
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
  return {
    provider,
    readRuntime,
    runCommandWithTimeout,
    prepare: () => backend.prepareExecutionV2?.(executionContext),
    args: () =>
      backend.resolveExecutionArgs?.({
        ...executionContext,
        useResume: false,
        baseArgs: backend.config.args ?? [],
      }),
  };
}

function capture(
  provider: ProviderPlugin,
  hook: WrapperHook = "wrapStreamFn",
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
    wrapper,
    headers: (index = 0) => base.mock.calls[index]?.[2]?.headers,
    run: (options: Parameters<StreamFn>[2] = oauthOptions) =>
      wrapper(dispatchModel, context, options),
  };
}

beforeEach(() => {
  const tmp = path.join(process.cwd(), "tmp");
  mkdirSync(tmp, { recursive: true });
  cliDirectory = mkdtempSync(path.join(tmp, "anthropic-cli-version-"));
  cliPath = path.join(cliDirectory, "claude.cjs");
  writeCli("2.1.400 (Claude Code)");
  utimesSync(cliPath, 1_000_000, 1_000_000);
  vi.mocked(resolveClaudeTerminalExecutable).mockReset().mockReturnValue({ executable: cliPath });
  vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
});
afterEach(() => {
  rmSync(cliDirectory, { recursive: true, force: true });
  vi.useRealTimers();
  vi.unstubAllEnvs();
  subsystemLogMock.warn.mockClear();
  subsystemLogMock.verbose.mockClear();
});

it.each([
  ["missing", "2.1.281", "executable-missing"],
  ["command failure", "2.1.400", "probe-error"],
  ["unparseable output", "unrecognized output", "unparseable-output"],
  ["output-limit", "2.1.400", undefined],
  ["prerelease", "2.1.400-beta.1 (Claude Code)", undefined],
])("preserves and caches the transport floor after %s (#157541)", async (mode, stdout, warning) => {
  const runner = vi
    .fn<CommandRunner>()
    .mockResolvedValue(
      commandResult({ stdout: stdout ?? "", outputLimitExceeded: mode === "output-limit" }),
    );
  if (mode === "missing") {
    vi.mocked(resolveClaudeTerminalExecutable).mockReturnValue(undefined);
  } else if (mode === "command failure") {
    runner.mockRejectedValue(new Error("synthetic launch failure"));
  }
  const fixture = register(runner);
  const request = capture(fixture.provider);
  await request.run();
  await request.run();
  expect(request.headers()).toEqual(oauthOptions.headers);
  expect(request.headers(1)).toEqual(oauthOptions.headers);
  expect(runner).toHaveBeenCalledTimes(mode === "missing" ? 0 : 1);
  await fixture.prepare();
  expect(fixture.args()).not.toContain("--exclude-dynamic-system-prompt-sections");
  if (warning) {
    const message = String(subsystemLogMock.warn.mock.calls[0]?.[0]);
    expect(message).toContain(warning);
    // Diagnostics must never expose subprocess output or raw exception text.
    expect(message).not.toMatch(/synthetic launch failure|unrecognized output/);
  }
});

it("does not probe or alter another provider's identity", async () => {
  const fixture = register();
  const request = capture(fixture.provider, undefined, {
    ...model,
    provider: "github-copilot",
  });
  const options = {
    apiKey: oauthOptions.apiKey,
    headers: { "user-agent": "existing-client" },
  };
  await request.run(options);
  expect(request.headers()).toEqual(options.headers);
  expect(fixture.readRuntime).not.toHaveBeenCalled();
  expect(resolveClaudeTerminalExecutable).not.toHaveBeenCalled();
});

it("shares lazy CLI discovery across native execution and both OAuth wrappers", async () => {
  const pending = createDeferred<CommandResult>();
  const started = createDeferred<void>();
  const fixture = register(
    vi.fn<CommandRunner>(() => {
      started.resolve();
      return pending.promise;
    }),
  );
  await fixture.provider.staticCatalog?.run({
    config: {},
    env: {},
    resolveProviderApiKey: () => ({ apiKey: undefined }),
    resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
  });
  expect(fixture.readRuntime).not.toHaveBeenCalled();
  const normal = capture(fixture.provider);
  const simple = capture(fixture.provider, "wrapSimpleCompletionStreamFn");
  const prepared = vi.fn();
  const executions = [
    Promise.resolve(normal.run()),
    Promise.resolve(simple.run()),
    ...[fixture.prepare(), fixture.prepare()].map((result) =>
      Promise.resolve(result).then(prepared),
    ),
  ];
  await started.promise;
  expect(fixture.runCommandWithTimeout).toHaveBeenCalledOnce();
  expect(normal.base).not.toHaveBeenCalled();
  expect(simple.base).not.toHaveBeenCalled();
  expect(prepared).not.toHaveBeenCalled();
  pending.resolve(commandResult({ stdout: "2.1.400 (Claude Code)" }));
  await Promise.all(executions);
  expect(prepared).toHaveBeenCalledTimes(2);
  expect(normal.headers()).toEqual({
    ...oauthOptions.headers,
    "user-agent": "claude-cli/2.1.400",
  });
  expect(simple.headers()?.["user-agent"]).toBe("claude-cli/2.1.400");
  expect(fixture.args()).toContain("--exclude-dynamic-system-prompt-sections");
});

it("bounds requests even while process cleanup is pending and caches the fallback", async () => {
  vi.useFakeTimers();
  const pending = createDeferred<CommandResult>();
  const started = createDeferred<void>();
  const runner = vi.fn<CommandRunner>(() => {
    started.resolve();
    return pending.promise;
  });
  const fixture = register(runner);
  const request = capture(fixture.provider);
  const response = request.run();
  await started.promise;
  await vi.advanceTimersByTimeAsync(1_499);
  expect(request.base).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await response;
  expect(request.headers()).toEqual(oauthOptions.headers);
  await request.run();
  expect(runner).toHaveBeenCalledOnce();
  pending.resolve(commandResult({ stdout: "2.1.400 (Claude Code)" }));
  await request.run();
  expect(request.headers(2)).toEqual(oauthOptions.headers);
});

it("recognizes environment OAuth credentials while an explicit API key wins", async () => {
  vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", oauthOptions.apiKey);
  const fixture = register();
  const request = capture(fixture.provider, "wrapSimpleCompletionStreamFn");
  await request.run({ apiKey: "sk-ant-api-synthetic", headers: oauthOptions.headers });
  expect(fixture.runCommandWithTimeout).not.toHaveBeenCalled();
  await request.wrapper(model, context);
  expect(request.headers(1)?.["user-agent"]).toBe("claude-cli/2.1.400");
});

// Windows file symlinks require privileges unavailable on some CI runners.
it.each(process.platform === "win32" ? ["mtime", "size"] : ["mtime", "size", "realpath"])(
  "refreshes OAuth identity after a CLI %s change without restarting",
  async (change) => {
    if (change === "realpath") {
      const original = path.join(cliDirectory, "original.cjs");
      writeCli("2.1.400 (Claude Code)", original);
      utimesSync(original, 1_000_000, 1_000_000);
      unlinkSync(cliPath);
      symlinkSync(original, cliPath);
    }
    const runner = vi.fn<CommandRunner>((argv, options) =>
      runFixtureCommand([process.execPath, ...argv], options),
    );
    const fixture = register(runner);
    const normal = capture(fixture.provider);
    const simple = capture(fixture.provider, "wrapSimpleCompletionStreamFn");
    await normal.run();
    await simple.run();
    expect(normal.headers()?.["user-agent"]).toBe("claude-cli/2.1.400");
    expect(runner).toHaveBeenCalledOnce();
    const originalStat = statSync(cliPath);
    if (change === "realpath") {
      const replacement = path.join(cliDirectory, "replacement.cjs");
      writeCli("2.1.401 (Claude Code)", replacement);
      utimesSync(replacement, originalStat.atime, originalStat.mtime);
      unlinkSync(cliPath);
      symlinkSync(replacement, cliPath);
    } else {
      writeCli(change === "size" ? "2.1.401 (Claude Code)\n" : "2.1.401 (Claude Code)");
      utimesSync(
        cliPath,
        originalStat.atime,
        change === "size" ? originalStat.mtime : new Date(originalStat.mtimeMs + 2_000),
      );
    }
    await simple.run();
    await normal.run();
    expect(simple.headers(1)?.["user-agent"]).toBe("claude-cli/2.1.401");
    expect(normal.headers(1)?.["user-agent"]).toBe("claude-cli/2.1.401");
    expect(runner).toHaveBeenCalledTimes(2);
  },
);

it("uses the transport floor after a failed replacement and recovers when the CLI changes again", async () => {
  const runner = vi.fn<CommandRunner>((argv, options) =>
    runFixtureCommand([process.execPath, ...argv], options),
  );
  const fixture = register(runner);
  const request = capture(fixture.provider);
  await request.run();
  expect(request.headers()?.["user-agent"]).toBe("claude-cli/2.1.400");
  writeCli("unrecognized replacement output");
  await request.run();
  await fixture.prepare();
  expect(request.headers(1)).toEqual(oauthOptions.headers);
  expect(fixture.args()).not.toContain("--exclude-dynamic-system-prompt-sections");
  expect(runner).toHaveBeenCalledTimes(2);
  writeCli("2.1.402 (Claude Code)");
  await request.run();
  expect(request.headers(2)?.["user-agent"]).toBe("claude-cli/2.1.402");
  expect(runner).toHaveBeenCalledTimes(3);
});
