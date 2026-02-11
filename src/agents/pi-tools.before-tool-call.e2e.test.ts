import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HeimdallConfig } from "../security/heimdall/types.js";
import { resetDiagnosticSessionStateForTest } from "../logging/diagnostic-session-state.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { SenderTier } from "../security/heimdall/types.js";
import { toClientToolDefinitions, toToolDefinitions } from "./pi-tool-definition-adapter.js";
import { wrapToolWithAbortSignal } from "./pi-tools.abort.js";
import { wrapToolWithBeforeToolCallHook, __testing } from "./pi-tools.before-tool-call.js";

const { runBeforeToolCallHook } = __testing;

vi.mock("../plugins/hook-runner-global.js");

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);

describe("before_tool_call hook integration", () => {
  let hookRunner: {
    hasHooks: ReturnType<typeof vi.fn>;
    runBeforeToolCall: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    resetDiagnosticSessionStateForTest();
    hookRunner = {
      hasHooks: vi.fn(),
      runBeforeToolCall: vi.fn(),
    };
    // oxlint-disable-next-line typescript/no-explicit-any
    mockGetGlobalHookRunner.mockReturnValue(hookRunner as any);
  });

  it("executes tool normally when no hook is registered", async () => {
    hookRunner.hasHooks.mockReturnValue(false);
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    // oxlint-disable-next-line typescript/no-explicit-any
    const tool = wrapToolWithBeforeToolCallHook({ name: "Read", execute } as any, {
      agentId: "main",
      sessionKey: "main",
    });
    const extensionContext = {} as Parameters<typeof tool.execute>[3];

    await tool.execute("call-1", { path: "/tmp/file" }, undefined, extensionContext);

    expect(hookRunner.runBeforeToolCall).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith(
      "call-1",
      { path: "/tmp/file" },
      undefined,
      extensionContext,
    );
  });

  it("allows hook to modify parameters", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    hookRunner.runBeforeToolCall.mockResolvedValue({ params: { mode: "safe" } });
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    // oxlint-disable-next-line typescript/no-explicit-any
    const tool = wrapToolWithBeforeToolCallHook({ name: "exec", execute } as any);
    const extensionContext = {} as Parameters<typeof tool.execute>[3];

    await tool.execute("call-2", { cmd: "ls" }, undefined, extensionContext);

    expect(execute).toHaveBeenCalledWith(
      "call-2",
      { cmd: "ls", mode: "safe" },
      undefined,
      extensionContext,
    );
  });

  it("blocks tool execution when hook returns block=true", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    hookRunner.runBeforeToolCall.mockResolvedValue({
      block: true,
      blockReason: "blocked",
    });
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    // oxlint-disable-next-line typescript/no-explicit-any
    const tool = wrapToolWithBeforeToolCallHook({ name: "exec", execute } as any);
    const extensionContext = {} as Parameters<typeof tool.execute>[3];

    await expect(
      tool.execute("call-3", { cmd: "rm -rf /" }, undefined, extensionContext),
    ).rejects.toThrow("blocked");
    expect(execute).not.toHaveBeenCalled();
  });

  it("continues execution when hook throws", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    hookRunner.runBeforeToolCall.mockRejectedValue(new Error("boom"));
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    // oxlint-disable-next-line typescript/no-explicit-any
    const tool = wrapToolWithBeforeToolCallHook({ name: "read", execute } as any);
    const extensionContext = {} as Parameters<typeof tool.execute>[3];

    await tool.execute("call-4", { path: "/tmp/file" }, undefined, extensionContext);

    expect(execute).toHaveBeenCalledWith(
      "call-4",
      { path: "/tmp/file" },
      undefined,
      extensionContext,
    );
  });

  it("normalizes non-object params for hook contract", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    hookRunner.runBeforeToolCall.mockResolvedValue(undefined);
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    // oxlint-disable-next-line typescript/no-explicit-any
    const tool = wrapToolWithBeforeToolCallHook({ name: "ReAd", execute } as any, {
      agentId: "main",
      sessionKey: "main",
    });
    const extensionContext = {} as Parameters<typeof tool.execute>[3];

    await tool.execute("call-5", "not-an-object", undefined, extensionContext);

    expect(hookRunner.runBeforeToolCall).toHaveBeenCalledWith(
      {
        toolName: "read",
        params: {},
      },
      {
        toolName: "read",
        agentId: "main",
        sessionKey: "main",
      },
    );
  });
});

describe("before_tool_call hook deduplication (#15502)", () => {
  let hookRunner: {
    hasHooks: ReturnType<typeof vi.fn>;
    runBeforeToolCall: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    resetDiagnosticSessionStateForTest();
    hookRunner = {
      hasHooks: vi.fn(() => true),
      runBeforeToolCall: vi.fn(async () => undefined),
    };
    // oxlint-disable-next-line typescript/no-explicit-any
    mockGetGlobalHookRunner.mockReturnValue(hookRunner as any);
  });

  it("fires hook exactly once when tool goes through wrap + toToolDefinitions", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    // oxlint-disable-next-line typescript/no-explicit-any
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

    expect(hookRunner.runBeforeToolCall).toHaveBeenCalledTimes(1);
  });

  it("fires hook exactly once when tool goes through wrap + abort + toToolDefinitions", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    // oxlint-disable-next-line typescript/no-explicit-any
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

    expect(hookRunner.runBeforeToolCall).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Heimdall ACL integration
// ---------------------------------------------------------------------------

describe("Heimdall tool ACL integration", () => {
  const heimdallConfig: HeimdallConfig = {
    enabled: true,
    defaultGuestPolicy: "deny",
    toolACL: [],
  };

  beforeEach(() => {
    // No plugin hooks — isolate Heimdall behavior
    mockGetGlobalHookRunner.mockReturnValue(null);
  });

  it("blocks dangerous tool for MEMBER tier", async () => {
    const result = await runBeforeToolCallHook({
      toolName: "exec",
      params: { cmd: "ls" },
      ctx: { senderTier: SenderTier.MEMBER, heimdallConfig },
    });
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.reason).toContain("[heimdall]");
      expect(result.reason).toContain("exec");
      expect(result.reason).toContain("member");
    }
  });

  it("allows safe tool for MEMBER tier", async () => {
    const result = await runBeforeToolCallHook({
      toolName: "read",
      params: { path: "/tmp/file" },
      ctx: { senderTier: SenderTier.MEMBER, heimdallConfig },
    });
    expect(result.blocked).toBe(false);
  });

  it("allows any tool for OWNER tier", async () => {
    const result = await runBeforeToolCallHook({
      toolName: "exec",
      params: { cmd: "rm -rf /" },
      ctx: { senderTier: SenderTier.OWNER, heimdallConfig },
    });
    expect(result.blocked).toBe(false);
  });

  it("blocks all tools for GUEST with deny policy", async () => {
    const result = await runBeforeToolCallHook({
      toolName: "search",
      params: {},
      ctx: { senderTier: SenderTier.GUEST, heimdallConfig },
    });
    expect(result.blocked).toBe(true);
  });

  it("skips Heimdall check when config is disabled", async () => {
    const result = await runBeforeToolCallHook({
      toolName: "exec",
      params: { cmd: "ls" },
      ctx: {
        senderTier: SenderTier.GUEST,
        heimdallConfig: { ...heimdallConfig, enabled: false },
      },
    });
    // With no hooks registered and Heimdall disabled, tool passes through
    expect(result.blocked).toBe(false);
  });

  it("skips Heimdall check when senderTier is absent", async () => {
    const result = await runBeforeToolCallHook({
      toolName: "exec",
      params: { cmd: "ls" },
      ctx: { heimdallConfig },
    });
    // No senderTier → Heimdall guard skipped → tool passes through
    expect(result.blocked).toBe(false);
  });

  it("skips Heimdall check when heimdallConfig is absent", async () => {
    const result = await runBeforeToolCallHook({
      toolName: "exec",
      params: { cmd: "ls" },
      ctx: { senderTier: SenderTier.GUEST },
    });
    expect(result.blocked).toBe(false);
  });

  it("normalizes tool names through Heimdall check (Bash → exec)", async () => {
    const result = await runBeforeToolCallHook({
      toolName: "Bash",
      params: {},
      ctx: { senderTier: SenderTier.MEMBER, heimdallConfig },
    });
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.reason).toContain("exec");
    }
  });

  it("wrapToolWithBeforeToolCallHook throws on Heimdall block", async () => {
    mockGetGlobalHookRunner.mockReturnValue(null);
    const execute = vi.fn().mockResolvedValue({ content: [] });
    // oxlint-disable-next-line typescript/no-explicit-any
    const tool = wrapToolWithBeforeToolCallHook({ name: "exec", execute } as any, {
      senderTier: SenderTier.MEMBER,
      heimdallConfig,
    });

    await expect(tool.execute("call-h1", { cmd: "ls" }, undefined, undefined)).rejects.toThrow(
      "[heimdall]",
    );
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("before_tool_call hook integration for client tools", () => {
  let hookRunner: {
    hasHooks: ReturnType<typeof vi.fn>;
    runBeforeToolCall: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    resetDiagnosticSessionStateForTest();
    hookRunner = {
      hasHooks: vi.fn(),
      runBeforeToolCall: vi.fn(),
    };
    // oxlint-disable-next-line typescript/no-explicit-any
    mockGetGlobalHookRunner.mockReturnValue(hookRunner as any);
  });

  it("passes modified params to client tool callbacks", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    hookRunner.runBeforeToolCall.mockResolvedValue({ params: { extra: true } });
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
});
