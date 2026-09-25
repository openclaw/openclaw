import fs from "node:fs/promises";
/**
 * Integration-style tests for before_tool_call behavior.
 * Covers loop detection, diagnostics, plugin approval, and skill telemetry
 * around wrapped tool execution.
 */
import os from "node:os";
import path from "node:path";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../gateway/client.js";
import { createAbortError } from "../infra/abort-signal.js";
import { resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import { resetDiagnosticRunActivityForTest } from "../logging/diagnostic-run-activity.js";
import { resetDiagnosticSessionStateForTest } from "../logging/diagnostic-session-state.js";
import {
  PluginApprovalResolutions,
  type PluginApprovalResolution,
} from "../plugins/hook-before-tool-call-result.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { createHookRunner, type HookRunner } from "../plugins/hooks.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { runBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { callGatewayTool } from "./tools/gateway.js";

afterEach(() => {
  resetDiagnosticRunActivityForTest();
  setGlobalHookRunnerForTest(null);
  mockGetGlobalHookRunner.mockReset();
  mockGetGlobalHookRunner.mockImplementation(() => getGlobalHookRunnerForTest());
});

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

describe("before_tool_call requireApproval handling", () => {
  let hookRunner: TestHookRunner;
  const mockCallGateway = vi.mocked(callGatewayTool);

  const requireRecord = createRequireRecord("object", "label-not-object");

  function requireGatewayCall(index: number): unknown[] {
    const call = mockCallGateway.mock.calls[index] as unknown[] | undefined;
    if (!call) {
      throw new Error(`missing gateway call ${index + 1}`);
    }
    return call;
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

  it("blocks exact allow decisions excluded by the request", async () => {
    const onResolution = vi.fn();
    hookRunner.runBeforeToolCall.mockResolvedValue({
      params: { command: "safe-command" },
      requireApproval: {
        title: "Restricted approval",
        description: "Allow once only",
        allowedDecisions: ["allow-once", "deny"],
        onResolution,
      },
    });
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-restricted", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({
      id: "server-id-restricted",
      decision: "allow-always",
    });

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { command: "unsafe-command" },
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result).toMatchObject({
      blocked: true,
      disposition: "timed_out",
      reason: "Approval timed out",
      params: { command: "unsafe-command" },
    });
    expect(onResolution).toHaveBeenCalledWith(PluginApprovalResolutions.TIMEOUT);
  });

  it("blocks a wait decision bound to another approval id", async () => {
    const onResolution = vi.fn();
    hookRunner.runBeforeToolCall.mockResolvedValue({
      params: { command: "safe-command" },
      requireApproval: {
        title: "Bound approval",
        description: "Must match the request id",
        onResolution,
      },
    });
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-bound", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({
      id: "server-id-other",
      decision: "allow-once",
    });

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { command: "unsafe-command" },
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result).toMatchObject({
      blocked: true,
      disposition: "timed_out",
      reason: "Approval timed out",
      params: { command: "unsafe-command" },
    });
    expect(onResolution).toHaveBeenCalledWith(PluginApprovalResolutions.TIMEOUT);
  });

  it("falls back to block on gateway error", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Gateway down",
        description: "Gateway is unavailable",
      },
    });

    mockCallGateway.mockRejectedValueOnce(new Error("unknown method plugin.approval.request"));

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("reason", "Plugin approval required (gateway unavailable)");
  });

  it.each([
    [
      "surfaces validation rejections",
      new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message:
          "invalid plugin.approval.request params: at /title: must not have more than 80 characters",
      }),
      "Plugin approval request rejected: invalid plugin.approval.request params: at /title: must not have more than 80 characters",
    ],
    [
      "keeps structured service failures on the unavailable fallback",
      new GatewayClientRequestError({
        code: "UNAVAILABLE",
        message: "approval service unavailable",
      }),
      "Plugin approval required (gateway unavailable)",
    ],
  ])("%s", async (_label, error, expectedReason) => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "x".repeat(81),
        description: "Gateway classification test",
      },
    });
    mockCallGateway.mockRejectedValueOnce(error);

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("reason", expectedReason);
  });

  it("reports an expired accepted approval without calling it a request rejection", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: { title: "Approval", description: "Wait phase classification" },
    });
    mockCallGateway
      .mockResolvedValueOnce({ id: "plugin:accepted", status: "accepted" })
      .mockRejectedValueOnce(
        new GatewayClientRequestError({
          code: "INVALID_REQUEST",
          message: "approval expired or not found",
        }),
      );

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result).toHaveProperty(
      "reason",
      "Plugin approval no longer available: approval expired or not found",
    );
  });

  it("blocks when gateway returns no id", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "No ID",
        description: "Registration returns no id",
      },
    });

    mockCallGateway.mockResolvedValueOnce({ status: "error" });

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("reason", "Registration returns no id");
  });

  it("blocks on immediate null decision without calling waitDecision even when timeoutBehavior is allow", async () => {
    const onResolution = vi.fn();

    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "No route",
        description: "No approval route available",
        timeoutBehavior: "allow",
        onResolution,
      },
    });

    mockCallGateway.mockResolvedValueOnce({ id: "server-id-immediate", decision: null });

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("reason", "Plugin approval unavailable (no approval route)");
    expect(onResolution).toHaveBeenCalledWith("cancelled");
    expect(mockCallGateway.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
    ]);
  });

  it("unblocks immediately when abort signal fires during waitDecision", async () => {
    const result = await runAbortDuringApprovalWait();

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("reason", "Approval cancelled (run aborted)");
    expect(mockCallGateway).toHaveBeenCalledTimes(2);
  });

  it("classifies non-Error abort reasons as run abort cancellation", async () => {
    const result = await runAbortDuringApprovalWait({ abortReason: "sessions_yield" });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("reason", "Approval cancelled (run aborted)");
  });

  it("calls onResolution with allow-once on approval", async () => {
    const onResolution = vi.fn();

    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Needs approval",
        description: "Check this",
        onResolution,
      },
    });

    mockCallGateway.mockResolvedValueOnce({ id: "server-id-r1", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-r1", decision: "allow-once" });

    await runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(onResolution).toHaveBeenCalledWith("allow-once");
  });

  it("allows allow-always decisions for tool approvals", async () => {
    const onResolution = vi.fn();

    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Needs durable approval",
        description: "Check this durable approval",
        onResolution,
      },
    });

    mockCallGateway.mockResolvedValueOnce({ id: "server-id-allow-always", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({
      id: "server-id-allow-always",
      decision: "allow-always",
    });

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { command: "echo ok" },
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result).toEqual({
      blocked: false,
      params: { command: "echo ok" },
      approvalResolution: "allow-always",
    });
    expect(onResolution).toHaveBeenCalledWith("allow-always");
  });

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

  it("calls onResolution with deny on denial", async () => {
    const onResolution = vi.fn();

    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Needs approval",
        description: "Check this",
        onResolution,
      },
    });

    mockCallGateway.mockResolvedValueOnce({ id: "server-id-r2", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-r2", decision: "deny" });

    await runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(onResolution).toHaveBeenCalledWith("deny");
  });

  it("calls onResolution with timeout when decision is null", async () => {
    const onResolution = vi.fn();

    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Timeout resolution",
        description: "Will time out",
        onResolution,
      },
    });

    mockCallGateway.mockResolvedValueOnce({ id: "server-id-r3", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-r3", decision: null });

    await runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(onResolution).toHaveBeenCalledWith("timeout");
  });

  it("calls onResolution with cancelled on gateway error", async () => {
    const onResolution = vi.fn();

    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Gateway error",
        description: "Gateway will fail",
        onResolution,
      },
    });

    mockCallGateway.mockRejectedValueOnce(new Error("gateway down"));

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("reason", "Plugin approval required (gateway unavailable)");
    expect(onResolution).toHaveBeenCalledWith("cancelled");
  });

  it("calls onResolution with cancelled when abort signal fires", async () => {
    const onResolution = vi.fn();
    const result = await runAbortDuringApprovalWait({ onResolution });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("reason", "Approval cancelled (run aborted)");
    expect(onResolution).toHaveBeenCalledWith("cancelled");
  });

  it("calls onResolution with cancelled when gateway returns no id", async () => {
    const onResolution = vi.fn();

    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "No ID",
        description: "Registration returns no id",
        onResolution,
      },
    });

    mockCallGateway.mockResolvedValueOnce({ status: "error" });

    await runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(onResolution).toHaveBeenCalledWith("cancelled");
  });

  it("forwards turn source routing fields from ctx to plugin.approval.request", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Channel-routed approval",
        description: "Must route to telegram",
        pluginId: "my-plugin",
      },
    });

    mockCallGateway.mockResolvedValueOnce({ id: "route-id-1", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({ id: "route-id-1", decision: "allow-once" });

    await runBeforeToolCallHook({
      toolName: "fetch",
      params: { url: "https://example.com" },
      ctx: {
        agentId: "main",
        sessionKey: "main",
        turnSourceChannel: "telegram",
        turnSourceTo: "-100123456789",
        turnSourceAccountId: "acct-42",
        turnSourceThreadId: 9001,
      },
    });

    const requestCall = requireGatewayCall(0);
    expect(requestCall[0]).toBe("plugin.approval.request");
    const requestParams = requireRecord(requestCall[2], "approval request params");
    expect(requestParams.turnSourceChannel).toBe("telegram");
    expect(requestParams.turnSourceTo).toBe("-100123456789");
    expect(requestParams.turnSourceAccountId).toBe("acct-42");
    expect(requestParams.turnSourceThreadId).toBe(9001);
  });

  it("uses the transport channel when tool policy provider differs", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Transport routed approval",
        description: "Must use the transport channel",
        pluginId: "my-plugin",
      },
    });

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hook-route-"));
    await fs.writeFile(path.join(tempDir, "note.txt"), "hello");
    mockCallGateway.mockResolvedValueOnce({ id: "transport-route-id", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({
      id: "transport-route-id",
      decision: "allow-once",
    });

    const tools = createOpenClawCodingTools({
      workspaceDir: tempDir,
      messageProvider: "discord-voice",
      messageChannel: "discord",
      currentChannelId: "native-channel-1",
      currentMessagingTarget: "channel:deliverable-1",
      agentAccountId: "acct-1",
      currentThreadTs: "thread-1",
      approvalReviewerDeviceId: "device-tui-reviewer",
    });
    const readTool = tools.find((tool) => tool.name === "read");
    if (!readTool) {
      throw new Error("missing read tool");
    }
    await readTool.execute("tool-hook-route", { path: "note.txt" }, undefined, undefined);

    const requestCall = requireGatewayCall(0);
    expect(requestCall[0]).toBe("plugin.approval.request");
    const requestParams = requireRecord(requestCall[2], "approval request params");
    expect(requestParams.turnSourceChannel).toBe("discord");
    expect(requestParams.turnSourceTo).toBe("channel:deliverable-1");
    expect(requestParams.turnSourceAccountId).toBe("acct-1");
    expect(requestParams.turnSourceThreadId).toBe("thread-1");
    expect(requestParams.approvalReviewerDeviceIds).toEqual(["device-tui-reviewer"]);
  });

  it("omits turn source routing fields when ctx does not carry them", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "No route ctx",
        description: "Local-only approval",
      },
    });

    mockCallGateway.mockResolvedValueOnce({ id: "no-route-id", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({ id: "no-route-id", decision: "allow-once" });

    await runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: { agentId: "main", sessionKey: "main" },
    });

    const requestCall = requireGatewayCall(0);
    const requestParams = requireRecord(requestCall[2], "approval request params");
    expect(requestParams.turnSourceChannel).toBeUndefined();
    expect(requestParams.turnSourceTo).toBeUndefined();
    expect(requestParams.turnSourceAccountId).toBeUndefined();
    expect(requestParams.turnSourceThreadId).toBeUndefined();
  });

  it.each([
    {
      label: "cron",
      trigger: "cron",
      reason: "Plugin approval unavailable: cron runs have no approval-capable initiating surface.",
    },
    {
      label: "heartbeat hook",
      trigger: "heartbeat",
      reason:
        "Plugin approval unavailable: heartbeat runs have no approval-capable initiating surface.",
    },
    {
      label: "non-interactive CLI",
      trigger: "user",
      reason:
        "Plugin approval unavailable: non-interactive CLI runs have no approval-capable initiating surface.",
    },
  ])("fails fast when a $label run requires plugin approval", async ({ trigger, reason }) => {
    const onResolution = vi.fn();
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Unattended approval",
        description: "Command needs review",
        onResolution,
      },
    });

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { command: "gh run view 1" },
      ctx: { agentId: "main", sessionKey: "main", trigger },
    });

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
  });

  it("keeps waiting when an interactive approval surface is bound", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Interactive approval",
        description: "CLI command needs review",
      },
    });
    mockCallGateway.mockResolvedValueOnce({ id: "interactive-id", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({ id: "interactive-id", decision: "allow-once" });

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { command: "gh run view 1" },
      ctx: {
        agentId: "main",
        sessionKey: "main",
        trigger: "user",
        approvalReviewerDeviceId: "device-tui-reviewer",
      },
    });

    expect(result).toMatchObject({ blocked: false, approvalResolution: "allow-once" });
    expect(mockCallGateway.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
  });
});
