import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  makeInMemorySessionManager,
  makeModelSnapshotEntry,
} from "./pi-embedded-runner.sanitize-session-history.test-harness.js";
import { sanitizeSessionHistory } from "./pi-embedded-runner/google.js";
import { castAgentMessage } from "./test-helpers/agent-message-fixtures.js";

describe("sanitizeSessionHistory openai tool id preservation", () => {
  const makeSessionManager = () =>
    makeInMemorySessionManager([
      makeModelSnapshotEntry({
        provider: "openai",
        modelApi: "openai-responses",
        modelId: "gpt-5.2-codex",
      }),
    ]);

  const makeMessages = (params: { withReasoning: boolean; reasoningId?: string }): AgentMessage[] => [
    castAgentMessage({
      role: "assistant",
      content: [
        ...(params.withReasoning
          ? [
              {
                type: "thinking",
                thinking: "internal reasoning",
                thinkingSignature: JSON.stringify({
                  id: params.reasoningId ?? "rs_123",
                  type: "reasoning",
                }),
              },
            ]
          : []),
        { type: "toolCall", id: "call_123|fc_123", name: "noop", arguments: {} },
      ],
    }),
    castAgentMessage({
      role: "toolResult",
      toolCallId: "call_123|fc_123",
      toolName: "noop",
      content: [{ type: "text", text: "ok" }],
      isError: false,
    }),
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
      reasoningId: "rs_123",
      expectedToolId: "call_123|fc_123",
    },
    {
      name: "strips fc ids when reasoning id is not the paired rs_ suffix",
      withReasoning: true,
      reasoningId: "rs_other",
      expectedToolId: "call_123",
    },
  ])("$name", async ({ withReasoning, expectedToolId, reasoningId }) => {
    const result = await sanitizeSessionHistory({
      messages: makeMessages({ withReasoning, reasoningId }),
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
