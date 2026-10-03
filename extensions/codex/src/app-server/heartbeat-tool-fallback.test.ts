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
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import {
  resolveInactiveCodexHeartbeatResponseDescriptor,
  selectInactiveCodexHeartbeatResponseTool,
} from "./heartbeat-tool-fallback.js";
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

const closeHosts: Array<() => void> = [];

function createInactiveHeartbeatFallbackForTest(
  descriptor: Parameters<typeof selectInactiveCodexHeartbeatResponseTool>[0]["descriptor"],
): AnyAgentTool {
  const fallback = selectInactiveCodexHeartbeatResponseTool({ descriptor, pluginConfig: {} });
  if (!fallback) {
    throw new Error("inactive heartbeat fallback was not selected");
  }
  return fallback;
}

afterEach(() => {
  resetGlobalHookRunner();
  for (const close of closeHosts.splice(0)) {
    close();
  }
});

async function bindInactiveHeartbeatFallback(abortSignal: AbortSignal) {
  const host = await createAgentHarnessHostCapabilitiesForTest({
    attempt: {
      runId: "run-stale-heartbeat",
      agentId: "main",
      sessionId: "session-stale-heartbeat",
      sessionKey: "agent:main:session-stale-heartbeat",
      config: {},
      abortSignal,
    },
    pluginId: "codex",
  });
  closeHosts.push(host.close);
  const descriptor = createTool({ name: HEARTBEAT_RESPONSE_TOOL_NAME });
  const fallback = host.capabilities.bindToolSurface(
    [createInactiveHeartbeatFallbackForTest(descriptor)],
    { cwd: process.cwd() },
  )[0];
  if (!fallback) {
    throw new Error("host did not bind the inactive heartbeat fallback");
  }
  return { fallback, close: host.close };
}

describe("inactive Codex heartbeat endpoint", () => {
  it.each([
    {
      label: "all tools disabled",
      disableTools: true,
      toolsAllow: undefined,
      codexDynamicToolsExclude: undefined,
      expected: false,
    },
    {
      label: "excluded by allowlist",
      disableTools: false,
      toolsAllow: ["message"],
      codexDynamicToolsExclude: undefined,
      expected: false,
    },
    {
      label: "explicitly allowed",
      disableTools: false,
      toolsAllow: [HEARTBEAT_RESPONSE_TOOL_NAME],
      codexDynamicToolsExclude: undefined,
      expected: true,
    },
    {
      label: "wildcard allowed",
      disableTools: false,
      toolsAllow: ["*"],
      codexDynamicToolsExclude: undefined,
      expected: true,
    },
    {
      label: "excluded by current Codex plugin config",
      disableTools: false,
      toolsAllow: undefined,
      codexDynamicToolsExclude: [HEARTBEAT_RESPONSE_TOOL_NAME],
      expected: false,
    },
  ])(
    "honors current turn restrictions when $label",
    ({ disableTools, toolsAllow, codexDynamicToolsExclude, expected }) => {
      const selected = selectInactiveCodexHeartbeatResponseTool({
        descriptor: createTool({ name: HEARTBEAT_RESPONSE_TOOL_NAME }),
        disableTools,
        toolsAllow,
        pluginConfig: { codexDynamicToolsExclude },
      });

      expect(Boolean(selected)).toBe(expected);
    },
  );

  it("keeps a stale heartbeat call recoverable on ordinary turns", async () => {
    const registeredHeartbeat = createTool({ name: HEARTBEAT_RESPONSE_TOOL_NAME });
    const bridge = createCodexDynamicToolBridge({
      tools: [createTool({ name: "message" })],
      registeredTools: [createTool({ name: "message" }), registeredHeartbeat],
      registeredFallbackTools: [createInactiveHeartbeatFallbackForTest(registeredHeartbeat)],
      signal: new AbortController().signal,
    });

    const result = await bridge.handleToolCall(heartbeatCall(false));

    expect(result).toMatchObject({ success: true, executionStarted: true });
    expect(JSON.stringify(result.contentItems)).toContain("respond normally");
    expect(result.terminate).toBeUndefined();
  });

  it("handles a stale quiet call through the normal execution pipeline", async () => {
    const runAbortController = new AbortController();
    const heartbeatExecute = vi.fn();
    const registeredHeartbeat = createTool({
      name: HEARTBEAT_RESPONSE_TOOL_NAME,
      execute: heartbeatExecute,
    });
    const onAgentToolResult = vi.fn();
    const onToolOutcome = vi.fn();
    const { fallback } = await bindInactiveHeartbeatFallback(runAbortController.signal);
    const bridge = createCodexDynamicToolBridge({
      tools: [createTool({ name: "message" })],
      registeredTools: [createTool({ name: "message" }), registeredHeartbeat],
      registeredFallbackTools: [fallback],
      signal: runAbortController.signal,
      hookContext: { runId: "run-stale-heartbeat", onToolOutcome },
    });

    expect(bridge.availableTools.map((tool) => tool.name)).toEqual(["message"]);
    expect(specNames(bridge.availableSpecs)).toEqual(["message"]);
    expect(specNames(bridge.specs)).toEqual([HEARTBEAT_RESPONSE_TOOL_NAME, "message"]);

    const result = await bridge.handleToolCall(heartbeatCall(false), { onAgentToolResult });

    expect(result).toMatchObject({
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: "No heartbeat is active for this turn. Continue the current task and respond normally.",
        },
      ],
      executionStarted: true,
      executedArguments: { outcome: "progress", notify: false, summary: "Still monitoring" },
    });
    expect(result.terminate).toBeUndefined();
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

  it("rejects quiet fallback calls when current host policy vetoes execution", async () => {
    const beforeToolCall = vi.fn(async () => ({
      block: true,
      blockReason: "blocked by current policy",
    }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );
    const runAbortController = new AbortController();
    const { fallback } = await bindInactiveHeartbeatFallback(runAbortController.signal);
    const bridge = createCodexDynamicToolBridge({
      tools: [createTool({ name: "message" })],
      registeredTools: [
        createTool({ name: "message" }),
        createTool({ name: HEARTBEAT_RESPONSE_TOOL_NAME }),
      ],
      registeredFallbackTools: [fallback],
      signal: runAbortController.signal,
    });

    const result = await bridge.handleToolCall(heartbeatCall(false));

    expect(result).toMatchObject({ success: false });
    expect(JSON.stringify(result.contentItems)).toContain("blocked by current policy");
    expect(result.terminate).toBeUndefined();
    expect(beforeToolCall).toHaveBeenCalledOnce();
  });

  it.each(["cancelled", "revoked"] as const)(
    "rejects quiet fallback calls after host authority is %s",
    async (authorityState) => {
      const runAbortController = new AbortController();
      const bound = await bindInactiveHeartbeatFallback(runAbortController.signal);
      const bridge = createCodexDynamicToolBridge({
        tools: [createTool({ name: "message" })],
        registeredTools: [
          createTool({ name: "message" }),
          createTool({ name: HEARTBEAT_RESPONSE_TOOL_NAME }),
        ],
        registeredFallbackTools: [bound.fallback],
        signal: runAbortController.signal,
      });
      if (authorityState === "cancelled") {
        runAbortController.abort(new Error("test cancellation"));
      } else {
        bound.close();
      }

      const result = await bridge.handleToolCall(heartbeatCall(false));

      expect(result).toMatchObject({ success: false, executionStarted: false });
      expect(result.terminate).toBeUndefined();
    },
  );

  it("creates the fallback from an inherited native catalog without rewriting declarations", async () => {
    const nativeSpecs: CodexDynamicToolSpec[] = [
      {
        type: "function",
        name: HEARTBEAT_RESPONSE_TOOL_NAME,
        description: "Record heartbeat completion",
        inputSchema: { type: "object", properties: {}, additionalProperties: true },
      },
      {
        type: "function",
        name: "message",
        description: "Send a message",
        inputSchema: { type: "object", properties: {}, additionalProperties: true },
      },
    ];
    const descriptor = resolveInactiveCodexHeartbeatResponseDescriptor({
      registeredTools: [],
      registeredSpecs: nativeSpecs,
    });
    if (!descriptor) {
      throw new Error("native catalog did not resolve the heartbeat fallback descriptor");
    }
    const bridge = createCodexDynamicToolBridge({
      tools: [createTool({ name: "message" })],
      registeredTools: [],
      registeredSpecs: nativeSpecs,
      registeredFallbackTools: [createInactiveHeartbeatFallbackForTest(descriptor)],
      signal: new AbortController().signal,
    });

    const result = await bridge.handleToolCall(heartbeatCall(false));

    expect(result).toMatchObject({ success: true });
    expect(result.terminate).toBeUndefined();
    expect(bridge.specs).toEqual(nativeSpecs);
    expect(specNames(bridge.availableSpecs)).toEqual(["message"]);
    expect(bridge.availableTools.map((tool) => tool.name)).toEqual(["message"]);
  });

  it("rejects an inherited native heartbeat after the current plugin config excludes it", async () => {
    const nativeSpecs: CodexDynamicToolSpec[] = [
      {
        type: "function",
        name: HEARTBEAT_RESPONSE_TOOL_NAME,
        description: "Record heartbeat completion",
        inputSchema: { type: "object", properties: {}, additionalProperties: true },
      },
    ];
    const descriptor = resolveInactiveCodexHeartbeatResponseDescriptor({
      registeredTools: [],
      registeredSpecs: nativeSpecs,
    });
    if (!descriptor) {
      throw new Error("native catalog did not resolve the heartbeat fallback descriptor");
    }
    const fallback = selectInactiveCodexHeartbeatResponseTool({
      descriptor,
      pluginConfig: { codexDynamicToolsExclude: [HEARTBEAT_RESPONSE_TOOL_NAME] },
    });
    const bridge = createCodexDynamicToolBridge({
      tools: [],
      registeredTools: [],
      registeredSpecs: nativeSpecs,
      registeredFallbackTools: fallback ? [fallback] : [],
      signal: new AbortController().signal,
    });

    const result = await bridge.handleToolCall(heartbeatCall(false));

    expect(fallback).toBeUndefined();
    expect(result).toMatchObject({ success: false, executionStarted: false });
    expect(result.terminate).toBeUndefined();
  });

  it("rejects stale notification calls rather than silently discarding them", async () => {
    const registeredHeartbeat = createTool({ name: HEARTBEAT_RESPONSE_TOOL_NAME });
    const bridge = createCodexDynamicToolBridge({
      tools: [createTool({ name: "message" })],
      registeredTools: [createTool({ name: "message" }), registeredHeartbeat],
      registeredFallbackTools: [createInactiveHeartbeatFallbackForTest(registeredHeartbeat)],
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
