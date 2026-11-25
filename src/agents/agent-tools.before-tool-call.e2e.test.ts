/**
 * Integration-style tests for before_tool_call behavior.
 * Covers diagnostics, plugin approval, and skill telemetry
 * around wrapped tool execution.
 */
import os from "node:os";
import path from "node:path";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { GatewayClientRequestError } from "../gateway/client.js";
import { createAbortError } from "../infra/abort-signal.js";
import {
  onInternalDiagnosticEvent,
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
  type DiagnosticEventPrivateData,
} from "../infra/diagnostic-events.js";
import { MAX_PLUGIN_APPROVAL_TIMEOUT_MS } from "../infra/plugin-approvals.js";
import { resetDiagnosticRunActivityForTest } from "../logging/diagnostic-run-activity.js";
import { resetDiagnosticSessionStateForTest } from "../logging/diagnostic-session-state.js";
import {
  PluginApprovalResolutions,
  type PluginApprovalResolution,
  type PluginHookBeforeToolCallResult,
} from "../plugins/hook-before-tool-call-result.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { createHookRunner, type HookRunner } from "../plugins/hooks.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { createDeferredCore } from "../shared/deferred.js";
import { consumeRunSkillUsage } from "../skills/runtime/run-usage.js";
import { createCanonicalFixtureSkill } from "../skills/test-support/test-helpers.js";
import {
  type HookContext,
  getBeforeToolCallFailureDisposition,
  runBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "./agent-tools.before-tool-call.js";
import type { AnyAgentTool } from "./tools/common.js";
import { callGatewayTool } from "./tools/gateway.js";

vi.mock("../plugins/hook-runner-global.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/hook-runner-global.js")>(
    "../plugins/hook-runner-global.js",
  );
  return {
    ...actual,
    getGlobalHookRunner: vi.fn(actual.getGlobalHookRunner),
  };
});
vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);
const hookRunnerGlobalStateKey = Symbol.for("openclaw.plugins.hook-runner-global-state");

function setGlobalHookRunnerForTest(hookRunner: HookRunner | null): void {
  const hookRunnerGlobalState = globalThis as Record<
    symbol,
    { hookRunner: HookRunner | null; registry?: unknown } | undefined
  >;
  if (!hookRunnerGlobalState[hookRunnerGlobalStateKey]) {
    hookRunnerGlobalState[hookRunnerGlobalStateKey] = {
      hookRunner: null,
      registry: null,
    };
  }
  hookRunnerGlobalState[hookRunnerGlobalStateKey].hookRunner = hookRunner;
}

function getGlobalHookRunnerForTest(): HookRunner | null {
  const hookRunnerGlobalState = globalThis as Record<
    symbol,
    { hookRunner: HookRunner | null; registry?: unknown } | undefined
  >;
  return hookRunnerGlobalState[hookRunnerGlobalStateKey]?.hookRunner ?? null;
}

type TestHookRunner = HookRunner & {
  hasHooks: ReturnType<typeof vi.fn<HookRunner["hasHooks"]>>;
  runBeforeToolCall: ReturnType<typeof vi.fn<HookRunner["runBeforeToolCall"]>>;
};

function createTestHookRunner(): TestHookRunner {
  return {
    ...createHookRunner(createEmptyPluginRegistry()),
    hasHooks: vi.fn<HookRunner["hasHooks"]>(),
    runBeforeToolCall: vi.fn<HookRunner["runBeforeToolCall"]>(),
  };
}

function asAgentTool(tool: { name: string; execute: ReturnType<typeof vi.fn> }): AnyAgentTool {
  return tool as unknown as AnyAgentTool;
}

afterEach(() => {
  resetDiagnosticRunActivityForTest();
  setGlobalHookRunnerForTest(null);
  mockGetGlobalHookRunner.mockReset();
  mockGetGlobalHookRunner.mockImplementation(() => getGlobalHookRunnerForTest());
});

describe("before_tool_call diagnostics behavior", () => {
  let hookRunner: TestHookRunner;

  beforeEach(() => {
    resetDiagnosticSessionStateForTest();
    resetDiagnosticEventsForTest();
    hookRunner = createTestHookRunner();
    mockGetGlobalHookRunner.mockReturnValue(hookRunner);
    hookRunner.hasHooks.mockReturnValue(false);
  });

  async function withToolExecutionEvents(
    run: (emitted: DiagnosticEventPayload[]) => Promise<void>,
  ) {
    const emitted: DiagnosticEventPayload[] = [];
    const stop = onInternalDiagnosticEvent((evt) => {
      if (evt.type.startsWith("tool.execution.")) {
        emitted.push(evt);
      }
    });
    try {
      await run(emitted);
    } finally {
      stop();
    }
  }

  async function withDiagnosticEvents(run: (emitted: DiagnosticEventPayload[]) => Promise<void>) {
    const emitted: DiagnosticEventPayload[] = [];
    const stop = onInternalDiagnosticEvent((evt) => {
      emitted.push(evt);
    });
    try {
      await run(emitted);
    } finally {
      stop();
    }
  }

  async function withSkillUsageDiagnosticEvents(
    run: (
      emitted: DiagnosticEventPayload[],
      privateData: DiagnosticEventPrivateData[],
    ) => Promise<void>,
  ) {
    const emitted: DiagnosticEventPayload[] = [];
    const skillUsagePrivateData: DiagnosticEventPrivateData[] = [];
    const stopShared = onInternalDiagnosticEvent((event) => emitted.push(event));
    const stopTrusted = onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
      if (event.type === "skill.used") {
        skillUsagePrivateData.push(privateData);
      }
    });
    try {
      await run(emitted, skillUsagePrivateData);
    } finally {
      stopTrusted();
      stopShared();
    }
  }

  const requireRecord = createRequireRecord("object", "label-not-object");

  function expectEventFields(
    event: DiagnosticEventPayload | undefined,
    fields: Record<string, unknown>,
  ): Record<string, unknown> {
    const record = requireRecord(event, "diagnostic event");
    for (const [key, value] of Object.entries(fields)) {
      expect(record[key]).toEqual(value);
    }
    return record;
  }

  it("emits diagnostic tool execution events without parameter values", async () => {
    const trace = {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: "01",
    };
    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "bash", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      sessionId: "session-id",
      runId: "run-1",
      trace,
    });

    await withToolExecutionEvents(async (emitted) => {
      await tool.execute(
        "tool-call-1",
        { command: "pwd", token: "sk-1234567890abcdef1234567890abcdef" },
        undefined,
        undefined,
      );
      await waitForDiagnosticEventsDrained();

      expect(emitted.map((evt) => evt.type)).toEqual([
        "tool.execution.started",
        "tool.execution.completed",
      ]);
      const started = expectEventFields(emitted[0], {
        type: "tool.execution.started",
        runId: "run-1",
        sessionKey: "session-key",
        sessionId: "session-id",
        toolName: "exec",
        toolCallId: "tool-call-1",
        paramsSummary: {
          kind: "object",
        },
      });
      const startedTrace = requireRecord(started.trace, "started trace");
      expect(startedTrace.traceId).toBe(trace.traceId);
      expect(startedTrace.parentSpanId).toBe(trace.spanId);
      expect(typeof startedTrace.spanId).toBe("string");
      expect(startedTrace.traceFlags).toBe(trace.traceFlags);
      expect(emitted[0]?.trace).not.toBe(trace);
      expect(Object.isFrozen(emitted[0]?.trace)).toBe(true);
      const completed = expectEventFields(emitted[1], {
        type: "tool.execution.completed",
      });
      expect(typeof completed.durationMs).toBe("number");
      expect(JSON.stringify(emitted)).not.toContain("sk-1234567890abcdef1234567890abcdef");
      expect(JSON.stringify(emitted)).not.toContain("pwd");
    });
  });

  it.each([
    { label: "fails", error: new Error("hook crashed"), terminalReason: "failed" },
    {
      label: "times out",
      error: Object.assign(new Error("timed out after 5ms"), { name: "TimeoutError" }),
      terminalReason: "timed_out",
    },
  ] as const)(
    "emits a terminal diagnostic when a before_tool_call hook $label",
    async (testCase) => {
      hookRunner.hasHooks.mockImplementation((hookName: string) => hookName === "before_tool_call");
      hookRunner.runBeforeToolCall.mockRejectedValueOnce(testCase.error);
      const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
      const tool = wrapToolWithBeforeToolCallHook(
        { name: "exec", execute } as unknown as AnyAgentTool,
        {
          agentId: "main",
          sessionKey: "session-key",
          sessionId: "session-id",
          runId: "run-1",
        },
      );

      await withToolExecutionEvents(async (emitted) => {
        await expect(
          tool.execute("tool-call-hook-failure", { command: "private" }, undefined, undefined),
        ).rejects.toThrow("Tool call blocked because before_tool_call hook failed");
        await waitForDiagnosticEventsDrained();

        expect(execute).not.toHaveBeenCalled();
        expect(emitted.map((event) => event.type)).toEqual(["tool.execution.error"]);
        const terminal = expectEventFields(emitted[0], {
          type: "tool.execution.error",
          runId: "run-1",
          sessionKey: "session-key",
          sessionId: "session-id",
          agentId: "main",
          toolName: "exec",
          toolCallId: "tool-call-hook-failure",
          paramsSummary: { kind: "object" },
          errorCategory: "before_tool_call",
          terminalReason: testCase.terminalReason,
        });
        expect(typeof terminal.durationMs).toBe("number");
        expect(JSON.stringify(emitted)).not.toContain("private");
      });
    },
  );

  it("emits a terminal diagnostic when hook preflight rejects", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const params = { path: "/tmp/file" };
    hookRunner.hasHooks.mockReturnValue(true);
    hookRunner.runBeforeToolCall.mockRejectedValue(new Error("private hook preflight failure"));
    const tool = wrapToolWithBeforeToolCallHook(
      { name: "read", execute } as unknown as AnyAgentTool,
      {
        agentId: "main",
        sessionKey: "session-key",
        runId: "run-1",
      },
    );

    await withToolExecutionEvents(async (emitted) => {
      await expect(
        tool.execute("tool-call-preflight", params, undefined, undefined),
      ).rejects.toThrow("Tool call blocked because before_tool_call hook failed");
      await waitForDiagnosticEventsDrained();

      expect(execute).not.toHaveBeenCalled();
      expect(emitted.map((event) => event.type)).toEqual(["tool.execution.error"]);
      expectEventFields(emitted[0], {
        type: "tool.execution.error",
        runId: "run-1",
        sessionKey: "session-key",
        agentId: "main",
        toolName: "read",
        toolCallId: "tool-call-preflight",
        paramsSummary: { kind: "object" },
        errorCategory: "before_tool_call",
        terminalReason: "failed",
      });
      expect(JSON.stringify(emitted)).not.toContain("private hook preflight failure");
    });
  });

  it("preserves preparation timeout disposition when wrapper diagnostics are delegated", async () => {
    const timeout = Object.assign(new Error("private preparation timeout"), {
      name: "TimeoutError",
    });
    const tool = wrapToolWithBeforeToolCallHook(
      {
        name: "exec",
        execute: vi.fn(),
        prepareBeforeToolCallParams: vi.fn().mockRejectedValue(timeout),
      } as unknown as AnyAgentTool,
      { runId: "run-1" },
      { emitDiagnostics: false },
    );

    const error = await tool
      .execute("tool-call-preparation-timeout", { command: "private" }, undefined, undefined)
      .catch((cause: unknown) => cause);

    expect(getBeforeToolCallFailureDisposition(error)).toBe("timed_out");
    expect(error).toHaveProperty("cause", timeout);
  });

  it.each([
    {
      mode: "request",
      reason: "Denied by user",
      description: "Approve tool",
      toolCallId: "tool-call-denied",
    },
    {
      mode: "report",
      reason: "Review before running",
      description: "Review before running",
      toolCallId: "tool-call-report",
    },
  ] as const)(
    "emits a blocked terminal diagnostic for $mode approval denial",
    async ({ mode, reason, description, toolCallId }) => {
      hookRunner.hasHooks.mockImplementation((hookName: string) => hookName === "before_tool_call");
      hookRunner.runBeforeToolCall.mockResolvedValueOnce({
        requireApproval: { title: "Approve", description },
      });
      const mockCallGateway = vi.mocked(callGatewayTool);
      if (mode === "request") {
        mockCallGateway.mockResolvedValueOnce({ id: "approval-1", decision: "deny" });
      }
      const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
      const tool = wrapToolWithBeforeToolCallHook(
        { name: "exec", execute } as unknown as AnyAgentTool,
        { agentId: "main", sessionKey: "session-key", runId: "run-1" },
        { approvalMode: mode },
      );

      await withToolExecutionEvents(async (emitted) => {
        await expect(
          tool.execute(toolCallId, { command: "private" }, undefined, undefined),
        ).rejects.toThrow(reason);
        await waitForDiagnosticEventsDrained();
        expect(execute).not.toHaveBeenCalled();
        if (mode === "report") {
          expect(mockCallGateway).not.toHaveBeenCalled();
          expect(JSON.stringify(emitted)).not.toContain(description);
        }
        expect(emitted.map((event) => event.type)).toEqual(["tool.execution.blocked"]);
        expectEventFields(emitted[0], {
          type: "tool.execution.blocked",
          runId: "run-1",
          sessionKey: "session-key",
          toolName: "exec",
          toolCallId,
          deniedReason: "plugin-approval",
          reason: "plugin-approval",
        });
        expect(JSON.stringify(emitted)).not.toContain("private");
      });
      mockCallGateway.mockReset();
    },
  );

  it("returns a structured denial without an approval request in deny mode", async () => {
    const onResolution = vi.fn();
    hookRunner.hasHooks.mockImplementation((hookName: string) => hookName === "before_tool_call");
    hookRunner.runBeforeToolCall.mockResolvedValueOnce({
      requireApproval: { title: "Approve", description: "Approval required", onResolution },
    });
    const mockCallGateway = vi.mocked(callGatewayTool);
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const tool = wrapToolWithBeforeToolCallHook(
      { name: "exec", execute } as unknown as AnyAgentTool,
      { agentId: "main", sessionKey: "session-key", runId: "run-1" },
      { approvalMode: "deny" },
    );

    const result = await tool.execute("tool-call-deny", { command: "private" });

    expect(result.details).toEqual({
      status: "blocked",
      deniedReason: "plugin-approval",
      reason: "approval_required",
    });
    expect(execute).not.toHaveBeenCalled();
    expect(mockCallGateway).not.toHaveBeenCalled();
    expect(onResolution).toHaveBeenCalledWith(PluginApprovalResolutions.DENY);
    mockCallGateway.mockReset();
  });

  it.each([
    {
      label: "failure",
      details: { status: "failed", exitCode: 1 },
      terminal: {
        type: "tool.execution.error",
        errorCategory: "tool_result_error",
        terminalReason: "failed",
      },
    },
    {
      label: "timeout",
      details: { status: "timeout", timedOut: true },
      terminal: {
        type: "tool.execution.error",
        errorCategory: "tool_result_error",
        terminalReason: "timed_out",
      },
    },
    {
      label: "cancellation",
      details: { status: "cancelled" },
      terminal: {
        type: "tool.execution.error",
        errorCategory: "tool_result_error",
        terminalReason: "cancelled",
      },
    },
    {
      label: "blocked action",
      details: { status: "blocked" },
      terminal: {
        type: "tool.execution.blocked",
        deniedReason: "tool_result_blocked",
        reason: "tool_result_blocked",
      },
    },
  ])("classifies a resolved $label result as terminal failure", async ({ details, terminal }) => {
    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "tool failed" }],
      details,
    });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "exec", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      runId: "run-1",
    });

    await withToolExecutionEvents(async (emitted) => {
      await tool.execute("tool-call-1", { command: "false" }, undefined, undefined);
      await waitForDiagnosticEventsDrained();

      expect(emitted.map((event) => event.type)).toEqual(["tool.execution.started", terminal.type]);
      expectEventFields(emitted[1], terminal);
    });
  });

  it("classifies plugin and MCP tool execution diagnostics with bounded owner labels", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const rawTool = { name: "mcp_search", execute } as unknown as AnyAgentTool;
    setPluginToolMeta(rawTool, { pluginId: "bundle-mcp", optional: false });
    const tool = wrapToolWithBeforeToolCallHook(rawTool, {
      agentId: "main",
      sessionKey: "session-key",
    });

    await withToolExecutionEvents(async (emitted) => {
      await tool.execute("tool-call-mcp", { query: "status" }, undefined, undefined);
      await waitForDiagnosticEventsDrained();

      expectEventFields(emitted[0], {
        type: "tool.execution.started",
        toolName: "mcp_search",
        toolSource: "mcp",
        toolOwner: "bundle-mcp",
      });
      expectEventFields(emitted[1], {
        type: "tool.execution.completed",
        toolSource: "mcp",
        toolOwner: "bundle-mcp",
      });
    });
  });

  function skillReadContext(
    skill: Parameters<typeof createCanonicalFixtureSkill>[0],
    workspaceDir?: string,
  ): HookContext {
    return {
      workspaceDir,
      skillsSnapshot: {
        prompt: "",
        skills: [{ name: skill.name }],
        resolvedSkills: [createCanonicalFixtureSkill(skill)],
      },
    };
  }

  const workspaceDir = path.join("/tmp", "openclaw-skill-usage");
  const workspaceSkillDir = path.join(workspaceDir, ".agents", "skills", "demo-skill");
  const workspaceSkillFile = path.join(workspaceSkillDir, "SKILL.md");
  const homeSkillDir = path.join(os.homedir(), ".openclaw", "skills", "home-skill");
  const homeSkillFile = path.join(homeSkillDir, "SKILL.md");
  const remoteSkillFile = "node://node-1/skills/remote-skill/SKILL.md";
  const skillReadCases: Array<{
    label: string;
    ctx: HookContext;
    params: Record<string, unknown>;
    expected?: Record<string, unknown>;
    privateFile?: string;
    forbidden: string[];
    trackRun?: boolean;
  }> = [
    {
      label: "workspace instruction",
      ctx: {
        ...skillReadContext(
          {
            name: "demo-skill",
            description: "Demo",
            filePath: workspaceSkillFile,
            baseDir: workspaceSkillDir,
            source: "workspace",
          },
          workspaceDir,
        ),
        sessionId: "session-id",
        runId: "run-1",
      },
      params: { path: `${path.join(".agents", "skills", "demo-skill", "SKILL.md")}</arg_value>>` },
      expected: {
        agentId: "main",
        runId: "run-1",
        sessionKey: "session-key",
        sessionId: "session-id",
        skillName: "demo-skill",
        skillSource: "workspace",
        toolCallId: "skill-read",
      },
      privateFile: workspaceSkillFile,
      forbidden: [workspaceSkillFile, "SKILL.md", workspaceSkillDir],
      trackRun: true,
    },
    {
      label: "home-compacted instruction",
      ctx: skillReadContext(
        {
          name: "home-skill",
          description: "Home skill",
          filePath: homeSkillFile,
          baseDir: homeSkillDir,
          source: "openclaw-managed",
        },
        "/tmp/openclaw-workspace",
      ),
      params: { path: "~/.openclaw/skills/home-skill/SKILL.md" },
      expected: { skillName: "home-skill", skillSource: "workspace" },
      privateFile: homeSkillFile,
      forbidden: [homeSkillFile, os.homedir()],
    },
    {
      label: "node locator",
      ctx: skillReadContext({
        name: "remote-skill",
        description: "Remote skill",
        filePath: remoteSkillFile,
        baseDir: "node://node-1/skills/remote-skill",
        source: "openclaw-node",
      }),
      params: { path: remoteSkillFile },
      expected: { skillName: "remote-skill" },
      forbidden: [],
    },
    {
      label: "sandbox instruction",
      ctx: {
        workspaceDir: "/workspace",
        skillUsagePaths: [
          {
            readPath: "/workspace/.openclaw/sandbox-skills/skills/demo/SKILL.md",
            skillFile: "/agent-workspace/skills/demo/SKILL.md",
            skillName: "demo",
            skillSource: "workspace",
          },
        ],
      },
      params: { path: ".openclaw/sandbox-skills/skills/demo/SKILL.md" },
      expected: { skillName: "demo", skillSource: "workspace" },
      privateFile: "/agent-workspace/skills/demo/SKILL.md",
      forbidden: ["/agent-workspace/skills/demo/SKILL.md"],
    },
    {
      label: "unused read parameter",
      ctx: skillReadContext(
        {
          name: "demo-skill",
          description: "Demo",
          filePath: workspaceSkillFile,
          baseDir: workspaceSkillDir,
          source: "workspace",
        },
        workspaceDir,
      ),
      params: { path: "README.md", file: path.join(".agents", "skills", "demo-skill", "SKILL.md") },
      forbidden: [],
    },
  ];

  it.each(skillReadCases)(
    "accounts for a $label read without exposing its path",
    async ({ ctx, params, expected, privateFile, forbidden, trackRun }) => {
      const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "skill" }] });
      const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
        agentId: "main",
        sessionKey: "session-key",
        ...ctx,
      });

      await withSkillUsageDiagnosticEvents(async (emitted, privateData) => {
        await tool.execute("skill-read", params, undefined, undefined);
        await waitForDiagnosticEventsDrained();
        expect(emitted.map((evt) => evt.type)).toEqual([
          "tool.execution.started",
          ...(expected ? ["skill.used"] : []),
          "tool.execution.completed",
        ]);
        if (expected) {
          expectEventFields(emitted[1], {
            type: "skill.used",
            activation: "read",
            toolName: "read",
            ...expected,
          });
        }
        for (const value of forbidden) {
          expect(JSON.stringify(emitted)).not.toContain(value);
        }
        if (privateFile) {
          expect(privateData[0]?.skillUsage?.skillFile).toBe(privateFile);
        }
        if (trackRun) {
          expect(consumeRunSkillUsage("run-1")).toEqual([
            {
              name: "demo-skill",
              source: "workspace",
              activation: "read",
              skillFile: workspaceSkillFile,
            },
          ]);
          expect(consumeRunSkillUsage("run-1")).toEqual([]);
        }
      });
    },
  );

  it("emits skill usage diagnostics for command-dispatched skill tools", async () => {
    const skillBaseDir = path.join("/tmp", "openclaw-skill-command", "skills", "matrix-profile");
    const skillFilePath = path.join(skillBaseDir, "SKILL.md");
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "sent" }] });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "message", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      sessionId: "session-id",
      skillCommand: {
        commandName: "set_profile",
        skillFile: skillFilePath,
        skillName: "matrix-profile",
        skillSource: "workspace",
        toolName: "message",
      },
    });

    await withSkillUsageDiagnosticEvents(async (emitted, privateData) => {
      await tool.execute(
        "tool-call-skill-command",
        { command: "display name", commandName: "set_profile", skillName: "matrix-profile" },
        undefined,
        undefined,
      );
      await waitForDiagnosticEventsDrained();

      expect(emitted.map((evt) => evt.type)).toEqual([
        "tool.execution.started",
        "skill.used",
        "tool.execution.completed",
      ]);
      expectEventFields(emitted[1], {
        type: "skill.used",
        skillName: "matrix-profile",
        skillSource: "workspace",
        activation: "command",
        toolName: "message",
        toolCallId: "tool-call-skill-command",
      });
      expect(JSON.stringify(emitted[1])).not.toContain(skillFilePath);
      expect(privateData[0]?.skillUsage?.skillFile).toBe(skillFilePath);
      expect(JSON.stringify(emitted)).not.toContain("display name");
    });
  });

  it.each([
    {
      label: "redacted error",
      error: Object.assign(new Error("failed with key sk-1234567890abcdef1234567890abcdef"), {
        code: "SECRET_TOKEN",
        status: 429,
      }),
      errorCategory: "Error",
      errorCode: "429",
    },
    {
      label: "hostile thrown value",
      error: new Proxy(
        {},
        {
          get() {
            throw new Error("diagnostic getter should not run");
          },
          getOwnPropertyDescriptor() {
            throw new Error("diagnostic descriptor failed");
          },
        },
      ),
      errorCategory: "object",
      errorCode: undefined,
    },
  ])("emits safe diagnostic events for a $label", async ({ error, errorCategory, errorCode }) => {
    const execute = vi.fn().mockRejectedValue(error);
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      agentId: "main",
      sessionKey: "session-key",
    });

    await withToolExecutionEvents(async (emitted) => {
      const execution = tool.execute(
        "tool-call-error",
        { path: "/tmp/file" },
        undefined,
        undefined,
      );
      await expect(execution).rejects.toBe(error);
      if (errorCode) {
        await expect(execution).rejects.toThrow("failed with key");
      }
      await waitForDiagnosticEventsDrained();

      expect(emitted.map((evt) => evt.type)).toEqual([
        "tool.execution.started",
        "tool.execution.error",
      ]);
      const errorEvent = expectEventFields(emitted[1], {
        type: "tool.execution.error",
        toolName: "read",
        toolCallId: "tool-call-error",
        errorCategory,
        ...(errorCode ? { errorCode } : {}),
      });
      if (!errorCode) {
        expect(errorEvent).not.toHaveProperty("errorCode");
      }
      expect(typeof errorEvent.durationMs).toBe("number");
      expect(JSON.stringify(emitted[1])).not.toContain("SECRET_TOKEN");
      expect(JSON.stringify(emitted[1])).not.toContain("sk-1234567890abcdef1234567890abcdef");
    });
  });

  it.each([
    {
      label: "run cancellation",
      abort: true,
      abortReason: undefined,
      message: "tool stopped with run",
      toolCallId: "tool-call-cancelled",
      terminalReason: "cancelled",
    },
    {
      label: "run timeout",
      abort: true,
      abortReason: Object.assign(new Error("timed out"), { name: "TimeoutError" }),
      message: "tool stopped with timeout",
      toolCallId: "tool-call-timeout",
      terminalReason: "timed_out",
    },
    {
      label: "tool-local timeout",
      abort: false,
      abortReason: undefined,
      message: "tool deadline elapsed",
      toolCallId: "tool-call-local-timeout",
      terminalReason: "timed_out",
    },
  ])(
    "classifies $label in terminal diagnostics",
    async ({ abort, abortReason, message, toolCallId, terminalReason }) => {
      const controller = new AbortController();
      const execute = vi.fn().mockImplementation(() => {
        if (abort) {
          controller.abort(abortReason);
        }
        throw Object.assign(new Error(message), { name: abort ? "Error" : "TimeoutError" });
      });
      const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
        agentId: "main",
        sessionKey: "session-key",
      });

      await withToolExecutionEvents(async (emitted) => {
        await expect(
          tool.execute(toolCallId, { path: "/tmp/file" }, controller.signal, undefined),
        ).rejects.toThrow(message);
        await waitForDiagnosticEventsDrained();
        expectEventFields(emitted[1], {
          type: "tool.execution.error",
          toolCallId,
          terminalReason,
          ...(terminalReason === "cancelled" ? { errorCategory: "aborted" } : {}),
        });
      });
    },
  );

  it("emits blocked and security diagnostics for intentional hook vetoes", async () => {
    hookRunner.hasHooks.mockImplementation((hookName: string) => hookName === "before_tool_call");
    hookRunner.runBeforeToolCall.mockResolvedValue({
      block: true,
      blockReason: "blocked by policy",
    });
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "nope" }] });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      agentId: "main",
      sessionKey: "session-key",
    });

    await withDiagnosticEvents(async (emitted) => {
      const result = await tool.execute("tool-call-blocked", { path: "/tmp/file" });
      await waitForDiagnosticEventsDrained();

      expect(result).toEqual({
        content: [{ type: "text", text: "blocked by policy" }],
        details: {
          status: "blocked",
          deniedReason: "plugin-before-tool-call",
          reason: "blocked by policy",
        },
      });
      expect(execute).not.toHaveBeenCalled();
      expect(
        emitted
          .filter((event) => event.type.startsWith("tool.execution."))
          .map((event) => event.type),
      ).toEqual(["tool.execution.blocked"]);
      expectEventFields(
        emitted.find((event) => event.type === "tool.execution.blocked"),
        {
          type: "tool.execution.blocked",
          toolName: "read",
          toolCallId: "tool-call-blocked",
          deniedReason: "plugin-before-tool-call",
          reason: "blocked by policy",
        },
      );
      const securityEvent = emitted.find(
        (event): event is Extract<DiagnosticEventPayload, { type: "security.event" }> =>
          event.type === "security.event",
      );
      expect(securityEvent).toMatchObject({
        type: "security.event",
        category: "tool",
        action: "tool.execution.blocked",
        outcome: "denied",
        severity: "medium",
        reason: "plugin-before-tool-call",
        actor: { kind: "agent" },
        target: {
          kind: "tool",
          name: "read",
        },
        policy: {
          id: "plugin-before-tool-call",
          decision: "deny",
          reason: "plugin-before-tool-call",
        },
        control: {
          id: "before-tool-call",
          family: "approval",
        },
        attributes: {
          params_kind: "object",
          tool_source: "core",
        },
      });
      expect(securityEvent?.eventId).toBeTypeOf("string");
      expect(JSON.stringify(securityEvent)).not.toContain("/tmp/file");
      expect(emitted.some((event) => event.type === "tool.execution.blocked")).toBe(true);
    });
  });

  it("summarizes hostile object params without enumerating keys", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "bash", execute }), {
      agentId: "main",
      sessionKey: "session-key",
    });
    const params = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("should not enumerate params");
        },
      },
    );

    await withToolExecutionEvents(async (emitted) => {
      await tool.execute("tool-call-proxy", params, undefined, undefined);
      await waitForDiagnosticEventsDrained();

      const started = expectEventFields(emitted[0], {
        type: "tool.execution.started",
      });
      expect(started.paramsSummary).toEqual({ kind: "object" });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0]?.[1]).toBe(params);
    });
  });
});

describe("before_tool_call requireApproval handling", () => {
  let hookRunner: TestHookRunner;
  const mockCallGateway = vi.mocked(callGatewayTool);

  const requireRecord = createRequireRecord("object", "label-not-object");

  function requireHookCall(
    index: number,
  ): [event: Record<string, unknown>, context: Record<string, unknown>] {
    const call = hookRunner.runBeforeToolCall.mock.calls[index] as unknown[] | undefined;
    if (!call) {
      throw new Error(`missing before_tool_call hook call ${index + 1}`);
    }
    return [
      requireRecord(call[0], "before_tool_call event"),
      requireRecord(call[1], "before_tool_call context"),
    ];
  }

  function requireGatewayCall(index: number): unknown[] {
    const call = mockCallGateway.mock.calls[index] as unknown[] | undefined;
    if (!call) {
      throw new Error(`missing gateway call ${index + 1}`);
    }
    return call;
  }

  function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
    for (const [key, value] of Object.entries(fields)) {
      expect(record[key]).toEqual(value);
    }
  }

  beforeEach(() => {
    resetDiagnosticSessionStateForTest();
    resetDiagnosticEventsForTest();
    hookRunner = createTestHookRunner();
    hookRunner.hasHooks.mockImplementation((hookName) => hookName === "before_tool_call");
    mockGetGlobalHookRunner.mockReturnValue(hookRunner);
    // Keep the global singleton aligned as a fallback in case another setup path
    // preloads hook-runner-global before this test's module reset/mocks take effect.
    setGlobalHookRunnerForTest(hookRunner);
    mockCallGateway.mockReset();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  async function runAbortDuringApprovalWait(options?: {
    abortReason?: unknown;
    onResolution?: (decision: PluginApprovalResolution) => void | Promise<void>;
  }) {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Abortable",
        description: "Will be aborted",
        onResolution: options?.onResolution,
      },
    });

    const controller = new AbortController();
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-abort", status: "accepted" });
    mockCallGateway.mockImplementationOnce(async (_method, _options, _params, extra) => {
      const signal = extra?.signal;
      if (!signal) {
        throw new Error("Expected approval transport abort signal");
      }
      const cancelled = createDeferredCore<never>();
      const onAbort = () => cancelled.reject(createAbortError("gateway request aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
      controller.abort(options?.abortReason ?? new Error("run cancelled"));
      try {
        return await cancelled.promise;
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    });

    return await runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: { agentId: "main", sessionKey: "main" },
      signal: controller.signal,
    });
  }

  it("blocks without triggering approval when both block and requireApproval are set", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      block: true,
      blockReason: "Blocked by security plugin",
      requireApproval: {
        title: "Should not reach gateway",
        description: "This approval should be skipped",
        pluginId: "lower-priority-plugin",
      },
    });

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { command: "rm -rf" },
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("reason", "Blocked by security plugin");
    expect(mockCallGateway).not.toHaveBeenCalled();
  });

  it("passes diagnostic trace context to before_tool_call hooks", async () => {
    const trace = {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: "01",
    };
    hookRunner.runBeforeToolCall.mockResolvedValue(undefined);

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { command: "pwd" },
      toolCallId: "tool-1",
      ctx: { agentId: "main", sessionKey: "main", runId: "run-1", trace },
    });

    expect(result.blocked).toBe(false);
    const [event, toolContext] = requireHookCall(0);
    expectRecordFields(event, {
      toolName: "exec",
      runId: "run-1",
      toolCallId: "tool-1",
    });
    expectRecordFields(toolContext, {
      toolName: "exec",
      runId: "run-1",
      toolCallId: "tool-1",
    });
    expect(toolContext.trace).toEqual(trace);
    expect(toolContext.trace).not.toBe(trace);
    expect(Object.isFrozen(toolContext.trace)).toBe(true);
  });

  it("passes host-derived apply_patch paths to before_tool_call hooks", async () => {
    const cwd = path.join("/tmp", "openclaw-hooks");
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+x",
      "*** Update File: src/old.ts",
      "*** Move to: src/renamed.ts",
      "@@",
      "+y",
      "*** Delete File: src/dead.ts",
      "*** End Patch",
    ].join("\n");
    hookRunner.runBeforeToolCall.mockResolvedValue(undefined);

    const result = await runBeforeToolCallHook({
      toolName: "apply_patch",
      params: { input: patch },
      toolCallId: "patch-1",
      ctx: { agentId: "main", cwd, sessionKey: "main", runId: "run-patch" },
    });

    expect(result.blocked).toBe(false);
    const [event, context] = requireHookCall(0);
    expectRecordFields(event, {
      toolName: "apply_patch",
      runId: "run-patch",
      toolCallId: "patch-1",
      derivedPaths: [
        path.join(cwd, "src/new.ts"),
        path.join(cwd, "src/old.ts"),
        path.join(cwd, "src/renamed.ts"),
        path.join(cwd, "src/dead.ts"),
      ],
    });
    expectRecordFields(context, {
      toolName: "apply_patch",
      runId: "run-patch",
      toolCallId: "patch-1",
    });
  });

  it.each([
    {
      label: "host-backed",
      rawPath: "/workspace/src/new.ts",
      hostPath: "/host/sandbox/src/new.ts",
      rejected: false,
      toolCallId: "patch-sandbox",
    },
    {
      label: "bridge-native absolute",
      rawPath: "/workspace//src/new.ts",
      hostPath: undefined,
      rejected: false,
      toolCallId: "patch-native",
    },
    {
      label: "rejected",
      rawPath: "/outside.ts",
      hostPath: undefined,
      rejected: true,
      toolCallId: "patch-sandbox-rejected",
    },
  ])(
    "derives $label apply_patch paths through the sandbox bridge",
    async ({ rawPath, hostPath, rejected, toolCallId }) => {
      const patch = ["*** Begin Patch", `*** Add File: ${rawPath}`, "+x", "*** End Patch"].join(
        "\n",
      );
      const resolvePath = vi.fn(({ filePath }: { filePath: string }) => {
        if (rejected) {
          throw new Error("Path escapes sandbox root");
        }
        return {
          containerPath: path.posix.normalize(filePath),
          ...(hostPath ? { hostPath } : {}),
          relativePath: hostPath ? "src/new.ts" : filePath,
        };
      });
      hookRunner.runBeforeToolCall.mockResolvedValue(undefined);
      const result = await runBeforeToolCallHook({
        toolName: "apply_patch",
        params: { input: patch },
        toolCallId,
        ctx: {
          agentId: "main",
          cwd: "/workspace",
          sessionKey: "main",
          runId: "run-patch",
          sandbox: { root: "/workspace", bridge: { resolvePath } as never },
        },
      });

      expect(result.blocked).toBe(false);
      expect(resolvePath).toHaveBeenCalledWith({ filePath: rawPath, cwd: "/workspace" });
      const [event, context] = requireHookCall(0);
      if (rejected) {
        expect(event).not.toHaveProperty("derivedPaths");
      } else {
        expectRecordFields(event, {
          toolName: "apply_patch",
          derivedPaths: [hostPath ?? path.posix.normalize(rawPath)],
        });
      }
      expectRecordFields(context, { toolName: "apply_patch", runId: "run-patch", toolCallId });
    },
  );

  it("derives remote apply_patch shorthand and literal paths like execution", async () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: @reference.md",
      "@@",
      "+reference",
      "*** Update File: @literal.md",
      "@@",
      "+literal",
      "*** End Patch",
    ].join("\n");
    hookRunner.runBeforeToolCall.mockResolvedValue(undefined);
    const resolvePath = ({ filePath }: { filePath: string }) => ({
      containerPath: path.posix.resolve("/workspace", filePath),
      relativePath: filePath,
    });

    const result = await runBeforeToolCallHook({
      toolName: "apply_patch",
      params: { input: patch },
      toolCallId: "patch-remote-at",
      ctx: {
        agentId: "main",
        cwd: "/workspace",
        sandbox: {
          root: "/workspace",
          bridge: {
            resolvePath,
            stat: async ({ filePath }: { filePath: string }) =>
              filePath === "./@literal.md" ? { type: "file", size: 7, mtimeMs: 0 } : null,
          } as never,
        },
        sessionKey: "main",
        runId: "run-patch",
      },
    });

    expect(result.blocked).toBe(false);
    const [event] = requireHookCall(0);
    expectRecordFields(event, {
      toolName: "apply_patch",
      derivedPaths: ["/workspace/reference.md", "/workspace/@literal.md"],
    });
  });

  it("cancels remote apply_patch path derivation with the run", async () => {
    const controller = new AbortController();
    let reportStatSignal!: (signal: AbortSignal | undefined) => void;
    const statStarted = new Promise<AbortSignal | undefined>((resolve) => {
      reportStatSignal = resolve;
    });
    hookRunner.runBeforeToolCall.mockResolvedValue(undefined);

    const running = runBeforeToolCallHook({
      toolName: "apply_patch",
      params: {
        input: ["*** Begin Patch", "*** Update File: @remote.md", "*** End Patch"].join("\n"),
      },
      signal: controller.signal,
      ctx: {
        cwd: "/workspace",
        sandbox: {
          root: "/workspace",
          bridge: {
            resolvePath: ({ filePath }: { filePath: string }) => ({
              containerPath: path.posix.resolve("/workspace", filePath),
              relativePath: filePath,
            }),
            stat: ({ signal }: { signal?: AbortSignal }) => {
              reportStatSignal(signal);
              if (!signal) {
                return Promise.resolve(null);
              }
              return new Promise((_, reject) => {
                signal.addEventListener(
                  "abort",
                  () =>
                    reject(signal.reason instanceof Error ? signal.reason : new Error("aborted")),
                  { once: true },
                );
              });
            },
          } as never,
        },
      },
    });

    const statSignal = await statStarted;
    controller.abort();
    expect(statSignal).toBe(controller.signal);
    await expect(running).resolves.toMatchObject({
      blocked: true,
      kind: "failure",
      disposition: "cancelled",
    });
  });

  it("skips derived path extraction when no policies or hooks can consume it", async () => {
    hookRunner.hasHooks.mockReturnValue(false);
    const params = {};
    Object.defineProperty(params, "input", {
      enumerable: true,
      get() {
        throw new Error("should not derive paths");
      },
    });

    await expect(
      runBeforeToolCallHook({
        toolName: "apply_patch",
        params,
        toolCallId: "patch-no-hooks",
      }),
    ).resolves.toEqual({ blocked: false, params });
    expect(hookRunner.runBeforeToolCall).not.toHaveBeenCalled();
  });

  it("recomputes host-derived paths after trusted policy param rewrites", async () => {
    const cwd = path.join("/tmp", "openclaw-hooks");
    const originalPatch = [
      "*** Begin Patch",
      "*** Add File: src/old.ts",
      "+x",
      "*** End Patch",
    ].join("\n");
    const rewrittenPatch = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+x",
      "*** End Patch",
    ].join("\n");
    const seenByLaterPolicy: unknown[] = [];
    const registry = createEmptyPluginRegistry();
    registry.trustedToolPolicies = [
      {
        pluginId: "trusted-rewriter",
        pluginName: "Trusted Rewriter",
        source: "test",
        policy: {
          id: "rewrite",
          description: "rewrite",
          evaluate: () => ({ params: { input: rewrittenPatch } }),
        },
      },
      {
        pluginId: "trusted-inspector",
        pluginName: "Trusted Inspector",
        source: "test",
        policy: {
          id: "inspect",
          description: "inspect",
          evaluate: (event) => {
            seenByLaterPolicy.push(event.derivedPaths);
            return undefined;
          },
        },
      },
    ];
    setActivePluginRegistry(registry);
    hookRunner.runBeforeToolCall.mockResolvedValue(undefined);

    const result = await runBeforeToolCallHook({
      toolName: "apply_patch",
      params: { input: originalPatch },
      toolCallId: "patch-rewrite",
      ctx: { agentId: "main", cwd, sessionKey: "main", runId: "run-patch" },
    });

    expect(result).toEqual({ blocked: false, params: { input: rewrittenPatch } });
    expect(seenByLaterPolicy).toEqual([[path.join(cwd, "src/new.ts")]]);
    const [event] = requireHookCall(0);
    expectRecordFields(event, {
      params: { input: rewrittenPatch },
      derivedPaths: [path.join(cwd, "src/new.ts")],
    });
  });

  function setApproval(
    approval: Partial<NonNullable<PluginHookBeforeToolCallResult["requireApproval"]>> = {},
    params?: Record<string, unknown>,
  ) {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      ...(params ? { params } : {}),
      requireApproval: { title: "Approval", description: "Review tool execution", ...approval },
    });
  }

  function requestApproval(overrides: Partial<Parameters<typeof runBeforeToolCallHook>[0]> = {}) {
    return runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: { agentId: "main", sessionKey: "main" },
      ...overrides,
    });
  }

  it.each([
    { decision: "allow-once", timeoutMs: undefined },
    { decision: "allow-always", timeoutMs: Number.MAX_SAFE_INTEGER },
  ] as const)(
    "returns $decision and notifies the plugin after two-phase approval",
    async ({ decision, timeoutMs }) => {
      const onResolution = vi.fn();
      setApproval({ pluginId: "sage", timeoutMs, onResolution });
      mockCallGateway.mockResolvedValueOnce({ id: "server-id", status: "accepted" });
      mockCallGateway.mockResolvedValueOnce({ id: "server-id", decision });

      const result = await requestApproval({ params: { command: "echo ok" } });

      expect(result).toEqual({
        blocked: false,
        params: { command: "echo ok" },
        approvalResolution: decision,
      });
      expect(onResolution).toHaveBeenCalledWith(decision);
      expect(mockCallGateway).toHaveBeenCalledTimes(2);
      const requestCall = requireGatewayCall(0);
      expect(requestCall[0]).toBe("plugin.approval.request");
      const requestClient = requireRecord(requestCall[1], "approval request gateway client");
      const requestParams = requireRecord(requestCall[2], "approval request params");
      expect(requestParams.twoPhase).toBe(true);
      expect(requestCall[3]).toEqual({ expectFinal: false });
      for (const field of [
        "turnSourceChannel",
        "turnSourceTo",
        "turnSourceAccountId",
        "turnSourceThreadId",
      ]) {
        expect(requestParams[field]).toBeUndefined();
      }
      const waitCall = requireGatewayCall(1);
      expect(waitCall[0]).toBe("plugin.approval.waitDecision");
      const waitClient = requireRecord(waitCall[1], "approval wait gateway client");
      expect(waitCall[2]).toEqual({ id: "server-id" });
      if (timeoutMs !== undefined) {
        expect(requestClient.timeoutMs).toBe(MAX_PLUGIN_APPROVAL_TIMEOUT_MS + 10_000);
        expect(requestParams.timeoutMs).toBe(MAX_PLUGIN_APPROVAL_TIMEOUT_MS);
        expect(waitClient.timeoutMs).toBe(MAX_PLUGIN_APPROVAL_TIMEOUT_MS + 10_000);
      }
    },
  );

  it("uses tool-neutral guidance and notifies the plugin for a denied tool call", async () => {
    const onResolution = vi.fn();
    setApproval({ onResolution });
    mockCallGateway.mockResolvedValueOnce({ id: "server-id", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({ id: "server-id", decision: "deny" });

    const result = await requestApproval({ toolName: "web_search", params: { query: "OpenClaw" } });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("disposition", "blocked");
    expect(result).toHaveProperty(
      "reason",
      [
        "Denied by user. The tool call did not run.",
        "This denial is final: the approval request is closed. Do not mention /approve or any other approval command to the user.",
        "Do not run the tool call again or ask the user to approve it again.",
        "If the user still wants the action, explain that a new tool call will trigger a fresh approval request.",
      ].join("\n"),
    );
    expect(onResolution).toHaveBeenCalledWith("deny");
  });

  it.each([
    { label: "an unknown decision", decision: "approved" },
    { label: "an excluded allow decision", decision: "allow-always", restricted: true },
    { label: "a decision for another approval", decision: "allow-once", wrongId: true },
  ])(
    "fails closed on $label without applying approval rewrites",
    async ({ decision, restricted, wrongId }) => {
      const onResolution = vi.fn();
      setApproval(
        {
          onResolution,
          ...(restricted ? { allowedDecisions: ["allow-once", "deny"] } : {}),
        },
        { command: "safe-command" },
      );
      mockCallGateway.mockResolvedValueOnce({ id: "server-id", status: "accepted" });
      mockCallGateway.mockResolvedValueOnce({ id: wrongId ? "other-id" : "server-id", decision });

      const result = await requestApproval({ params: { command: "unsafe-command" } });

      expect(result).toMatchObject({
        blocked: true,
        kind: "failure",
        disposition: "timed_out",
        deniedReason: "plugin-approval",
        reason: "Approval timed out",
        params: { command: "unsafe-command" },
      });
      expect(onResolution).toHaveBeenCalledWith(PluginApprovalResolutions.TIMEOUT);
    },
  );

  it.each([
    {
      label: "unstructured gateway failure",
      phase: "request",
      error: new Error("unknown method plugin.approval.request"),
      reason: "Plugin approval required (gateway unavailable)",
    },
    {
      label: "request validation rejection",
      phase: "request",
      error: new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message:
          "invalid plugin.approval.request params: at /title: must not have more than 80 characters",
      }),
      reason:
        "Plugin approval request rejected: invalid plugin.approval.request params: at /title: must not have more than 80 characters",
    },
    {
      label: "structured service failure",
      phase: "request",
      error: new GatewayClientRequestError({
        code: "UNAVAILABLE",
        message: "approval service unavailable",
      }),
      reason: "Plugin approval required (gateway unavailable)",
    },
    {
      label: "expired accepted approval",
      phase: "wait",
      error: new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "approval expired or not found",
      }),
      reason: "Plugin approval no longer available: approval expired or not found",
    },
  ])("classifies $label and cancels the plugin callback", async ({ phase, error, reason }) => {
    const onResolution = vi.fn();
    setApproval({ title: "x".repeat(81), onResolution });
    if (phase === "wait") {
      mockCallGateway.mockResolvedValueOnce({ id: "plugin:accepted", status: "accepted" });
    }
    mockCallGateway.mockRejectedValueOnce(error);

    const result = await requestApproval();

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("reason", reason);
    expect(onResolution).toHaveBeenCalledWith("cancelled");
  });

  it.each([
    {
      label: "registration has no id",
      response: { status: "error" },
      reason: "Registration returns no id",
    },
    {
      label: "no approval route",
      response: { id: "server-id-immediate", decision: null },
      reason: "Plugin approval unavailable (no approval route)",
    },
  ])("blocks and cancels the plugin callback when $label", async ({ response, reason }) => {
    const onResolution = vi.fn();
    setApproval({ description: "Registration returns no id", onResolution });
    mockCallGateway.mockResolvedValueOnce(response);

    const result = await requestApproval();

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("reason", reason);
    expect(onResolution).toHaveBeenCalledWith("cancelled");
    expect(mockCallGateway.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
    ]);
  });

  it.each([new Error("run cancelled"), "sessions_yield"])(
    "cancels approval and notifies the plugin when the run aborts: %s",
    async (abortReason) => {
      const onResolution = vi.fn();
      const result = await runAbortDuringApprovalWait({ abortReason, onResolution });

      expect(result.blocked).toBe(true);
      expect(result).toHaveProperty("reason", "Approval cancelled (run aborted)");
      expect(mockCallGateway).toHaveBeenCalledTimes(2);
      expect(onResolution).toHaveBeenCalledWith("cancelled");
    },
  );

  it("does not await onResolution before returning approval outcome", async () => {
    const onResolution = vi.fn(() => new Promise<void>(() => {}));

    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Non-blocking callback",
        description: "Should not block tool execution",
        onResolution,
      },
    });

    mockCallGateway.mockResolvedValueOnce({ id: "server-id-r1-nonblocking", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({
      id: "server-id-r1-nonblocking",
      decision: "allow-once",
    });

    let timeoutId: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        runBeforeToolCallHook({
          toolName: "bash",
          params: {},
          ctx: { agentId: "main", sessionKey: "main" },
        }),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error("runBeforeToolCallHook waited for onResolution")),
            250,
          );
        }),
      ]);

      expect(result).toEqual({
        blocked: false,
        params: {},
        approvalResolution: "allow-once",
      });
      expect(onResolution).toHaveBeenCalledWith("allow-once");
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  });

  it.each([
    {
      label: "interactive CLI",
      trigger: "user",
      approvalReviewerDeviceId: "device-tui-reviewer",
      reason: undefined,
    },
    {
      label: "cron",
      trigger: "cron",
      reason: "Plugin approval unavailable: cron runs have no approval-capable initiating surface.",
    },
    {
      label: "non-interactive CLI",
      trigger: "user",
      reason:
        "Plugin approval unavailable: non-interactive CLI runs have no approval-capable initiating surface.",
    },
  ])(
    "requires an approval-capable surface for $label",
    async ({ trigger, reason, approvalReviewerDeviceId }) => {
      const onResolution = vi.fn();
      hookRunner.runBeforeToolCall.mockResolvedValue({
        requireApproval: {
          title: "Unattended approval",
          description: "Command needs review",
          onResolution,
        },
      });

      if (approvalReviewerDeviceId) {
        mockCallGateway.mockResolvedValueOnce({ id: "interactive-id", status: "accepted" });
        mockCallGateway.mockResolvedValueOnce({ id: "interactive-id", decision: "allow-once" });
      }
      const result = await runBeforeToolCallHook({
        toolName: "bash",
        params: { command: "gh run view 1" },
        ctx: {
          agentId: "main",
          sessionKey: "main",
          trigger,
          ...(approvalReviewerDeviceId ? { approvalReviewerDeviceId } : {}),
        },
      });

      if (approvalReviewerDeviceId) {
        expect(result).toMatchObject({ blocked: false, approvalResolution: "allow-once" });
        expect(mockCallGateway.mock.calls.map(([method]) => method)).toEqual([
          "plugin.approval.request",
          "plugin.approval.waitDecision",
        ]);
        return;
      }
      expect(result).toEqual({
        blocked: true,
        kind: "failure",
        disposition: "failed",
        deniedReason: "plugin-approval-unavailable",
        reason,
        params: { command: "gh run view 1" },
      });
      expect(mockCallGateway).not.toHaveBeenCalled();
      expect(onResolution).toHaveBeenCalledWith("cancelled");
    },
  );
});

describe("before_tool_call tool content private-data capture", () => {
  type TrustedToolEvent = {
    event: DiagnosticEventPayload;
    privateData: DiagnosticEventPrivateData;
  };

  beforeEach(() => {
    resetDiagnosticSessionStateForTest();
    resetDiagnosticEventsForTest();
  });

  async function withTrustedToolEvents(run: (emitted: TrustedToolEvent[]) => Promise<void>) {
    const emitted: TrustedToolEvent[] = [];
    const stop = onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
      if (event.type.startsWith("tool.execution.")) {
        emitted.push({ event, privateData });
      }
    });
    try {
      await run(emitted);
    } finally {
      stop();
    }
  }

  function configWithToolContent(): OpenClawConfig {
    return {
      diagnostics: {
        enabled: true,
        otel: {
          enabled: true,
          traces: true,
          captureContent: true,
        },
      },
    };
  }

  it.each([
    { label: "opted-in success", capture: true, fails: false },
    { label: "unconfigured success", capture: false, fails: false },
    { label: "opted-in failure", capture: true, fails: true },
  ])("captures only permitted tool content for $label", async ({ capture, fails }) => {
    const liveParams = { path: "/etc/secret" };
    const output = { content: [{ type: "text", text: "file body" }] };
    const execute = fails
      ? vi.fn().mockRejectedValue(new Error("boom"))
      : vi.fn().mockResolvedValue(output);
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      runId: "run-1",
      ...(capture ? { config: configWithToolContent() } : {}),
    });

    await withTrustedToolEvents(async (emitted) => {
      const execution = tool.execute("call-1", liveParams, undefined, undefined);
      if (fails) {
        await expect(execution).rejects.toThrow("boom");
      } else {
        await execution;
      }
      await waitForDiagnosticEventsDrained();

      const terminal = emitted.find(
        (e) => e.event.type === (fails ? "tool.execution.error" : "tool.execution.completed"),
      );
      expect(terminal).toBeDefined();
      if (capture) {
        expect(terminal?.privateData.toolContent?.toolInput).toEqual({ path: "/etc/secret" });
        expect(terminal?.privateData.toolContent?.toolInput).not.toBe(liveParams);
        expect(terminal?.privateData.toolContent?.toolOutput).toEqual(fails ? undefined : output);
      } else {
        expect(terminal?.privateData.toolContent).toBeUndefined();
      }
      // Public event payload must never carry raw params/results.
      expect(JSON.stringify(terminal?.event)).not.toContain("/etc/secret");
      expect(JSON.stringify(terminal?.event)).not.toContain("file body");
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
