import { expectDefined } from "@openclaw/normalization-core";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecuteNodeHostCommandParams } from "./bash-tools.exec-host-node.types.js";
import { createRunExit } from "./bash-tools.exec-runtime.test-support.js";
import type { BashSandboxConfig } from "./bash-tools.shared.js";
import type { ExtensionContext } from "./sessions/index.js";
import type { AnyAgentTool } from "./tools/common.js";

declare module "../plugins/hook-types.js" {
  interface PluginHookChannelSenderContext {
    unionId?: string;
  }
}

const CHANNEL_CONTEXT_ENV_KEY = "OPENCLAW_CHANNEL_CONTEXT";
const OPENCLAW_CLI_ENV_VALUE = "1";
type CapturedNodeHostParams = Pick<
  ExecuteNodeHostCommandParams,
  "env" | "requestedEnv" | "workdir"
>;

const mocks = vi.hoisted(() => ({
  hookRunner: undefined as
    | {
        hasHooks: ReturnType<typeof vi.fn>;
        runResolveExecEnv?: ReturnType<typeof vi.fn>;
        runBeforeToolCall?: ReturnType<typeof vi.fn>;
      }
    | undefined,
  beforeToolCallParams: [] as Array<Record<string, unknown>>,
  gatewayParams: [] as Array<{
    env: Record<string, string>;
    requestedEnv?: Record<string, string>;
  }>,
  nodeHostParams: [] as CapturedNodeHostParams[],
  spawnInputs: [] as Array<{
    env?: Record<string, string>;
  }>,
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => mocks.hookRunner,
  getGlobalHookRunnerRegistry: () => null,
}));

vi.mock("../infra/shell-env.js", () => ({
  getShellEnvAppliedKeys: vi.fn(() => []),
  getShellPathFromLoginShell: vi.fn(() => null),
  resolveShellEnvFallbackTimeoutMs: vi.fn(() => 0),
  shouldDeferShellEnvFallback: vi.fn(() => false),
  shouldEnableShellEnvFallback: vi.fn(() => false),
}));

vi.mock("./bash-tools.exec-host-gateway.js", () => ({
  processGatewayAllowlist: vi.fn(
    async (params: { env: Record<string, string>; requestedEnv?: Record<string, string> }) => {
      mocks.gatewayParams.push({
        env: { ...params.env },
        requestedEnv: params.requestedEnv ? { ...params.requestedEnv } : undefined,
      });
      return {};
    },
  ),
}));

vi.mock("./bash-tools.exec-host-node.js", () => ({
  executeNodeHostCommand: vi.fn(
    async (params: Pick<ExecuteNodeHostCommandParams, "env" | "requestedEnv" | "workdir">) => {
      mocks.nodeHostParams.push({
        env: { ...params.env },
        requestedEnv: params.requestedEnv ? { ...params.requestedEnv } : undefined,
        workdir: params.workdir,
      });
      return {
        content: [{ type: "text", text: "node ok" }],
        details: {
          status: "completed",
          exitCode: 0,
          durationMs: 0,
          aggregated: "node ok",
        },
      };
    },
  ),
}));

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({
    spawn: async (input: { env?: Record<string, string>; onStdout?: (chunk: string) => void }) => {
      mocks.spawnInputs.push({ env: input.env ? { ...input.env } : undefined });
      input.onStdout?.("ok\n");
      return {
        activity: { resultSettled: true, lastOutputAtMs: Date.now() },
        runId: "mock-run",
        startedAtMs: Date.now(),
        stdin: undefined,
        wait: async () => createRunExit({ durationMs: 0 }),
        cancel: vi.fn(),
      };
    },
    cancel: vi.fn(),
    cancelScope: vi.fn(),
  }),
}));

let createExecTool: typeof import("./bash-tools.exec-run.js").createExecTool;
let toToolDefinitions: typeof import("./agent-tool-definition-adapter.js").toToolDefinitions;
let createOpenClawCodingTools: typeof import("./agent-tools.js").createOpenClawCodingTools;
const testExtensionContext = {} as ExtensionContext;

function createTestExecTool(options: Parameters<typeof createExecTool>[0]) {
  return createExecTool({ security: "full", ask: "off", ...options });
}

function backendSandboxConfig(overrides: Partial<BashSandboxConfig>): BashSandboxConfig {
  return {
    containerName: "remote-sandbox-workdir-test",
    workspaceDir: process.cwd(),
    containerWorkdir: "/remote/workspace",
    workdirValidation: "backend",
    ...overrides,
  };
}

function installResolveExecEnvHook(result: Record<string, string>) {
  mocks.hookRunner = {
    hasHooks: vi.fn((hookName: string) => hookName === "resolve_exec_env"),
    runResolveExecEnv: vi.fn(async () => result),
  };
}

function executeWrapped(
  tool: AnyAgentTool,
  params: Record<string, unknown>,
  context: Parameters<typeof toToolDefinitions>[1] = {
    agentId: "main",
    sessionKey: "agent:main:telegram:chat-1",
  },
) {
  const [definition] = toToolDefinitions([tool], context);
  return expectDefined(definition, "definition test invariant").execute(
    "wrapped-call",
    params,
    undefined,
    undefined,
    testExtensionContext,
  );
}

function installWrappedHooks(
  runBeforeToolCall: ReturnType<typeof vi.fn> = vi.fn(async () => undefined),
  runResolveExecEnv: ReturnType<typeof vi.fn> = vi.fn(async () => ({ PLUGIN_SAFE: "yes" })),
) {
  const hooks = {
    hasHooks: vi.fn((name: string) => name === "resolve_exec_env" || name === "before_tool_call"),
    runResolveExecEnv,
    runBeforeToolCall,
  };
  mocks.hookRunner = hooks;
  return hooks;
}

describe("exec resolve_exec_env hook wiring", () => {
  beforeAll(async () => {
    ({ createExecTool } = await import("./bash-tools.exec-run.js"));
    ({ toToolDefinitions } = await import("./agent-tool-definition-adapter.js"));
    ({ createOpenClawCodingTools } = await import("./agent-tools.js"));
  });

  beforeEach(() => {
    mocks.hookRunner = undefined;
    mocks.beforeToolCallParams.length = 0;
    mocks.gatewayParams.length = 0;
    mocks.nodeHostParams.length = 0;
    mocks.spawnInputs.length = 0;
  });

  it("merges filtered plugin env into gateway execution and approval-visible requested env", async () => {
    installResolveExecEnvHook({
      EXISTING: "plugin",
      PLUGIN_SAFE: "yes",
      PATH: "/tmp/plugin-bin",
      NODE_OPTIONS: "--require /tmp/hook.js",
      OPENCLAW_CLI: "0",
      "bad-key": "bad",
    });

    const tool = createTestExecTool({
      host: "auto",
      sessionKey: "agent:main:telegram:chat-1",
      sessionId: "session-1",
      messageProvider: "telegram",
      currentChannelId: "chat-1",
      channelContext: {
        sender: { id: "ou_1", unionId: "on_1" },
        chat: { id: "oc_1" },
      },
    });
    await tool.execute("call-1", {
      command: "echo ok",
      env: { EXISTING: "request" },
      yieldMs: 120_000,
    });

    expect(mocks.hookRunner?.runResolveExecEnv).toHaveBeenCalledWith(
      {
        sessionKey: "agent:main:telegram:chat-1",
        toolName: "exec",
        host: "gateway",
      },
      {
        agentId: "main",
        sessionKey: "agent:main:telegram:chat-1",
        sessionId: "session-1",
        messageProvider: "telegram",
        channelId: "chat-1",
        channelContext: {
          sender: { id: "ou_1", unionId: "on_1" },
          chat: { id: "oc_1" },
        },
      },
    );
    for (const env of [
      mocks.gatewayParams[0]?.requestedEnv,
      mocks.gatewayParams[0]?.env,
      mocks.spawnInputs[0]?.env,
    ]) {
      expect(env).toMatchObject({ EXISTING: "plugin", PLUGIN_SAFE: "yes" });
      expect(JSON.parse(env?.[CHANNEL_CONTEXT_ENV_KEY] ?? "{}")).toEqual({
        chat: { id: "oc_1" },
        sender: { id: "ou_1" },
      });
    }
    expect(mocks.gatewayParams[0]?.env).not.toHaveProperty("NODE_OPTIONS");
    expect(mocks.gatewayParams[0]?.env.OPENCLAW_CLI).toBe(OPENCLAW_CLI_ENV_VALUE);
    expect(mocks.gatewayParams[0]?.env.PATH).not.toBe("/tmp/plugin-bin");
  });

  it("retains plugin env when prepared arguments are prepared again", async () => {
    installResolveExecEnvHook({ PLUGIN_SAFE: "yes" });
    const tool: AnyAgentTool = createExecTool({ host: "node", security: "full", ask: "off" });
    const prepare = expectDefined(tool.prepareBeforeToolCallParams, "exec preparation");
    const prepared = await prepare({ command: "echo ok", host: "auto" }, {});
    const preparedAgain = await prepare(prepared, {});

    await tool.execute("call-prepared-twice", preparedAgain);

    expect(mocks.hookRunner?.runResolveExecEnv).toHaveBeenCalledOnce();
    expect(mocks.nodeHostParams[0]?.env).toMatchObject({ PLUGIN_SAFE: "yes" });
    expect(mocks.nodeHostParams[0]?.requestedEnv).toMatchObject({ PLUGIN_SAFE: "yes" });
  });

  it("prevalidates node workdirs before resolving exec env when a backend sandbox exists", async () => {
    installResolveExecEnvHook({ PLUGIN_SAFE: "yes" });
    const validateWorkdir = vi.fn(async (workdir: string) => workdir);
    const tool = createTestExecTool({
      host: "node",
      sandbox: backendSandboxConfig({ validateWorkdir }),
    });

    const result = await tool.execute("call-node-invalid-cwd-with-backend-sandbox", {
      command: "echo ok",
      workdir: "   ",
    });

    expect((result.details as { status?: unknown } | undefined)?.status).toBe("failed");
    expect(mocks.hookRunner?.runResolveExecEnv).not.toHaveBeenCalled();
    expect(validateWorkdir).not.toHaveBeenCalled();
    expect(mocks.nodeHostParams).toHaveLength(0);
  });

  it("does not validate backend sandbox workdirs before before_tool_call veto", async () => {
    const validateWorkdir = vi.fn(async (workdir: string) => workdir);
    mocks.hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "before_tool_call"),
      runBeforeToolCall: vi.fn(async () => ({
        block: true,
        blockReason: "blocked by test hook",
      })),
    };
    const tool = createTestExecTool({
      host: "sandbox",
      sandbox: backendSandboxConfig({ validateWorkdir }),
    });
    const result = await executeWrapped(tool, {
      command: "echo ok",
      workdir: "/remote/workspace/generated",
    });

    expect(
      result.details as { status?: unknown; deniedReason?: unknown } | undefined,
    ).toMatchObject({
      status: "blocked",
      deniedReason: "plugin-before-tool-call",
    });
    expect(mocks.hookRunner.runBeforeToolCall!).toHaveBeenCalledOnce();
    expect(validateWorkdir).not.toHaveBeenCalled();
    expect(mocks.gatewayParams).toHaveLength(0);
    expect(mocks.spawnInputs).toHaveLength(0);
  });

  it("defers resolve_exec_env for backend sandboxes until workdir validation succeeds", async () => {
    const validateWorkdir = vi.fn(async () => null);
    const hooks = installWrappedHooks();
    const tool = createTestExecTool({
      host: "sandbox",
      sandbox: backendSandboxConfig({ validateWorkdir }),
    });
    const result = await executeWrapped(tool, {
      command: "echo ok",
      workdir: "/remote/workspace/missing",
    });

    expect((result.details as { status?: unknown } | undefined)?.status).toBe("failed");
    expect(hooks.runBeforeToolCall).toHaveBeenCalledOnce();
    expect(validateWorkdir).toHaveBeenCalledWith("/remote/workspace/missing");
    expect(hooks.runResolveExecEnv).not.toHaveBeenCalled();
    expect(mocks.gatewayParams).toHaveLength(0);
    expect(mocks.spawnInputs).toHaveLength(0);
  });

  it("preserves hook context when backend sandbox env resolution is deferred", async () => {
    const validateWorkdir = vi.fn(async (workdir: string) => workdir);
    const buildExecSpec = vi.fn<NonNullable<BashSandboxConfig["buildExecSpec"]>>(
      async (params) => ({
        argv: ["remote-shell", params.command],
        env: {},
        stdinMode: "pipe-open" as const,
      }),
    );
    const hooks = installWrappedHooks();
    const tool = createTestExecTool({
      host: "sandbox",
      agentId: "policy-agent",
      sessionKey: "global",
      sandbox: backendSandboxConfig({ validateWorkdir, buildExecSpec }),
    });
    const result = await executeWrapped(
      tool,
      {
        command: "echo ok",
        workdir: "/remote/workspace/generated",
      },
      {
        agentId: "ctx-agent",
        sessionKey: "agent:ctx-agent:telegram:chat-2",
        sessionId: "ctx-session",
        channelId: "ctx-channel",
      },
    );

    expect((result.details as { status?: unknown } | undefined)?.status).toBe("completed");
    expect(validateWorkdir).toHaveBeenCalledWith("/remote/workspace/generated");
    expect(hooks.runBeforeToolCall).toHaveBeenCalledOnce();
    expect(hooks.runResolveExecEnv).toHaveBeenCalledOnce();
    expect(hooks.runResolveExecEnv.mock.calls[0]?.[0]).toMatchObject({
      sessionKey: "agent:ctx-agent:telegram:chat-2",
      toolName: "exec",
      host: "sandbox",
    });
    expect(hooks.runResolveExecEnv.mock.calls[0]?.[1]).toMatchObject({
      agentId: "ctx-agent",
      sessionKey: "agent:ctx-agent:telegram:chat-2",
      sessionId: "ctx-session",
      channelId: "ctx-channel",
    });
    expect(buildExecSpec.mock.calls[0]?.[0]?.env).toMatchObject({
      PLUGIN_SAFE: "yes",
    });
  });

  it("lets lazy before_tool_call see invalid workdirs before failing unchanged params", async () => {
    const hooks = installWrappedHooks(
      vi.fn(async () => undefined),
      vi.fn(async () => ({ LAZY_PLUGIN_SAFE: "yes" })),
    );

    const exec = createOpenClawCodingTools({
      agentId: "main",
      sessionKey: "agent:main:telegram:chat-1",
      cwd: process.cwd(),
      exec: { host: "gateway", security: "full", ask: "off" },
    }).find((tool) => tool.name === "exec");
    expect(exec).toBeDefined();
    const result = await executeWrapped(
      exec!,
      {
        command: "echo ok",
        workdir: "   ",
      },
      {
        agentId: "main",
        sessionKey: "agent:main:telegram:chat-1",
        channelId: "chat-1",
      },
    );
    const text = result.content.find((entry) => entry.type === "text")?.text ?? "";

    expect((result.details as { status?: unknown } | undefined)?.status).toBe("failed");
    expect(text).toContain('workdir "   " is unavailable or not a directory');
    expect(hooks.runBeforeToolCall).toHaveBeenCalledTimes(1);
    expect(hooks.runResolveExecEnv).not.toHaveBeenCalled();
    expect(mocks.gatewayParams).toHaveLength(0);
    expect(mocks.spawnInputs).toHaveLength(0);
  });

  it("inherits configured gateway for auto through lazy exec preparation", async () => {
    const hooks = installWrappedHooks(
      vi.fn(async (event: { params: Record<string, unknown> }) => {
        expect(Object.getOwnPropertySymbols(event.params)).toHaveLength(0);
        mocks.beforeToolCallParams.push({ ...event.params });
        return undefined;
      }),
      vi.fn(async () => ({ LAZY_PLUGIN_SAFE: "yes" })),
    );

    const exec = createOpenClawCodingTools({
      agentId: "main",
      sessionKey: "agent:main:telegram:chat-1",
      cwd: process.cwd(),
      exec: { host: "gateway", security: "full", ask: "off" },
    }).find((tool) => tool.name === "exec");
    expect(exec).toBeDefined();
    await executeWrapped(
      exec!,
      {
        host: "auto",
        command: "echo ok",
        env: { REQUEST_SAFE: "request" },
        yieldMs: 120_000,
      },
      {
        agentId: "main",
        sessionKey: "agent:main:telegram:chat-1",
        channelId: "chat-1",
      },
    );

    expect(mocks.beforeToolCallParams[0]?.env).toEqual({
      REQUEST_SAFE: "request",
    });
    expect(hooks.runResolveExecEnv).toHaveBeenCalledTimes(1);
    expect(mocks.gatewayParams[0]?.requestedEnv).toEqual({
      LAZY_PLUGIN_SAFE: "yes",
      REQUEST_SAFE: "request",
    });
  });

  it("recomputes plugin env when before_tool_call changes exec host", async () => {
    const executionSessionKey = "agent:main:telegram:chat-1";
    const hooks = installWrappedHooks(
      vi.fn(async (event: { params: Record<string, unknown> }) => ({
        params: { ...event.params, host: "node" },
      })),
      vi.fn(async (event: { host: "gateway" | "sandbox" | "node" }) =>
        event.host === "node" ? { NODE_PLUGIN_SAFE: "node" } : { GATEWAY_PLUGIN_SAFE: "gateway" },
      ),
    );

    const tool = createTestExecTool({
      host: "auto",
      agentId: "policy-agent",
      sessionKey: "global",
    });
    await executeWrapped(
      tool,
      {
        command: "echo ok",
        env: { REQUEST_SAFE: "request" },
      },
      {
        agentId: "main",
        sessionKey: executionSessionKey,
      },
    );

    expect(hooks.runResolveExecEnv).toHaveBeenCalledTimes(2);
    for (const [index, host] of ["gateway", "node"].entries()) {
      expect(hooks.runResolveExecEnv).toHaveBeenNthCalledWith(
        index + 1,
        expect.objectContaining({ host, sessionKey: executionSessionKey }),
        expect.objectContaining({ agentId: "main", sessionKey: executionSessionKey }),
      );
    }
    expect(mocks.nodeHostParams[0]?.requestedEnv).toEqual({
      NODE_PLUGIN_SAFE: "node",
      REQUEST_SAFE: "request",
    });
    expect(mocks.nodeHostParams[0]?.requestedEnv).not.toHaveProperty("GATEWAY_PLUGIN_SAFE");
  });

  it("lets before_tool_call reroute gateway-invalid workdirs to node host execution", async () => {
    const hooks = installWrappedHooks(
      vi.fn(async (event: { params: Record<string, unknown> }) => ({
        params: { ...event.params, host: "node" },
      })),
      vi.fn(async (event: { host: "gateway" | "sandbox" | "node" }) =>
        event.host === "node" ? { NODE_PLUGIN_SAFE: "node" } : { GATEWAY_PLUGIN_SAFE: "gateway" },
      ),
    );

    const tool = createTestExecTool({
      host: "auto",
      sessionKey: "agent:main:telegram:chat-1",
    });
    await executeWrapped(tool, {
      command: "echo ok",
      env: { REQUEST_SAFE: "request" },
      workdir: "/remote/node/workspace",
    });

    expect(hooks.runBeforeToolCall).toHaveBeenCalledOnce();
    expect(hooks.runResolveExecEnv).toHaveBeenCalledOnce();
    expect(hooks.runResolveExecEnv).toHaveBeenCalledWith(
      expect.objectContaining({ host: "node" }),
      expect.anything(),
    );
    expect(mocks.nodeHostParams[0]?.requestedEnv).toEqual({
      NODE_PLUGIN_SAFE: "node",
      REQUEST_SAFE: "request",
    });
    expect(mocks.nodeHostParams[0]?.workdir).toBe("/remote/node/workspace");
    expect(mocks.gatewayParams).toHaveLength(0);
    expect(mocks.spawnInputs).toHaveLength(0);
  });

  it("skips stale hook runners that report resolve_exec_env without the runner method", async () => {
    mocks.hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "resolve_exec_env"),
    };

    const tool = createTestExecTool({
      host: "gateway",
      sessionKey: "agent:main:telegram:chat-1",
    });
    await tool.execute("call-stale-hook-runner", {
      command: "echo ok",
      env: { REQUEST_SAFE: "request" },
      yieldMs: 120_000,
    });

    expect(mocks.gatewayParams[0]?.requestedEnv).toEqual({
      REQUEST_SAFE: "request",
    });
  });

  it("resolves plugin env after before_tool_call adds a command", async () => {
    const hooks = installWrappedHooks(
      vi.fn(async (event: { params: Record<string, unknown> }) => {
        mocks.beforeToolCallParams.push({ ...event.params });
        return {
          params: { ...event.params, command: "echo ok" },
        };
      }),
    );

    const tool = createTestExecTool({
      host: "gateway",
      sessionKey: "agent:main:telegram:chat-1",
    });
    await executeWrapped(tool, {
      env: { REQUEST_SAFE: "request" },
      yieldMs: 120_000,
    });

    expect(mocks.beforeToolCallParams[0]?.env).toEqual({
      REQUEST_SAFE: "request",
    });
    expect(hooks.runResolveExecEnv).toHaveBeenCalledTimes(1);
    expect(mocks.gatewayParams[0]?.requestedEnv).toEqual({
      PLUGIN_SAFE: "yes",
      REQUEST_SAFE: "request",
    });
  });
});
