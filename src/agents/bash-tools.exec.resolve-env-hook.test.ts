import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import {
  type CapturedEnvironment,
  type CapturedNodeEnvironment,
  environmentSandbox,
  sandboxExecSpec,
} from "./bash-tools.exec-env.test-support.js";
import type { BashSandboxConfig } from "./bash-tools.shared.js";
import type { ExtensionContext } from "./sessions/index.js";
import type { AnyAgentTool } from "./tools/common.js";

declare module "../plugins/hook-types.js" {
  interface PluginHookChannelSenderContext {
    unionId?: string;
  }
}

const sessionKey = "agent:main:telegram:chat-1";
const channelContext = () => ({ sender: { id: "ou_1", unionId: "on_1" }, chat: { id: "oc_1" } });
const messageContext = {
  sessionKey,
  sessionId: "session-1",
  messageProvider: "telegram",
};

const mocks = vi.hoisted(() => ({
  hookRunner: undefined as
    | {
        hasHooks: ReturnType<typeof vi.fn>;
        runResolveExecEnv?: ReturnType<typeof vi.fn>;
        runBeforeToolCall?: ReturnType<typeof vi.fn>;
      }
    | undefined,
  gatewayParams: [] as CapturedEnvironment[],
  nodeHostParams: [] as CapturedNodeEnvironment[],
  spawnInputs: [] as Array<{ env?: Record<string, string> }>,
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => mocks.hookRunner,
  getGlobalHookRunnerRegistry: () => null,
}));

// mock-isolation: Do not read the host login shell while assembling synthetic environments.
vi.mock("../infra/shell-env.js", async () =>
  (await import("./bash-tools.exec-env.test-support.js")).shellEnvironmentMock(),
);
// mock-isolation: Capture Gateway execution parameters without running host commands.
vi.mock("./bash-tools.exec-host-gateway.js", async () =>
  (await import("./bash-tools.exec-env.test-support.js")).gatewayEnvironmentMock(mocks),
);
// mock-isolation: Capture node execution parameters without contacting a node.
vi.mock("./bash-tools.exec-host-node.js", async () =>
  (await import("./bash-tools.exec-env.test-support.js")).nodeEnvironmentMock(mocks),
);
// mock-isolation: Record spawn environments without launching real subprocesses.
vi.mock("../process/supervisor/index.js", async () =>
  (await import("./bash-tools.exec-env.test-support.js")).supervisorEnvironmentMock(mocks),
);

let createExecTool: typeof import("./bash-tools.exec-run.js").createExecTool;
let toToolDefinitions: typeof import("./agent-tool-definition-adapter.js").toToolDefinitions;
const testExtensionContext = {} as ExtensionContext;

function createTestExecTool(options: Parameters<typeof createExecTool>[0]) {
  return createExecTool({ security: "full", ask: "off", ...options });
}

function backendTool(
  sandbox: Partial<BashSandboxConfig>,
  options: Parameters<typeof createExecTool>[0] = {},
) {
  return createTestExecTool({
    host: "sandbox",
    sandbox: environmentSandbox({ workdirValidation: "backend", ...sandbox }),
    ...options,
  });
}

function installResolveExecEnvHook(result: Record<string, string>) {
  mocks.hookRunner = {
    hasHooks: vi.fn((hookName: string) => hookName === "resolve_exec_env"),
    runResolveExecEnv: vi.fn(async () => result),
  };
}
function expectNoExecution() {
  expect(mocks.gatewayParams).toHaveLength(0);
  expect(mocks.spawnInputs).toHaveLength(0);
}

function executeWrapped(
  tool: AnyAgentTool,
  params: Record<string, unknown>,
  context: Parameters<typeof toToolDefinitions>[1] = {
    agentId: "main",
    sessionKey,
  },
) {
  const [definition] = toToolDefinitions([tool], context);
  return expectDefined(definition, "definition test invariant").execute(
    "wrapped-call",
    { command: "echo ok", ...params },
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

beforeAll(async () => {
  ({ createExecTool } = await import("./bash-tools.exec-run.js"));
  ({ toToolDefinitions } = await import("./agent-tool-definition-adapter.js"));
});

beforeEach(() => {
  setRuntimeConfigSnapshot({});
  mocks.hookRunner = undefined;
  mocks.gatewayParams.length = 0;
  mocks.nodeHostParams.length = 0;
  mocks.spawnInputs.length = 0;
});
afterEach(() => clearRuntimeConfigSnapshot());

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
    ...messageContext,
    host: "auto",
    currentChannelId: "chat-1",
    channelContext: channelContext(),
  });
  await tool.execute("call-1", {
    command: "echo ok",
    env: { EXISTING: "request" },
    yieldMs: 120_000,
  });

  expect(mocks.hookRunner?.runResolveExecEnv).toHaveBeenCalledWith(
    { sessionKey, toolName: "exec", host: "gateway" },
    {
      ...messageContext,
      agentId: "main",
      channelId: "chat-1",
      channelContext: channelContext(),
    },
  );
  for (const env of [
    mocks.gatewayParams[0]?.requestedEnv,
    mocks.gatewayParams[0]?.env,
    mocks.spawnInputs[0]?.env,
  ]) {
    expect(env).toMatchObject({ EXISTING: "plugin", PLUGIN_SAFE: "yes" });
    expect(JSON.parse(env?.OPENCLAW_CHANNEL_CONTEXT ?? "{}")).toEqual({
      chat: { id: "oc_1" },
      sender: { id: "ou_1" },
    });
  }
  expect(mocks.gatewayParams[0]?.env).not.toHaveProperty("NODE_OPTIONS");
  expect(mocks.gatewayParams[0]?.env.OPENCLAW_CLI).toBe("1");
  expect(mocks.gatewayParams[0]?.env.PATH).not.toBe("/tmp/plugin-bin");
});

it("retains plugin env when prepared arguments are prepared again", async () => {
  installResolveExecEnvHook({ PLUGIN_SAFE: "yes" });
  const tool: AnyAgentTool = createTestExecTool({ host: "node" });
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
  const tool = backendTool({ validateWorkdir }, { host: "node" });

  const result = await tool.execute("call-node-invalid-cwd-with-backend-sandbox", {
    command: "echo ok",
    workdir: "   ",
  });

  expect(result.details).toMatchObject({ status: "failed" });
  expect(mocks.hookRunner?.runResolveExecEnv).not.toHaveBeenCalled();
  expect(validateWorkdir).not.toHaveBeenCalled();
  expect(mocks.nodeHostParams).toHaveLength(0);
});

it("does not validate backend sandbox workdirs before before_tool_call veto", async () => {
  const validateWorkdir = vi.fn(async (workdir: string) => workdir);
  mocks.hookRunner = {
    hasHooks: vi.fn((hookName: string) => hookName === "before_tool_call"),
    runBeforeToolCall: vi.fn(async () => ({ block: true, blockReason: "blocked by test hook" })),
  };
  const result = await executeWrapped(backendTool({ validateWorkdir }), {
    workdir: "/remote/workspace/generated",
  });

  expect(result.details).toMatchObject({
    status: "blocked",
    deniedReason: "plugin-before-tool-call",
  });
  expect(mocks.hookRunner.runBeforeToolCall!).toHaveBeenCalledOnce();
  expect(validateWorkdir).not.toHaveBeenCalled();
  expectNoExecution();
});

it("defers resolve_exec_env for backend sandboxes until workdir validation succeeds", async () => {
  const validateWorkdir = vi.fn(async () => null);
  const hooks = installWrappedHooks();
  const result = await executeWrapped(backendTool({ validateWorkdir }), {
    workdir: "/remote/workspace/missing",
  });

  expect(result.details).toMatchObject({ status: "failed" });
  expect(hooks.runBeforeToolCall).toHaveBeenCalledOnce();
  expect(validateWorkdir).toHaveBeenCalledWith("/remote/workspace/missing");
  expect(hooks.runResolveExecEnv).not.toHaveBeenCalled();
  expectNoExecution();
});

it("preserves hook context when backend sandbox env resolution is deferred", async () => {
  const validateWorkdir = vi.fn(async (workdir: string) => workdir);
  const buildExecSpec = vi.fn<NonNullable<BashSandboxConfig["buildExecSpec"]>>(async (params) =>
    sandboxExecSpec(params.command),
  );
  const hooks = installWrappedHooks();
  const tool = backendTool(
    { validateWorkdir, buildExecSpec },
    { agentId: "policy-agent", sessionKey: "global" },
  );
  const result = await executeWrapped(
    tool,
    { workdir: "/remote/workspace/generated" },
    {
      agentId: "ctx-agent",
      sessionKey: "agent:ctx-agent:telegram:chat-2",
      sessionId: "ctx-session",
      channelId: "ctx-channel",
    },
  );

  expect(result.details).toMatchObject({ status: "completed" });
  expect(validateWorkdir).toHaveBeenCalledWith("/remote/workspace/generated");
  expect(hooks.runBeforeToolCall).toHaveBeenCalledOnce();
  expect(hooks.runResolveExecEnv).toHaveBeenCalledOnce();
  expect(hooks.runResolveExecEnv.mock.calls[0]).toMatchObject([
    { sessionKey: "agent:ctx-agent:telegram:chat-2", toolName: "exec", host: "sandbox" },
    {
      agentId: "ctx-agent",
      sessionKey: "agent:ctx-agent:telegram:chat-2",
      sessionId: "ctx-session",
      channelId: "ctx-channel",
    },
  ]);
  expect(buildExecSpec.mock.calls[0]?.[0]?.env).toMatchObject({ PLUGIN_SAFE: "yes" });
});

it("lets lazy before_tool_call see invalid workdirs before failing unchanged params", async () => {
  const hooks = installWrappedHooks(
    vi.fn(async () => undefined),
    vi.fn(async () => ({ LAZY_PLUGIN_SAFE: "yes" })),
  );

  const exec = createOpenClawCodingTools({
    agentId: "main",
    sessionKey,
    cwd: process.cwd(),
    exec: { host: "gateway", security: "full", ask: "off" },
  }).find((tool) => tool.name === "exec");
  expect(exec).toBeDefined();
  const result = await executeWrapped(
    exec!,
    { workdir: "   " },
    {
      agentId: "main",
      sessionKey,
      channelId: "chat-1",
    },
  );
  const text = result.content.find((entry) => entry.type === "text")?.text ?? "";

  expect(result.details).toMatchObject({ status: "failed" });
  expect(text).toContain('workdir "   " is unavailable or not a directory');
  expect(hooks.runBeforeToolCall).toHaveBeenCalledTimes(1);
  expect(hooks.runResolveExecEnv).not.toHaveBeenCalled();
  expectNoExecution();
});

it.each([undefined, "/remote/node/workspace"])(
  "reroutes exec and recomputes plugin env for node workdir %s",
  async (workdir) => {
    const hooks = installWrappedHooks(
      vi.fn(async (event: { params: Record<string, unknown> }) => ({
        params: { ...event.params, host: "node" },
      })),
      vi.fn(async (event: { host: "gateway" | "sandbox" | "node" }) =>
        event.host === "node" ? { NODE_PLUGIN_SAFE: "node" } : { GATEWAY_PLUGIN_SAFE: "gateway" },
      ),
    );

    const tool = createTestExecTool(
      workdir
        ? { host: "auto", sessionKey }
        : { host: "auto", agentId: "policy-agent", sessionKey: "global" },
    );
    await executeWrapped(tool, {
      env: { REQUEST_SAFE: "request" },
      ...(workdir ? { workdir } : {}),
    });

    expect(hooks.runBeforeToolCall).toHaveBeenCalledOnce();
    const hosts = workdir ? ["node"] : ["gateway", "node"];
    expect(hooks.runResolveExecEnv).toHaveBeenCalledTimes(hosts.length);
    for (const [index, host] of hosts.entries()) {
      expect(hooks.runResolveExecEnv).toHaveBeenNthCalledWith(
        index + 1,
        expect.objectContaining({ host, sessionKey }),
        expect.objectContaining({ agentId: "main", sessionKey }),
      );
    }
    expect(mocks.nodeHostParams[0]?.requestedEnv).toEqual({
      NODE_PLUGIN_SAFE: "node",
      REQUEST_SAFE: "request",
    });
    expect(mocks.nodeHostParams[0]?.requestedEnv).not.toHaveProperty("GATEWAY_PLUGIN_SAFE");
    if (workdir) {
      expect(mocks.nodeHostParams[0]?.workdir).toBe(workdir);
      expectNoExecution();
    }
  },
);
