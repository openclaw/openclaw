import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  createEmptyPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { vi } from "vitest";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import type {
  CodexDynamicToolCallParams,
  CodexDynamicToolFunctionSpec,
  CodexDynamicToolSpec,
  JsonValue,
} from "./protocol.js";

export type BridgeOptions = Omit<
  Parameters<typeof createCodexDynamicToolBridge>[0],
  "tools" | "signal"
> & {
  signal?: AbortSignal;
};
export function createBridge(tools: AnyAgentTool[], options: BridgeOptions = {}) {
  return createCodexDynamicToolBridge({ tools, signal: new AbortController().signal, ...options });
}
export function createTool(name: string, overrides: Partial<AnyAgentTool> = {}): AnyAgentTool {
  return {
    name,
    label: name,
    description: "Convert text to speech.",
    parameters: { type: "object", properties: {}, additionalProperties: true },
    execute: vi.fn(),
    ...overrides,
  };
}
export function createDynamicToolCall(
  tool: string,
  arguments_: JsonValue = {},
  callId = "call-1",
): CodexDynamicToolCallParams {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    callId,
    namespace: null,
    tool,
    arguments: arguments_,
  };
}
export function callTool(
  bridge: ReturnType<typeof createBridge>,
  tool: string,
  args: JsonValue = {},
  callId = "call-1",
  options?: Parameters<typeof bridge.handleToolCall>[1],
) {
  return bridge.handleToolCall(createDynamicToolCall(tool, args, callId), options);
}

export function throwingResultObserver() {
  const error = Object.defineProperty(new Error(), "message", {
    get() {
      throw new Error("observer message getter escaped");
    },
  });
  const onAgentToolResult = vi.fn(() => {
    throw error;
  });
  const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => {});
  warn.mockClear();
  return { onAgentToolResult, warn };
}

export function mediaResult(mediaUrl: string, audioAsVoice?: boolean): AgentToolResult<unknown> {
  return textToolResult("Generated media reply.", {
    media: {
      mediaUrl,
      ...(audioAsVoice === true ? { audioAsVoice: true } : {}),
    },
  });
}

export function textToolResult(text: string, details: unknown = {}): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}

export function installResultMiddleware(
  handler: ReturnType<
    typeof createEmptyPluginRegistry
  >["agentToolResultMiddlewares"][number]["handler"],
) {
  const registry = createEmptyPluginRegistry();
  registry.agentToolResultMiddlewares.push({
    pluginId: "test-result",
    pluginName: "Test result",
    rawHandler: handler,
    handler,
    runtimes: ["codex"],
    source: "test",
  });
  setActivePluginRegistry(registry);
}

export function flattenSpecsWithNamespace(
  specs: readonly CodexDynamicToolSpec[],
): Array<CodexDynamicToolFunctionSpec & { namespace?: string }> {
  return specs.flatMap((spec) =>
    spec.type === "namespace"
      ? spec.tools.map((tool) => ({ ...tool, namespace: spec.name }))
      : [spec],
  );
}
