import { ok } from "node:assert/strict";
import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness";
import { HEARTBEAT_RESPONSE_TOOL_NAME } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import {
  createAgentHarnessHostCapabilitiesForTest,
  createMockPluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { Type } from "typebox";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import {
  resolveInactiveCodexHeartbeatResponseDescriptor as resolveDescriptor,
  selectInactiveCodexHeartbeatResponseTool as selectFallback,
} from "./heartbeat-tool-fallback.js";
import type { CodexDynamicToolSpec } from "./protocol.js";

const tool = (name = "message", execute = vi.fn()): AnyAgentTool => ({
  name,
  label: name,
  description: "Test tool",
  parameters: Type.Object({}, { additionalProperties: true }),
  execute,
});

const specNames = (specs: readonly CodexDynamicToolSpec[]): string[] =>
  specs.flatMap((spec) =>
    spec.type === "namespace" ? spec.tools.map((entry) => entry.name) : [spec.name],
  );

const heartbeatName = HEARTBEAT_RESPONSE_TOOL_NAME;

function createBridge(options: Partial<Parameters<typeof createCodexDynamicToolBridge>[0]> = {}) {
  return createCodexDynamicToolBridge({
    tools: [tool()],
    registeredTools: [tool(), tool(heartbeatName)],
    signal: new AbortController().signal,
    ...options,
  });
}

function nativeSpec(name: string): CodexDynamicToolSpec {
  return {
    type: "function",
    name,
    description: `Test ${name}`,
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
  };
}

function heartbeatCall(notify: boolean) {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    callId: "call-1",
    namespace: null,
    tool: HEARTBEAT_RESPONSE_TOOL_NAME,
    arguments: {
      outcome: notify ? "needs_attention" : "progress",
      notify,
      summary: notify ? "Operator action required" : "Still monitoring",
      ...(notify ? { notificationText: "Operator action required" } : {}),
    },
  } as const;
}

function fallbackTool(descriptor: Parameters<typeof selectFallback>[0]["descriptor"]) {
  const fallback = selectFallback({ descriptor, pluginConfig: {} });
  ok(fallback, "inactive heartbeat fallback was not selected");
  return fallback;
}

afterEach(resetGlobalHookRunner);

async function createHostedBridge(options: Parameters<typeof createBridge>[0] = {}) {
  const controller = new AbortController();
  const host = await createAgentHarnessHostCapabilitiesForTest({
    attempt: {
      runId: "run-stale-heartbeat",
      agentId: "main",
      sessionId: "session-stale-heartbeat",
      sessionKey: "agent:main:session-stale-heartbeat",
      config: {},
      abortSignal: controller.signal,
    },
    pluginId: "codex",
  });
  onTestFinished(host.close);
  const fallback = host.capabilities.bindToolSurface([fallbackTool(tool(heartbeatName))], {
    cwd: process.cwd(),
  })[0];
  ok(fallback, "host did not bind the inactive heartbeat fallback");
  const bridge = createBridge({
    registeredFallbackTools: [fallback],
    signal: controller.signal,
    ...options,
  });
  return { bridge, controller, close: host.close };
}

function expectResult(
  result: Awaited<ReturnType<ReturnType<typeof createBridge>["handleToolCall"]>>,
  expected: Record<string, unknown>,
) {
  expect(result).toMatchObject(expected);
  expect(result.terminate).toBeUndefined();
}

describe("inactive Codex heartbeat endpoint", () => {
  it.each<[string, { disableTools?: boolean; toolsAllow?: string[] }, boolean]>([
    ["all tools disabled", { disableTools: true }, false],
    ["excluded by allowlist", { toolsAllow: ["message"] }, false],
    ["explicitly allowed", { toolsAllow: [HEARTBEAT_RESPONSE_TOOL_NAME] }, true],
  ])("honors current turn restrictions when %s", (_label, restrictions, expected) => {
    const selected = selectFallback({
      descriptor: tool(heartbeatName),
      ...restrictions,
      pluginConfig: {},
    });

    expect(Boolean(selected)).toBe(expected);
  });

  it("handles a stale quiet call through the normal execution pipeline", async () => {
    const inactiveReply =
      "No heartbeat is active for this turn. Continue the current task and respond normally.";
    const heartbeatExecute = vi.fn();
    const onAgentToolResult = vi.fn();
    const onToolOutcome = vi.fn();
    const { bridge } = await createHostedBridge({
      registeredTools: [tool(), tool(heartbeatName, heartbeatExecute)],
      hookContext: { runId: "run-stale-heartbeat", onToolOutcome },
    });

    expect(bridge.availableTools.map((entry) => entry.name)).toEqual(["message"]);
    expect(specNames(bridge.availableSpecs)).toEqual(["message"]);
    expect(specNames(bridge.specs)).toEqual([HEARTBEAT_RESPONSE_TOOL_NAME, "message"]);

    const result = await bridge.handleToolCall(heartbeatCall(false), { onAgentToolResult });

    expectResult(result, {
      success: true,
      contentItems: [{ type: "inputText", text: inactiveReply }],
      executionStarted: true,
      executedArguments: { outcome: "progress", notify: false, summary: "Still monitoring" },
    });
    expect(heartbeatExecute).not.toHaveBeenCalled();
    expect(onAgentToolResult).toHaveBeenCalledWith({
      toolName: HEARTBEAT_RESPONSE_TOOL_NAME,
      result: expect.objectContaining({
        details: { status: "ignored", reason: "non-heartbeat-turn" },
      }),
      isError: false,
    });
    expect(onToolOutcome).toHaveBeenLastCalledWith(
      expect.objectContaining({ toolName: heartbeatName }),
    );
  });

  it.each(["policy", "cancelled", "revoked"] as const)(
    "rejects quiet fallback calls when host authority is %s",
    async (authorityState) => {
      const reason = "blocked by current policy";
      const beforeToolCall = vi.fn(async () => ({ block: true, blockReason: reason }));
      if (authorityState === "policy") {
        initializeGlobalHookRunner(
          createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
        );
      }
      const { bridge, controller, close } = await createHostedBridge();
      if (authorityState === "cancelled") {
        controller.abort(new Error("test cancellation"));
      } else if (authorityState === "revoked") {
        close();
      }

      const result = await bridge.handleToolCall(heartbeatCall(false));

      expectResult(result, { success: false });
      if (authorityState === "policy") {
        expect(JSON.stringify(result.contentItems)).toContain(reason);
        expect(beforeToolCall).toHaveBeenCalledOnce();
      } else {
        expect(result.executionStarted).toBe(false);
      }
    },
  );

  it.each([false, true])("honors inherited catalog with exclusion=%s", async (excluded) => {
    const nativeSpecs = (excluded ? [heartbeatName] : [heartbeatName, "message"]).map(nativeSpec);
    const descriptor = resolveDescriptor({
      registeredTools: [],
      registeredSpecs: nativeSpecs,
    });
    ok(descriptor, "native catalog did not resolve the heartbeat fallback descriptor");
    const fallback = selectFallback({
      descriptor,
      pluginConfig: excluded ? { codexDynamicToolsExclude: [heartbeatName] } : {},
    });
    const bridge = createBridge({
      ...(excluded ? { tools: [] } : {}),
      registeredTools: [],
      registeredSpecs: nativeSpecs,
      registeredFallbackTools: fallback ? [fallback] : [],
    });

    const result = await bridge.handleToolCall(heartbeatCall(false));

    expectResult(result, { success: !excluded });
    if (excluded) {
      expect(fallback).toBeUndefined();
      expect(result.executionStarted).toBe(false);
    } else {
      expect(bridge.specs).toEqual(nativeSpecs);
      expect(specNames(bridge.availableSpecs)).toEqual(["message"]);
      expect(bridge.availableTools.map((entry) => entry.name)).toEqual(["message"]);
    }
  });

  it.each([true, false])("rejects invalid calls with inactive heartbeat=%s", async (inactive) => {
    const bridge = createBridge(
      inactive ? { registeredFallbackTools: [fallbackTool(tool(heartbeatName))] } : {},
    );
    const result = await bridge.handleToolCall(heartbeatCall(inactive));
    expectResult(result, { success: false });
    expect(JSON.stringify(result.contentItems)).toContain(
      inactive
        ? "heartbeat_respond cannot send notifications outside a heartbeat turn"
        : `OpenClaw tool is not available for this turn: ${heartbeatName}`,
    );
  });
});
