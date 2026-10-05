import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness";
import { expect, vi } from "vitest";
import { toCodexDynamicToolProtocolResponse } from "./dynamic-tool-execution.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import type { CodexDynamicToolCallResponse, JsonValue } from "./protocol.js";

export function createTool(overrides: Partial<AnyAgentTool>): AnyAgentTool {
  return {
    name: "tts",
    description: "Convert text to speech.",
    parameters: { type: "object", properties: {}, additionalProperties: true },
    execute: vi.fn(),
    ...overrides,
  } as unknown as AnyAgentTool;
}

export function mediaResult(mediaUrl: string, audioAsVoice?: boolean): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: "Generated media reply." }],
    details: {
      media: {
        mediaUrl,
        ...(audioAsVoice === true ? { audioAsVoice: true } : {}),
      },
    },
  };
}

export function textToolResult(text: string, details: unknown = {}): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

export function createBridgeWithToolResult(
  toolName: string,
  toolResult: AgentToolResult<unknown>,
  hookContext?: Parameters<typeof createCodexDynamicToolBridge>[0]["hookContext"],
) {
  return createCodexDynamicToolBridge({
    tools: [
      createTool({
        name: toolName,
        execute: vi.fn(async () => toolResult),
      }),
    ],
    signal: new AbortController().signal,
    hookContext,
  });
}

export function expectInputText(response: CodexDynamicToolCallResponse, text: string): void {
  expect(toCodexDynamicToolProtocolResponse(response)).toEqual({
    success: true,
    contentItems: [{ type: "inputText", text }],
  });
}

export async function handleMessageToolCall(
  bridge: ReturnType<typeof createCodexDynamicToolBridge>,
  arguments_: JsonValue,
) {
  return await bridge.handleToolCall({
    threadId: "thread-1",
    turnId: "turn-1",
    callId: "call-1",
    namespace: null,
    tool: "message",
    arguments: arguments_,
  });
}
