import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import { resetDiagnosticRunActivityForTest } from "../logging/diagnostic-run-activity.js";
import { resetDiagnosticSessionStateForTest } from "../logging/diagnostic-session-state.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { createHookRunner, type HookRunner } from "../plugins/hooks.js";
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
vi.mock("./tools/gateway.js", () => ({ callGatewayTool: vi.fn() }));

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);
const mockCallGateway = vi.mocked(callGatewayTool);
const hookRunnerGlobalStateKey = Symbol.for("openclaw.plugins.hook-runner-global-state");
const requireRecord = createRequireRecord("object", "label-not-object");

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

function setGlobalHookRunnerForTest(hookRunner: HookRunner | null): void {
  const hookRunnerGlobalState = globalThis as Record<
    symbol,
    { hookRunner: HookRunner | null; registry?: unknown } | undefined
  >;
  if (!hookRunnerGlobalState[hookRunnerGlobalStateKey]) {
    hookRunnerGlobalState[hookRunnerGlobalStateKey] = { hookRunner: null, registry: null };
  }
  hookRunnerGlobalState[hookRunnerGlobalStateKey].hookRunner = hookRunner;
}

function requireGatewayCall(index: number): unknown[] {
  const call = mockCallGateway.mock.calls[index] as unknown[] | undefined;
  if (!call) {
    throw new Error(`missing gateway call ${index + 1}`);
  }
  return call;
}

let hookRunner: TestHookRunner;
beforeEach(() => {
  resetDiagnosticSessionStateForTest();
  resetDiagnosticEventsForTest();
  hookRunner = createTestHookRunner();
  hookRunner.hasHooks.mockImplementation((hookName) => hookName === "before_tool_call");
  mockGetGlobalHookRunner.mockReturnValue(hookRunner);
  setGlobalHookRunnerForTest(hookRunner);
  mockCallGateway.mockReset();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

afterEach(() => {
  resetDiagnosticRunActivityForTest();
  setGlobalHookRunnerForTest(null);
  mockGetGlobalHookRunner.mockReset();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

describe("plugin approval policy subject and setup guidance", () => {
  it("binds a native approval to the selected tool owner instead of the approval hook owner", async () => {
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
    const wrappedTool = wrapToolWithBeforeToolCallHook(selectedTool, {
      agentId: "main",
      sessionKey: "main",
      loopDetection: { enabled: false },
    });

    await wrappedTool.execute("call-diffs", {}, undefined, undefined);

    expect(
      requireRecord(requireGatewayCall(0)[2], "approval request params").policySubject,
    ).toEqual({
      pluginKey: "diffs",
      tool: "diffs",
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("binds unwrapped adapted plugin tools to their registered owner", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Review diff",
        description: "Review selected tool call",
        pluginId: "review-hook",
      },
    });
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-adapted", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-adapted", decision: "allow-once" });
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const selectedTool = { name: "diffs", execute } as unknown as AnyAgentTool;
    setPluginToolMeta(selectedTool, { pluginId: "diffs", optional: false });
    const [definition] = toToolDefinitions([selectedTool], {
      agentId: "main",
      sessionKey: "main",
    });

    await definition?.execute("call-adapted", {}, undefined, undefined, {} as ExtensionContext);

    expect(
      requireRecord(requireGatewayCall(0)[2], "approval request params").policySubject,
    ).toEqual({
      pluginKey: "diffs",
      tool: "diffs",
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

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
