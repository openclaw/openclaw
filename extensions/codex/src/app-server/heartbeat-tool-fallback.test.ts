import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness";
import { HEARTBEAT_RESPONSE_TOOL_NAME } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it, vi } from "vitest";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import { createInactiveCodexHeartbeatResponseTool } from "./heartbeat-tool-fallback.js";
import type { CodexDynamicToolSpec } from "./protocol.js";

function createTool(overrides: Partial<AnyAgentTool>): AnyAgentTool {
  return {
    name: "message",
    description: "Test tool",
    parameters: { type: "object", properties: {}, additionalProperties: true },
    execute: vi.fn(),
    ...overrides,
  } as AnyAgentTool;
}

function specNames(specs: readonly CodexDynamicToolSpec[]): string[] {
  return specs.flatMap((spec) =>
    spec.type === "namespace" ? spec.tools.map((tool) => tool.name) : [spec.name],
  );
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

describe("inactive Codex heartbeat endpoint", () => {
  it("terminates a stale quiet call through the normal execution pipeline", async () => {
    const heartbeatExecute = vi.fn();
    const registeredHeartbeat = createTool({
      name: HEARTBEAT_RESPONSE_TOOL_NAME,
      execute: heartbeatExecute,
    });
    const onAgentToolResult = vi.fn();
    const onToolOutcome = vi.fn();
    const bridge = createCodexDynamicToolBridge({
      tools: [createTool({ name: "message" })],
      registeredTools: [createTool({ name: "message" }), registeredHeartbeat],
      registeredFallbackTools: [createInactiveCodexHeartbeatResponseTool(registeredHeartbeat)],
      signal: new AbortController().signal,
      hookContext: { runId: "run-stale-heartbeat", onToolOutcome },
    });

    expect(bridge.availableTools.map((tool) => tool.name)).toEqual(["message"]);
    expect(specNames(bridge.availableSpecs)).toEqual(["message"]);
    expect(specNames(bridge.specs)).toEqual([HEARTBEAT_RESPONSE_TOOL_NAME, "message"]);

    const result = await bridge.handleToolCall(heartbeatCall(false), { onAgentToolResult });

    expect(result).toMatchObject({
      success: true,
      contentItems: [],
      terminate: true,
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
      expect.objectContaining({ toolName: HEARTBEAT_RESPONSE_TOOL_NAME }),
    );
  });

  it("rejects stale notification calls rather than silently discarding them", async () => {
    const registeredHeartbeat = createTool({ name: HEARTBEAT_RESPONSE_TOOL_NAME });
    const bridge = createCodexDynamicToolBridge({
      tools: [createTool({ name: "message" })],
      registeredTools: [createTool({ name: "message" }), registeredHeartbeat],
      registeredFallbackTools: [createInactiveCodexHeartbeatResponseTool(registeredHeartbeat)],
      signal: new AbortController().signal,
    });

    const result = await bridge.handleToolCall(heartbeatCall(true));

    expect(result).toMatchObject({ success: false });
    expect(JSON.stringify(result.contentItems)).toContain(
      "heartbeat_respond cannot send notifications outside a heartbeat turn",
    );
    expect(result.terminate).toBeUndefined();
  });

  it("does not mask a missing executor on an active heartbeat turn", async () => {
    const bridge = createCodexDynamicToolBridge({
      tools: [createTool({ name: "message" })],
      registeredTools: [
        createTool({ name: "message" }),
        createTool({ name: HEARTBEAT_RESPONSE_TOOL_NAME }),
      ],
      signal: new AbortController().signal,
    });

    const result = await bridge.handleToolCall(heartbeatCall(false));

    expect(result).toMatchObject({ success: false });
    expect(JSON.stringify(result.contentItems)).toContain(
      `OpenClaw tool is not available for this turn: ${HEARTBEAT_RESPONSE_TOOL_NAME}`,
    );
    expect(result.terminate).toBeUndefined();
  });
});
