import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDiagnosticSessionStateForTest } from "../logging/diagnostic-session-state.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { toClientToolDefinitions, toToolDefinitions } from "./pi-tool-definition-adapter.js";
import { wrapToolWithAbortSignal } from "./pi-tools.abort.js";
import {
  __testing as beforeToolCallTesting,
  consumeAdjustedParamsForToolCall,
  wrapToolWithBeforeToolCallHook,
} from "./pi-tools.before-tool-call.js";

vi.mock("../plugins/hook-runner-global.js");

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);

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
    beforeToolCallTesting.adjustedParamsByToolCallId.clear();
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
      runId: "run-main",
    });
    const extensionContext = {} as Parameters<typeof tool.execute>[3];

    await tool.execute("call-5", "not-an-object", undefined, extensionContext);

    expect(hookRunner.runBeforeToolCall).toHaveBeenCalledWith(
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
    hookRunner.hasHooks.mockReturnValue(true);
    hookRunner.runBeforeToolCall
      .mockResolvedValueOnce({ params: { marker: "A" } })
      .mockResolvedValueOnce({ params: { marker: "B" } });
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    // oxlint-disable-next-line typescript/no-explicit-any
    const toolA = wrapToolWithBeforeToolCallHook({ name: "Read", execute } as any, {
      runId: "run-a",
    });
    // oxlint-disable-next-line typescript/no-explicit-any
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

describe("before_tool_call contract policy integration", () => {
  let hookRunner: HookRunnerMock;
  let workspaceDir: string;

  beforeEach(() => {
    resetDiagnosticSessionStateForTest();
    hookRunner = installMockHookRunner();
    hookRunner.hasHooks.mockReturnValue(false);
    workspaceDir = mkdtempSync(join(tmpdir(), "openclaw-policy-"));
  });

  function writeContracts() {
    const coreDir = join(workspaceDir, "01_agent_os/core");
    const behaviorDir = join(workspaceDir, "01_agent_os/behavior");
    mkdirSync(coreDir, { recursive: true });
    mkdirSync(behaviorDir, { recursive: true });
    writeFileSync(
      join(coreDir, "tool_permissions.yaml"),
      `version: 1
executive_orchestrator:
  allowed_tools: [file_read, file_write, csv_json_processing, calculation]
  forbidden_tools: [web_browsing, send_message, whatsapp_send, email_send, post_publish]
  write_scopes: [executive/, summaries/]
  max_pages: 0
`,
      "utf8",
    );
    writeFileSync(
      join(behaviorDir, "subagents_registry.yaml"),
      `version: 1
subagents:
  - subagent_id: catering_pipeline_builder
    allowed_tools: [web_browsing, file_read, file_write, csv_json_processing]
    forbidden_tools: [send_message, whatsapp_send, email_send, post_publish]
    write_scopes: [queue/catering_pipeline_builder/]
    max_pages: 2
`,
      "utf8",
    );
  }

  it("blocks executive web browsing from contract policy", async () => {
    writeContracts();
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    // oxlint-disable-next-line typescript/no-explicit-any
    const tool = wrapToolWithBeforeToolCallHook({ name: "browser", execute } as any, {
      agentId: "main",
      sessionKey: "agent:main:main",
      workspaceDir,
    });
    await expect(
      tool.execute("exec-web-1", { url: "https://example.com" }, undefined, undefined),
    ).rejects.toThrow("forbidden by actor policy");
    expect(execute).not.toHaveBeenCalled();
  });

  it("enforces catering write scope from contract policy", async () => {
    writeContracts();
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    // oxlint-disable-next-line typescript/no-explicit-any
    const tool = wrapToolWithBeforeToolCallHook({ name: "write", execute } as any, {
      agentId: "catering_pipeline_builder",
      sessionKey: "agent:catering_pipeline_builder:subagent:test",
      workspaceDir,
    });
    await expect(
      tool.execute(
        "write-bad-1",
        { file_path: "executive/out.md", content: "x" },
        undefined,
        undefined,
      ),
    ).rejects.toThrow("write scope violation");
    await expect(
      tool.execute(
        "write-ok-1",
        { file_path: "queue/catering_pipeline_builder/out.md", content: "x" },
        undefined,
        undefined,
      ),
    ).resolves.toBeDefined();
  });

  it("enforces catering max_pages limits from contract policy", async () => {
    writeContracts();
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    // oxlint-disable-next-line typescript/no-explicit-any
    const tool = wrapToolWithBeforeToolCallHook({ name: "browser", execute } as any, {
      agentId: "catering_pipeline_builder",
      sessionKey: "agent:catering_pipeline_builder:subagent:test",
      workspaceDir,
    });
    await expect(
      tool.execute("browse-1", { url: "https://a.example" }, undefined, undefined),
    ).resolves.toBeDefined();
    await expect(
      tool.execute("browse-2", { url: "https://b.example" }, undefined, undefined),
    ).resolves.toBeDefined();
    await expect(
      tool.execute("browse-3", { url: "https://c.example" }, undefined, undefined),
    ).rejects.toThrow("max pages exceeded");
  });

  it("maps sessions_send to send_message policy", async () => {
    writeContracts();
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    // oxlint-disable-next-line typescript/no-explicit-any
    const tool = wrapToolWithBeforeToolCallHook({ name: "sessions_send", execute } as any, {
      agentId: "catering_pipeline_builder",
      sessionKey: "agent:catering_pipeline_builder:subagent:test",
      workspaceDir,
    });
    await expect(
      tool.execute("sessions-send-1", { sessionKey: "agent:main:main", message: "x" }),
    ).rejects.toThrow("forbidden by actor policy");
  });

  it("reloads contract cache when max_pages changes", async () => {
    writeContracts();
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    // oxlint-disable-next-line typescript/no-explicit-any
    const tool = wrapToolWithBeforeToolCallHook({ name: "browser", execute } as any, {
      agentId: "catering_pipeline_builder",
      sessionKey: "agent:catering_pipeline_builder:subagent:test-hot-reload",
      workspaceDir,
    });
    await expect(
      tool.execute("browse-reload-1", { url: "https://a.example" }, undefined, undefined),
    ).resolves.toBeDefined();
    const behaviorDir = join(workspaceDir, "01_agent_os/behavior");
    writeFileSync(
      join(behaviorDir, "subagents_registry.yaml"),
      `version: 1
subagents:
  - subagent_id: catering_pipeline_builder
    allowed_tools: [web_browsing, file_read, file_write, csv_json_processing]
    forbidden_tools: [send_message, whatsapp_send, email_send, post_publish]
    write_scopes: [queue/catering_pipeline_builder/]
    max_pages: 1
`,
      "utf8",
    );
    await expect(
      tool.execute("browse-reload-2", { url: "https://b.example" }, undefined, undefined),
    ).rejects.toThrow("max pages exceeded");
  });

  it("blocks when contract files are malformed", async () => {
    const coreDir = join(workspaceDir, "01_agent_os/core");
    mkdirSync(coreDir, { recursive: true });
    writeFileSync(join(coreDir, "tool_permissions.yaml"), "executive_orchestrator: [", "utf8");
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    // oxlint-disable-next-line typescript/no-explicit-any
    const tool = wrapToolWithBeforeToolCallHook({ name: "browser", execute } as any, {
      agentId: "main",
      sessionKey: "agent:main:main",
      workspaceDir,
    });
    await expect(
      tool.execute("exec-malformed-1", { url: "https://example.com" }, undefined, undefined),
    ).rejects.toThrow("tool permission contracts invalid");
    expect(execute).not.toHaveBeenCalled();
  });

  afterEach(() => {
    if (workspaceDir) {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});
