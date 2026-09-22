/**
 * Per-invocation result provenance through the Codex dynamic-tool bridge: the
 * executed result's content source stays on the runtime response for the
 * mirrored transcript and never crosses into Codex's protocol payload.
 */
import type { AgentTool } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it, vi } from "vitest";
import { toCodexDynamicToolProtocolResponse } from "./dynamic-tool-execution.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import type { CodexDynamicToolCallResponse } from "./protocol.js";

function createTool(overrides: Partial<AgentTool>): AgentTool {
  return {
    name: "tts",
    description: "Convert text to speech.",
    parameters: { type: "object", properties: {}, additionalProperties: true },
    execute: vi.fn(),
    ...overrides,
  } as unknown as AgentTool;
}

function expectInputText(response: CodexDynamicToolCallResponse, text: string) {
  expect(toCodexDynamicToolProtocolResponse(response)).toEqual({
    success: true,
    contentItems: [{ type: "inputText", text }],
  });
}

describe("Codex dynamic-tool bridge per-invocation provenance", () => {
  it("retains per-invocation provenance outside Codex's protocol response", async () => {
    const bridge = createCodexDynamicToolBridge({
      tools: [
        createTool({
          name: "pdf",
          execute: vi.fn(async () => ({
            content: [{ type: "text" as const, text: "remote PDF text" }],
            details: {},
            resultContentSource: "network" as const,
          })),
        }),
      ],
      signal: new AbortController().signal,
    });

    const response = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-pdf-1",
      namespace: null,
      tool: "pdf",
      arguments: {},
    });

    expectInputText(response, "remote PDF text");
    expect(response.resultContentSource).toBe("network");
    expect(toCodexDynamicToolProtocolResponse(response)).not.toHaveProperty("resultContentSource");
  });
});
