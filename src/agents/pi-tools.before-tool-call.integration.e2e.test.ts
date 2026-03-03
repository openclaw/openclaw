import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDiagnosticSessionStateForTest } from "../logging/diagnostic-session-state.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { toClientToolDefinitions, toToolDefinitions } from "./pi-tool-definition-adapter.js";
import { wrapToolWithAbortSignal } from "./pi-tools.abort.js";
import { wrapToolWithBeforeToolCallHook } from "./pi-tools.before-tool-call.js";
import { evaluateWorkflowLaneGuard } from "./workflow-lane-policy.js";

vi.mock("../plugins/hook-runner-global.js");
vi.mock("./workflow-lane-policy.js", () => ({
  evaluateWorkflowLaneGuard: vi.fn(() => ({ blocked: false })),
}));

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);
const mockEvaluateWorkflowLaneGuard = vi.mocked(evaluateWorkflowLaneGuard);

type HookRunnerMock = {
  hasHooks: ReturnType<typeof vi.fn>;
  runBeforeToolCall: ReturnType<typeof vi.fn>;
};

function installMockHookRunner(params?: {
  hasHooksReturn?: boolean;
  runBeforeToolCallImpl?: (...args: unknown[]) => unknown;
}) {
  const hookRunner: HookRunnerMock = {
    hasHooks:
      params?.hasHooksReturn === undefined
        ? vi.fn()
        : vi.fn(() => params.hasHooksReturn as boolean),
    runBeforeToolCall: params?.runBeforeToolCallImpl
      ? vi.fn(params.runBeforeToolCallImpl)
      : vi.fn(),
  };
  // oxlint-disable-next-line typescript/no-explicit-any
  mockGetGlobalHookRunner.mockReturnValue(hookRunner as any);
  return hookRunner;
}

describe("before_tool_call hook integration", () => {
  let hookRunner: HookRunnerMock;

  beforeEach(() => {
    resetDiagnosticSessionStateForTest();
    mockEvaluateWorkflowLaneGuard.mockReset();
    mockEvaluateWorkflowLaneGuard.mockReturnValue({ blocked: false });
    hookRunner = installMockHookRunner();
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

  it("blocks mutation before execution when workflow lane guard blocks", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    mockEvaluateWorkflowLaneGuard.mockReturnValue({
      blocked: true,
      reason: "Workflow lane gate: missing ANCHOR.",
    });
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    // oxlint-disable-next-line typescript/no-explicit-any
    const tool = wrapToolWithBeforeToolCallHook({ name: "write", execute } as any, {
      agentId: "cody",
      sessionKey: "agent:cody:main",
    });

    await expect(
      tool.execute("call-lane-block", { path: "src/main.ts", content: "x" }, undefined, undefined),
    ).rejects.toThrow("Workflow lane gate: missing ANCHOR.");
    expect(execute).not.toHaveBeenCalled();
    expect(hookRunner.runBeforeToolCall).not.toHaveBeenCalled();
  });

  it("allows mutation after ANCHOR/REVIEW/VERIFY progression through hook wiring", async () => {
    hookRunner.hasHooks.mockReturnValue(false);
    const stage = {
      anchor: false,
      review: false,
      verify: false,
    };
    mockEvaluateWorkflowLaneGuard.mockImplementation(({ toolName, params }) => {
      const payload = params && typeof params === "object" ? params : {};
      const command =
        payload &&
        typeof payload === "object" &&
        "command" in payload &&
        typeof payload.command === "string"
          ? payload.command
          : "";

      if (toolName === "exec") {
        if (command.includes("context_builder")) {
          stage.anchor = true;
        }
        if (command.includes("rp-cli review")) {
          stage.review = true;
        }
        if (/\bpnpm\b/.test(command) && /\btest\b/.test(command)) {
          stage.verify = true;
        }
        return { blocked: false };
      }

      if (toolName === "write" && (!stage.anchor || !stage.review || !stage.verify)) {
        const missing = !stage.anchor ? "ANCHOR" : !stage.review ? "REVIEW" : "VERIFY";
        return { blocked: true, reason: `Workflow lane gate: missing ${missing}.` };
      }

      return { blocked: false };
    });

    const exec = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const write = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    // oxlint-disable-next-line typescript/no-explicit-any
    const execTool = wrapToolWithBeforeToolCallHook({ name: "exec", execute: exec } as any, {
      agentId: "cody",
      sessionKey: "agent:cody:main",
    });
    // oxlint-disable-next-line typescript/no-explicit-any
    const writeTool = wrapToolWithBeforeToolCallHook({ name: "write", execute: write } as any, {
      agentId: "cody",
      sessionKey: "agent:cody:main",
    });

    await expect(
      writeTool.execute(
        "call-write-pre",
        { path: "src/main.ts", content: "x" },
        undefined,
        undefined,
      ),
    ).rejects.toThrow("missing ANCHOR");

    await execTool.execute(
      "call-anchor",
      { command: 'rp-cli context_builder task="x"' },
      undefined,
      undefined,
    );
    await execTool.execute("call-review", { command: "rp-cli review" }, undefined, undefined);
    await execTool.execute("call-verify", { command: "pnpm -w test" }, undefined, undefined);

    await expect(
      writeTool.execute(
        "call-write-post",
        { path: "src/main.ts", content: "ok" },
        undefined,
        undefined,
      ),
    ).resolves.toEqual({ content: [], details: { ok: true } });
    expect(write).toHaveBeenCalledTimes(1);
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
      sessionId: "ephemeral-main",
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
        sessionId: "ephemeral-main",
      },
    );
  });
});

describe("before_tool_call hook deduplication (#15502)", () => {
  let hookRunner: HookRunnerMock;

  beforeEach(() => {
    resetDiagnosticSessionStateForTest();
    hookRunner = installMockHookRunner({
      hasHooksReturn: true,
      runBeforeToolCallImpl: async () => undefined,
    });
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

describe("before_tool_call hook integration for client tools", () => {
  let hookRunner: HookRunnerMock;

  beforeEach(() => {
    resetDiagnosticSessionStateForTest();
    hookRunner = installMockHookRunner();
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
