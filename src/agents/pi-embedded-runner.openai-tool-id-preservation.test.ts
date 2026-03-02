import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  makeInMemorySessionManager,
  makeModelSnapshotEntry,
} from "./pi-embedded-runner.sanitize-session-history.test-harness.js";
import { sanitizeSessionHistory } from "./pi-embedded-runner/google.js";

describe("sanitizeSessionHistory openai tool id preservation", () => {
  const makeSessionManager = () =>
    makeInMemorySessionManager([
      makeModelSnapshotEntry({
        provider: "openai",
        modelApi: "openai-responses",
        modelId: "gpt-5.2-codex",
      }),
    ]);

  const makeMessages = (withReasoning: boolean): AgentMessage[] => [
    {
      role: "assistant",
      content: [
        ...(withReasoning
          ? [
              {
                type: "thinking",
                thinking: "internal reasoning",
                thinkingSignature: JSON.stringify({ id: "rs_123", type: "reasoning" }),
              },
            ]
          : []),
        { type: "toolCall", id: "call_123|fc_123", name: "noop", arguments: {} },
      ],
    } as unknown as AgentMessage,
    {
      role: "toolResult",
      toolCallId: "call_123|fc_123",
      toolName: "noop",
      content: [{ type: "text", text: "ok" }],
      isError: false,
    } as unknown as AgentMessage,
  ];

  it.each([
    {
      name: "strips fc ids when replayable reasoning metadata is missing",
      withReasoning: false,
      expectedToolId: "call_123",
    },
    {
      name: "keeps canonical call_id|fc_id pairings when replayable reasoning is present",
      withReasoning: true,
      expectedToolId: "call_123|fc_123",
    },
  ])("$name", async ({ withReasoning, expectedToolId }) => {
    const result = await sanitizeSessionHistory({
      messages: makeMessages(withReasoning),
      modelApi: "openai-responses",
      provider: "openai",
      modelId: "gpt-5.2-codex",
      sessionManager: makeSessionManager(),
      sessionId: "test-session",
    });

    const assistant = result[0] as { content?: Array<{ type?: string; id?: string }> };
    const toolCall = assistant.content?.find((block) => block.type === "toolCall");
    expect(toolCall?.id).toBe(expectedToolId);

    const toolResult = result[1] as { toolCallId?: string };
    expect(toolResult.toolCallId).toBe(expectedToolId);
  });
});
