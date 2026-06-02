import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OPENCLAW_CLI_ENV_VALUE } from "../infra/openclaw-exec-env.js";

const mocks = vi.hoisted(() => ({
  hookRunner: undefined as
    | {
        hasHooks: ReturnType<typeof vi.fn>;
        runResolveExecEnv: ReturnType<typeof vi.fn>;
        runBeforeToolCall?: ReturnType<typeof vi.fn>;
      }
    | undefined,
  beforeToolCallParams: [] as Array<Record<string, unknown>>,
  gatewayParams: [] as Array<{
    env: Record<string, string>;
    requestedEnv?: Record<string, string>;
  }>,
  nodeHostParams: [] as Array<{
    env: Record<string, string>;
    requestedEnv?: Record<string, string>;
  }>,
  spawnInputs: [] as Array<{
    env?: Record<string, string>;
  }>,
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => mocks.hookRunner,
}));

vi.mock("../infra/shell-env.js", () => ({
  getShellPathFromLoginShell: vi.fn(() => null),
  resolveShellEnvFallbackTimeoutMs: vi.fn(() => 0),
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
    async (params: { env: Record<string, string>; requestedEnv?: Record<string, string> }) => {
      mocks.nodeHostParams.push({
        env: { ...params.env },
        requestedEnv: params.requestedEnv ? { ...params.requestedEnv } : undefined,
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
        runId: "mock-run",
        startedAtMs: Date.now(),
        stdin: undefined,
        wait: async () => ({
          reason: "exit" as const,
          exitCode: 0,
          exitSignal: null,
          durationMs: 0,
          stdout: "",
          stderr: "",
          timedOut: false,
          noOutputTimedOut: false,
        }),
        cancel: vi.fn(),
      };
    },
    cancel: vi.fn(),
    cancelScope: vi.fn(),
    reconcileOrphans: vi.fn(),
    getRecord: vi.fn(),
  }),
}));

let createExecTool: typeof import("./bash-tools.exec.js").createExecTool;
let toToolDefinitions: typeof import("./agent-tool-definition-adapter.js").toToolDefinitions;

function installResolveExecEnvHook(result: Record<string, string>) {
  mocks.hookRunner = {
    hasHooks: vi.fn((hookName: string) => hookName === "resolve_exec_env"),
    runResolveExecEnv: vi.fn(async () => result),
  };
}

describe("exec resolve_exec_env hook wiring", () => {
  beforeAll(async () => {
    ({ createExecTool } = await import("./bash-tools.exec.js"));
    ({ toToolDefinitions } = await import("./agent-tool-definition-adapter.js"));
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

    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      sessionKey: "agent:main:telegram:chat-1",
      messageProvider: "telegram",
      currentChannelId: "chat-1",
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
        messageProvider: "telegram",
        channelId: "chat-1",
      },
    );
    expect(mocks.gatewayParams[0]?.requestedEnv).toEqual({
      EXISTING: "plugin",
      PLUGIN_SAFE: "yes",
    });
    expect(mocks.gatewayParams[0]?.env).toMatchObject({
      EXISTING: "plugin",
      PLUGIN_SAFE: "yes",
    });
    expect(mocks.gatewayParams[0]?.env).not.toHaveProperty("NODE_OPTIONS");
    expect(mocks.gatewayParams[0]?.env.OPENCLAW_CLI).toBe(OPENCLAW_CLI_ENV_VALUE);
    expect(mocks.gatewayParams[0]?.env.PATH).not.toBe("/tmp/plugin-bin");
    expect(mocks.spawnInputs[0]?.env).toMatchObject({
      EXISTING: "plugin",
      PLUGIN_SAFE: "yes",
    });
  });

  it("forwards filtered plugin env to node host requests", async () => {
    installResolveExecEnvHook({
      NODE_HOST_SAFE: "yes",
      LD_PRELOAD: "/tmp/preload.dylib",
    });

    const tool = createExecTool({
      host: "node",
      security: "full",
      ask: "off",
      sessionKey: "agent:main:main",
    });
    await tool.execute("call-node", {
      command: "echo ok",
      env: { REQUEST_SAFE: "request" },
    });

    expect(mocks.nodeHostParams[0]?.requestedEnv).toEqual({
      NODE_HOST_SAFE: "yes",
      REQUEST_SAFE: "request",
    });
    expect(mocks.nodeHostParams[0]?.env).toMatchObject({
      NODE_HOST_SAFE: "yes",
      REQUEST_SAFE: "request",
    });
    expect(mocks.nodeHostParams[0]?.env).not.toHaveProperty("LD_PRELOAD");
  });

  it("includes plugin env in before_tool_call params before approval", async () => {
    mocks.hookRunner = {
      hasHooks: vi.fn(
        (hookName: string) => hookName === "resolve_exec_env" || hookName === "before_tool_call",
      ),
      runResolveExecEnv: vi.fn(async () => ({ PLUGIN_SAFE: "yes" })),
      runBeforeToolCall: vi.fn(async (event: { params: Record<string, unknown> }) => {
        mocks.beforeToolCallParams.push({ ...event.params });
        return undefined;
      }),
    };

    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      sessionKey: "agent:main:telegram:chat-1",
      messageProvider: "telegram",
      currentChannelId: "chat-1",
    });
    const [definition] = toToolDefinitions([tool], {
      agentId: "main",
      sessionKey: "agent:main:telegram:chat-1",
      channelId: "chat-1",
    });

    await definition.execute("call-before", {
      command: "echo ok",
      env: { EXISTING: "request" },
      yieldMs: 120_000,
    });

    expect(mocks.beforeToolCallParams[0]?.env).toEqual({
      EXISTING: "request",
      PLUGIN_SAFE: "yes",
    });
    expect(mocks.hookRunner.runResolveExecEnv).toHaveBeenCalledTimes(1);
    expect(mocks.gatewayParams[0]?.requestedEnv).toEqual({
      EXISTING: "request",
      PLUGIN_SAFE: "yes",
    });
  });
});
