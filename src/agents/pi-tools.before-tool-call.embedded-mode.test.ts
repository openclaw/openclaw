import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setEmbeddedMode } from "../infra/embedded-mode.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { PluginApprovalResolutions } from "../plugins/types.js";
import { runBeforeToolCallHook } from "./pi-tools.before-tool-call.js";
import { callGatewayTool } from "./tools/gateway.js";

vi.mock("../plugins/hook-runner-global.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/hook-runner-global.js")>(
    "../plugins/hook-runner-global.js",
  );
  return {
    ...actual,
    getGlobalHookRunner: vi.fn(),
  };
});
vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);
const mockCallGatewayTool = vi.mocked(callGatewayTool);

describe("runBeforeToolCallHook — embedded mode auto-approve", () => {
  let hookRunner: {
    hasHooks: ReturnType<typeof vi.fn>;
    runBeforeToolCall: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    hookRunner = {
      hasHooks: vi.fn().mockReturnValue(true),
      runBeforeToolCall: vi.fn(),
    };
    mockGetGlobalHookRunner.mockReturnValue(hookRunner as any);
    mockCallGatewayTool.mockReset();
  });

  afterEach(() => {
    setEmbeddedMode(false);
  });

  it("auto-approves when a plugin hook returns requireApproval in embedded mode", async () => {
    setEmbeddedMode(true);
    const onResolution = vi.fn();

    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        pluginId: "test-plugin",
        title: "Needs approval",
        description: "Test approval request",
        severity: "low",
        onResolution,
      },
      params: { adjusted: true },
    });

    const result = await runBeforeToolCallHook({
      toolName: "exec",
      params: { command: "ls" },
      toolCallId: "call-1",
    });

    expect(result.blocked).toBe(false);
    if (!result.blocked) {
      expect(result.params).toEqual({ command: "ls", adjusted: true });
    }
    // Must NOT call the gateway for approval
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    expect(onResolution).toHaveBeenCalledTimes(1);
    expect(onResolution).toHaveBeenCalledWith(PluginApprovalResolutions.ALLOW_ONCE);
  });

  it("sends approval to gateway when NOT in embedded mode", async () => {
    setEmbeddedMode(false);

    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        pluginId: "test-plugin",
        title: "Needs approval",
        description: "Test approval request",
        severity: "low",
        timeoutMs: 5_000,
      },
    });

    // Gateway returns no id → approval fails → blocked
    mockCallGatewayTool.mockResolvedValue({});

    const result = await runBeforeToolCallHook({
      toolName: "exec",
      params: { command: "ls" },
      toolCallId: "call-2",
    });

    expect(result.blocked).toBe(true);
    expect(mockCallGatewayTool).toHaveBeenCalledWith(
      "plugin.approval.request",
      expect.any(Object),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("preserves hook params override when auto-approving in embedded mode", async () => {
    setEmbeddedMode(true);

    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        pluginId: "test-plugin",
        title: "Approval",
        description: "desc",
        severity: "low",
      },
      params: { extraField: "injected" },
    });

    const result = await runBeforeToolCallHook({
      toolName: "write",
      params: { path: "/tmp/test.txt", content: "hello" },
      toolCallId: "call-3",
    });

    expect(result.blocked).toBe(false);
    // Original params merged with hook-provided overrides
    if (!result.blocked) {
      expect(result.params).toEqual({
        path: "/tmp/test.txt",
        content: "hello",
        extraField: "injected",
      });
    }
  });

  it("auto-approves with original params when hook provides no param overrides", async () => {
    setEmbeddedMode(true);

    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        pluginId: "test-plugin",
        title: "Approval",
        description: "desc",
        severity: "low",
      },
      // No params field
    });

    const result = await runBeforeToolCallHook({
      toolName: "read",
      params: { file: "/etc/hosts" },
      toolCallId: "call-4",
    });

    expect(result.blocked).toBe(false);
    if (!result.blocked) {
      expect(result.params).toEqual({ file: "/etc/hosts" });
    }
  });
});
