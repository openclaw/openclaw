import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDiagnosticSessionStateForTest } from "../logging/diagnostic-session-state.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { addTestHook, createMockPluginRegistry } from "../plugins/hooks.test-helpers.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import type { PluginHookRegistration } from "../plugins/types.js";

type ToolDefinitionAdapterModule = typeof import("./pi-tool-definition-adapter.js");
type PiToolsAbortModule = typeof import("./pi-tools.abort.js");
type BeforeToolCallModule = typeof import("./pi-tools.before-tool-call.js");

type ToClientToolDefinitions = ToolDefinitionAdapterModule["toClientToolDefinitions"];
type ToToolDefinitions = ToolDefinitionAdapterModule["toToolDefinitions"];
type WrapToolWithAbortSignal = PiToolsAbortModule["wrapToolWithAbortSignal"];
type BeforeToolCallTesting = BeforeToolCallModule["__testing"];
type ConsumeAdjustedParamsForToolCall = BeforeToolCallModule["consumeAdjustedParamsForToolCall"];
type WrapToolWithBeforeToolCallHook = BeforeToolCallModule["wrapToolWithBeforeToolCallHook"];

let toClientToolDefinitions!: ToClientToolDefinitions;
let toToolDefinitions!: ToToolDefinitions;
let wrapToolWithAbortSignal!: WrapToolWithAbortSignal;
let beforeToolCallTesting!: BeforeToolCallTesting;
let consumeAdjustedParamsForToolCall!: ConsumeAdjustedParamsForToolCall;
let wrapToolWithBeforeToolCallHook!: WrapToolWithBeforeToolCallHook;

beforeEach(async () => {
  if (!wrapToolWithBeforeToolCallHook) {
    ({ toClientToolDefinitions, toToolDefinitions } =
      await import("./pi-tool-definition-adapter.js"));
    ({ wrapToolWithAbortSignal } = await import("./pi-tools.abort.js"));
    ({
      __testing: beforeToolCallTesting,
      consumeAdjustedParamsForToolCall,
      wrapToolWithBeforeToolCallHook,
    } = await import("./pi-tools.before-tool-call.js"));
  }
});

type BeforeToolCallHandlerMock = ReturnType<typeof vi.fn>;

type BeforeToolCallHookInstall = {
  pluginId: string;
  priority?: number;
  handler: BeforeToolCallHandlerMock;
};

function installBeforeToolCallHook(params?: {
  enabled?: boolean;
  runBeforeToolCallImpl?: (...args: unknown[]) => unknown;
}): BeforeToolCallHandlerMock {
  resetGlobalHookRunner();
  const handler = params?.runBeforeToolCallImpl
    ? vi.fn(params.runBeforeToolCallImpl)
    : vi.fn(async () => undefined);
  if (params?.enabled === false) {
    return handler;
  }
  initializeGlobalHookRunner(createMockPluginRegistry([{ hookName: "before_tool_call", handler }]));
  return handler;
}

function installBeforeToolCallHooks(hooks: BeforeToolCallHookInstall[]): void {
  resetGlobalHookRunner();
  const registry = createEmptyPluginRegistry();
  for (const hook of hooks) {
    addTestHook({
      registry,
      pluginId: hook.pluginId,
      hookName: "before_tool_call",
      handler: hook.handler as PluginHookRegistration["handler"],
      priority: hook.priority,
    });
  }
  initializeGlobalHookRunner(registry);
}

describe("before_tool_call hook integration", () => {
  let beforeToolCallHook: BeforeToolCallHandlerMock;

  beforeEach(() => {
    resetGlobalHookRunner();
    resetDiagnosticSessionStateForTest();
    beforeToolCallTesting.adjustedParamsByToolCallId.clear();
    beforeToolCallHook = installBeforeToolCallHook();
  });

  it("executes tool normally when no hook is registered", async () => {
    beforeToolCallHook = installBeforeToolCallHook({ enabled: false });
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const tool = wrapToolWithBeforeToolCallHook({ name: "Read", execute } as any, {
      agentId: "main",
      sessionKey: "main",
    });
    const extensionContext = {} as Parameters<typeof tool.execute>[3];

    await tool.execute("call-1", { path: "/tmp/file" }, undefined, extensionContext);

    expect(beforeToolCallHook).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith(
      "call-1",
      { path: "/tmp/file" },
      undefined,
      extensionContext,
      undefined,
    );
  });

  it("allows hook to modify parameters", async () => {
    beforeToolCallHook = installBeforeToolCallHook({
      runBeforeToolCallImpl: async () => ({ params: { mode: "safe" } }),
    });
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const tool = wrapToolWithBeforeToolCallHook({ name: "exec", execute } as any);
    const extensionContext = {} as Parameters<typeof tool.execute>[3];

    await tool.execute("call-2", { cmd: "ls" }, undefined, extensionContext);

    expect(execute).toHaveBeenCalledWith(
      "call-2",
      { cmd: "ls", mode: "safe" },
      undefined,
      extensionContext,
      undefined,
    );
  });

  it("blocks tool execution when hook returns block=true", async () => {
    beforeToolCallHook = installBeforeToolCallHook({
      runBeforeToolCallImpl: async () => ({
        block: true,
        blockReason: "blocked",
      }),
    });
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const tool = wrapToolWithBeforeToolCallHook({ name: "exec", execute } as any);
    const extensionContext = {} as Parameters<typeof tool.execute>[3];

    await expect(
      tool.execute("call-3", { cmd: "rm -rf /" }, undefined, extensionContext),
    ).rejects.toThrow("blocked");
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not execute lower-priority hooks after block=true", async () => {
    const high = vi.fn().mockResolvedValue({ block: true, blockReason: "blocked-high" });
    const low = vi.fn().mockResolvedValue({ params: { shouldNotApply: true } });
    installBeforeToolCallHooks([
      { pluginId: "high", priority: 100, handler: high },
      { pluginId: "low", priority: 0, handler: low },
    ]);

    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const tool = wrapToolWithBeforeToolCallHook({ name: "exec", execute } as any);
    const extensionContext = {} as Parameters<typeof tool.execute>[3];

    await expect(
      tool.execute("call-stop", { cmd: "rm -rf /" }, undefined, extensionContext),
    ).rejects.toThrow("blocked-high");

    expect(high).toHaveBeenCalledTimes(1);
    expect(low).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("blocks tool execution when hook throws", async () => {
    beforeToolCallHook = installBeforeToolCallHook({
      runBeforeToolCallImpl: async () => {
        throw new Error("boom");
      },
    });
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const tool = wrapToolWithBeforeToolCallHook({ name: "read", execute } as any);
    const extensionContext = {} as Parameters<typeof tool.execute>[3];

    await expect(
      tool.execute("call-4", { path: "/tmp/file" }, undefined, extensionContext),
    ).rejects.toThrow("Tool call blocked because before_tool_call hook failed");
    expect(execute).not.toHaveBeenCalled();
  });

  it("normalizes non-object params for hook contract", async () => {
    beforeToolCallHook = installBeforeToolCallHook({
      runBeforeToolCallImpl: async () => undefined,
    });
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const tool = wrapToolWithBeforeToolCallHook({ name: "ReAd", execute } as any, {
      agentId: "main",
      sessionKey: "main",
      sessionId: "ephemeral-main",
      runId: "run-main",
    });
    const extensionContext = {} as Parameters<typeof tool.execute>[3];

    await tool.execute("call-5", "not-an-object", undefined, extensionContext);

    expect(beforeToolCallHook).toHaveBeenCalledWith(
      {
        toolName: "read",
        params: {},
        runId: "run-main",
        toolCallId: "call-5",
      },
      {
        toolName: "read",
        agentId: "main",
        sessionKey: "main",
        sessionId: "ephemeral-main",
        runId: "run-main",
        toolCallId: "call-5",
      },
    );
  });

  it("keeps adjusted params isolated per run when toolCallId collides", async () => {
    beforeToolCallHook = installBeforeToolCallHook({
      runBeforeToolCallImpl: vi
        .fn()
        .mockResolvedValueOnce({ params: { marker: "A" } })
        .mockResolvedValueOnce({ params: { marker: "B" } }),
    });
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const toolA = wrapToolWithBeforeToolCallHook({ name: "Read", execute } as any, {
      runId: "run-a",
    });
    const toolB = wrapToolWithBeforeToolCallHook({ name: "Read", execute } as any, {
      runId: "run-b",
    });
    const extensionContextA = {} as Parameters<typeof toolA.execute>[3];
    const extensionContextB = {} as Parameters<typeof toolB.execute>[3];
    const sharedToolCallId = "shared-call";

    await toolA.execute(sharedToolCallId, { path: "/tmp/a.txt" }, undefined, extensionContextA);
    await toolB.execute(sharedToolCallId, { path: "/tmp/b.txt" }, undefined, extensionContextB);

    expect(consumeAdjustedParamsForToolCall(sharedToolCallId, "run-a")).toEqual({
      path: "/tmp/a.txt",
      marker: "A",
    });
    expect(consumeAdjustedParamsForToolCall(sharedToolCallId, "run-b")).toEqual({
      path: "/tmp/b.txt",
      marker: "B",
    });
    expect(consumeAdjustedParamsForToolCall(sharedToolCallId, "run-a")).toBeUndefined();
  });

  it("passes precedingText and messageId from the assistant tool-call message", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const baseTool = { name: "read", execute, description: "read", parameters: {} } as any;
    const wrapped = wrapToolWithBeforeToolCallHook(baseTool, {
      agentId: "main",
      sessionKey: "main",
    });
    const [def] = toToolDefinitions([wrapped]);
    const extensionContext = {
      sessionManager: {
        getLeafEntry: () => ({
          id: "msg-assistant-1",
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "I should inspect the target file first." },
              {
                type: "toolCall",
                id: "call-ctx",
                name: "read",
                arguments: { path: "/tmp/file" },
              },
            ],
          },
        }),
      },
    } as Parameters<typeof def.execute>[4];

    await def.execute("call-ctx", { path: "/tmp/file" }, undefined, undefined, extensionContext);

    expect(beforeToolCallHook).toHaveBeenCalledWith(
      {
        toolName: "read",
        params: { path: "/tmp/file" },
        toolCallId: "call-ctx",
        precedingText: "I should inspect the target file first.",
        messageId: "msg-assistant-1",
      },
      {
        toolName: "read",
        agentId: "main",
        sessionKey: "main",
        toolCallId: "call-ctx",
      },
    );
  });

  it("forwards extensionContext through wrapped tool execution", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const baseTool = { name: "read", execute, description: "read", parameters: {} } as any;
    const wrapped = wrapToolWithBeforeToolCallHook(baseTool, {
      agentId: "main",
      sessionKey: "main",
    });
    const [def] = toToolDefinitions([wrapped]);
    const extensionContext = {
      sessionManager: {
        getLeafEntry: () => ({
          id: "msg-extension-context",
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Inspect file first." },
              {
                type: "toolCall",
                id: "call-extension-context",
                name: "read",
                arguments: { path: "/tmp/file" },
              },
            ],
          },
        }),
      },
    } as Parameters<typeof def.execute>[4];

    await def.execute(
      "call-extension-context",
      { path: "/tmp/file" },
      undefined,
      undefined,
      extensionContext,
    );

    expect(execute).toHaveBeenCalledWith(
      "call-extension-context",
      { path: "/tmp/file" },
      undefined,
      undefined,
      extensionContext,
    );
  });
});

describe("before_tool_call hook deduplication (#15502)", () => {
  let beforeToolCallHook: BeforeToolCallHandlerMock;

  beforeEach(() => {
    resetGlobalHookRunner();
    resetDiagnosticSessionStateForTest();
    beforeToolCallHook = installBeforeToolCallHook({
      runBeforeToolCallImpl: async () => undefined,
    });
  });

  it("fires hook exactly once when tool goes through wrap + toToolDefinitions", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const baseTool = { name: "web_fetch", execute, description: "fetch", parameters: {} } as any;

    const wrapped = wrapToolWithBeforeToolCallHook(baseTool, {
      agentId: "main",
      sessionKey: "main",
    });
    const [def] = toToolDefinitions([wrapped]);
    const extensionContext = {} as Parameters<typeof def.execute>[4];
    await def.execute(
      "call-dedup",
      { url: "https://example.com" },
      undefined,
      undefined,
      extensionContext,
    );

    expect(beforeToolCallHook).toHaveBeenCalledTimes(1);
  });

  it("fires hook exactly once when tool goes through wrap + abort + toToolDefinitions", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const baseTool = { name: "Bash", execute, description: "bash", parameters: {} } as any;

    const abortController = new AbortController();
    const wrapped = wrapToolWithBeforeToolCallHook(baseTool, {
      agentId: "main",
      sessionKey: "main",
    });
    const withAbort = wrapToolWithAbortSignal(wrapped, abortController.signal);
    const [def] = toToolDefinitions([withAbort]);
    const extensionContext = {} as Parameters<typeof def.execute>[4];

    await def.execute(
      "call-abort-dedup",
      { command: "ls" },
      undefined,
      undefined,
      extensionContext,
    );

    expect(beforeToolCallHook).toHaveBeenCalledTimes(1);
  });

  it("preserves extensionContext through abort-wrapped before_tool_call hooks", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const baseTool = { name: "read", execute, description: "read", parameters: {} } as any;

    const abortController = new AbortController();
    const wrapped = wrapToolWithBeforeToolCallHook(baseTool, {
      agentId: "main",
      sessionKey: "main",
    });
    const withAbort = wrapToolWithAbortSignal(wrapped, abortController.signal);
    const [def] = toToolDefinitions([withAbort]);
    const extensionContext = {
      sessionManager: {
        getLeafEntry: () => ({
          id: "msg-abort-ctx-1",
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Need to inspect the file before continuing." },
              {
                type: "toolCall",
                id: "call-abort-ctx",
                name: "read",
                arguments: { path: "/tmp/file" },
              },
            ],
          },
        }),
      },
    } as Parameters<typeof def.execute>[4];

    await def.execute(
      "call-abort-ctx",
      { path: "/tmp/file" },
      undefined,
      undefined,
      extensionContext,
    );

    expect(beforeToolCallHook).toHaveBeenCalledWith(
      {
        toolName: "read",
        params: { path: "/tmp/file" },
        toolCallId: "call-abort-ctx",
        precedingText: "Need to inspect the file before continuing.",
        messageId: "msg-abort-ctx-1",
      },
      {
        toolName: "read",
        agentId: "main",
        sessionKey: "main",
        toolCallId: "call-abort-ctx",
      },
    );
  });
});

describe("before_tool_call hook integration for client tools", () => {
  beforeEach(() => {
    resetGlobalHookRunner();
    resetDiagnosticSessionStateForTest();
    installBeforeToolCallHook();
  });

  it("passes modified params to client tool callbacks", async () => {
    installBeforeToolCallHook({
      runBeforeToolCallImpl: async () => ({ params: { extra: true } }),
    });
    const onClientToolCall = vi.fn();
    const [tool] = toClientToolDefinitions(
      [
        {
          type: "function",
          function: {
            name: "client_tool",
            description: "Client tool",
            parameters: { type: "object", properties: { value: { type: "string" } } },
          },
        },
      ],
      onClientToolCall,
      { agentId: "main", sessionKey: "main" },
    );
    const extensionContext = {} as Parameters<typeof tool.execute>[4];
    await tool.execute("client-call-1", { value: "ok" }, undefined, undefined, extensionContext);

    expect(onClientToolCall).toHaveBeenCalledWith("client_tool", {
      value: "ok",
      extra: true,
    });
  });

  it("passes precedingText and messageId to client tool hooks", async () => {
    const onClientToolCall = vi.fn();
    const handler = installBeforeToolCallHook({
      runBeforeToolCallImpl: async () => undefined,
    });
    const [tool] = toClientToolDefinitions(
      [
        {
          type: "function",
          function: {
            name: "client_tool",
            description: "Client tool",
            parameters: { type: "object", properties: { value: { type: "string" } } },
          },
        },
      ],
      onClientToolCall,
      { agentId: "main", sessionKey: "main" },
    );
    const extensionContext = {
      sessionManager: {
        getLeafEntry: () => ({
          id: "msg-client-1",
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Need client-side confirmation before dispatch." },
              {
                type: "toolCall",
                id: "client-call-ctx",
                name: "client_tool",
                arguments: { value: "ok" },
              },
            ],
          },
        }),
      },
    } as Parameters<typeof tool.execute>[4];
    await tool.execute("client-call-ctx", { value: "ok" }, undefined, undefined, extensionContext);

    expect(handler).toHaveBeenCalledWith(
      {
        toolName: "client_tool",
        params: { value: "ok" },
        toolCallId: "client-call-ctx",
        precedingText: "Need client-side confirmation before dispatch.",
        messageId: "msg-client-1",
      },
      {
        toolName: "client_tool",
        agentId: "main",
        sessionKey: "main",
        toolCallId: "client-call-ctx",
      },
    );
  });
});
