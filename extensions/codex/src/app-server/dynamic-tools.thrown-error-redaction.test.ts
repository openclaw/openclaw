import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness";
import { describe, expect, it, vi } from "vitest";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";

// Synthetic, non-usable credential fixture for model-visible redaction coverage.
const SYNTHETIC_BEARER_CREDENTIAL = "bearer-model-visible-credential-1234567890";

function createTool(overrides: Partial<AnyAgentTool>): AnyAgentTool {
  return {
    name: "tts",
    description: "Convert text to speech.",
    parameters: { type: "object", properties: {}, additionalProperties: true },
    execute: vi.fn(),
    ...overrides,
  } as unknown as AnyAgentTool;
}

describe("createCodexDynamicToolBridge thrown-error redaction", () => {
  it("redacts credentials from thrown dynamic tool error content items", async () => {
    const thrown = new Error(
      `Upstream failed: Authorization: Bearer ${SYNTHETIC_BEARER_CREDENTIAL}`,
    );
    const bridge = createCodexDynamicToolBridge({
      tools: [
        createTool({
          name: "credential_lookup",
          execute: vi.fn(async () => {
            throw thrown;
          }),
        }),
      ],
      signal: new AbortController().signal,
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-throw-credential",
      namespace: null,
      tool: "credential_lookup",
      arguments: {},
    });

    expect(result.success).toBe(false);
    const text = result.contentItems
      .map((item) => (item.type === "inputText" && typeof item.text === "string" ? item.text : ""))
      .join("");
    expect(text).not.toContain(SYNTHETIC_BEARER_CREDENTIAL);
    expect(text).toContain("Authorization: Bearer");
  });
});
