import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import { resetDiagnosticRunActivityForTest } from "../logging/diagnostic-run-activity.js";
import { resetDiagnosticSessionStateForTest } from "../logging/diagnostic-session-state.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { toToolDefinitions } from "./agent-tool-definition-adapter.js";
import {
  runBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "./agent-tools.before-tool-call.js";
import type { ExtensionContext } from "./sessions/index.js";
import type { AnyAgentTool } from "./tools/common.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";
import { callGatewayTool } from "./tools/gateway.js";

const hookRunner = vi.hoisted(() => ({
  hasHooks: vi.fn(),
  runBeforeToolCall: vi.fn(),
}));
vi.mock("../plugins/hook-runner-global.js", () => ({ getGlobalHookRunner: () => hookRunner }));
vi.mock("./tools/gateway.js", () => ({ callGatewayTool: vi.fn() }));
const mockCallGateway = vi.mocked(callGatewayTool);

beforeEach(() => {
  resetDiagnosticSessionStateForTest();
  resetDiagnosticEventsForTest();
  hookRunner.hasHooks.mockImplementation((hookName) => hookName === "before_tool_call");
  hookRunner.runBeforeToolCall.mockReset();
  mockCallGateway.mockReset();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

afterEach(() => {
  resetDiagnosticRunActivityForTest();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

describe("plugin approval policy subject and setup guidance", () => {
  it("uses one request for an in-process tool approval without reviewer scope", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Review diff",
        description: "Review selected tool call",
        pluginId: "diffs",
      },
    });
    mockCallGateway.mockResolvedValueOnce({ id: "plugin:approved", decision: "allow-once" });
    const gatewayContext = {} as GatewayRequestContext;

    const result = await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "main",
        gatewayContextResolver: () => gatewayContext,
      },
      () => runBeforeToolCallHook({ toolName: "diffs", params: {}, ctx: { agentId: "main" } }),
    );

    expect(result.blocked).toBe(false);
    expect(mockCallGateway).toHaveBeenCalledTimes(1);
    expect(mockCallGateway.mock.calls[0]?.[0]).toBe("plugin.approval.request");
    expect(mockCallGateway.mock.calls[0]?.[2]).toMatchObject({ twoPhase: false });
    expect(mockCallGateway.mock.calls[0]?.[3]).toEqual({ expectFinal: true });
  });

  it.each(["wrapped", "adapted"] as const)(
    "binds a %s tool approval to its registered owner rather than the approval hook owner",
    async (path) => {
      hookRunner.runBeforeToolCall.mockResolvedValue({
        requireApproval: {
          title: "Review diff",
          description: "Review selected tool call",
          pluginId: "review-hook",
        },
      });
      mockCallGateway.mockResolvedValueOnce({ id: "server-id-diffs", status: "accepted" });
      mockCallGateway.mockResolvedValueOnce({ id: "server-id-diffs", decision: "allow-once" });
      const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
      const selectedTool = { name: "diffs", execute } as unknown as AnyAgentTool;
      setPluginToolMeta(selectedTool, { pluginId: "diffs", optional: false });
      const context = { agentId: "main", sessionKey: "main", loopDetection: { enabled: false } };
      if (path === "wrapped") {
        await wrapToolWithBeforeToolCallHook(selectedTool, context).execute(
          "call-diffs",
          {},
          undefined,
          undefined,
        );
      } else {
        const [definition] = toToolDefinitions([selectedTool], context);
        await definition?.execute("call-diffs", {}, undefined, undefined, {} as ExtensionContext);
      }
      expect(mockCallGateway.mock.calls[0]?.[2]).toMatchObject({
        policySubject: { pluginKey: "diffs", tool: "diffs" },
      });
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );

  it("includes channel plugin setup guidance when a Slack request has no approval route", async () => {
    const describePluginApprovalSetup = vi.fn(
      () => "Check `approvals.plugin.slack` and the connected bot workspace.",
    );
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "slack", label: "Slack" }),
            approvalCapability: {
              getActionAvailabilityState: () => ({ kind: "enabled" as const }),
              getExecInitiatingSurfaceState: () => ({ kind: "enabled" as const }),
              describePluginApprovalSetup,
            },
          },
        },
      ]),
    );
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: { title: "Review diff", description: "Render diff" },
    });
    mockCallGateway.mockResolvedValueOnce({ id: "plugin:no-route", decision: null });

    const result = await runBeforeToolCallHook({
      toolName: "diffs",
      params: {},
      ctx: {
        agentId: "main",
        sessionKey: "main",
        turnSourceChannel: "slack",
        turnSourceAccountId: "default",
      },
    });

    expect(result).toHaveProperty(
      "reason",
      "Plugin approval unavailable (no approval route)\n\nCheck `approvals.plugin.slack` and the connected bot workspace.",
    );
    expect(describePluginApprovalSetup).toHaveBeenCalledWith({
      channel: "slack",
      channelLabel: "Slack",
      accountId: "default",
    });
    expect(mockCallGateway).toHaveBeenCalledTimes(1);
  });
});
