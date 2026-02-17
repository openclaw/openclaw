import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  makeInMemorySessionManager,
  makeModelSnapshotEntry,
} from "./pi-embedded-runner.sanitize-session-history.test-harness.js";
import { sanitizeSessionHistory } from "./pi-embedded-runner/google.js";

describe("sanitizeSessionHistory openai tool id preservation", () => {
  it("keeps canonical call_id|fc_id pairings for same-model openai replay", async () => {
    const sessionEntries = [
      makeModelSnapshotEntry({
        provider: "openai",
        modelApi: "openai-responses",
        modelId: "gpt-5.2-codex",
      }),
    ];
    const sessionManager = makeInMemorySessionManager(sessionEntries);

    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_123|fc_123", name: "noop", arguments: {} }],
      } as unknown as AgentMessage,
      {
        role: "toolResult",
        toolCallId: "call_123|fc_123",
        toolName: "noop",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      } as unknown as AgentMessage,
    ];

    const result = await sanitizeSessionHistory({
      messages,
      modelApi: "openai-responses",
      provider: "openai",
      modelId: "gpt-5.2-codex",
      sessionManager,
      sessionId: "test-session",
    });

    const assistant = result[0] as { content?: Array<{ type?: string; id?: string }> };
    const toolCall = assistant.content?.find((block) => block.type === "toolCall");
    expect(toolCall?.id).toBe("call_123|fc_123");

    const toolResult = result[1] as { toolCallId?: string };
    expect(toolResult.toolCallId).toBe("call_123|fc_123");
  });
});
