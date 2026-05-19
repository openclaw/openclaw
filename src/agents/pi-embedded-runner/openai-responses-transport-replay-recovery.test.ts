import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenAIResponsesTransportStreamFn } from "../openai-transport-stream.js";
import { wrapOpenAIResponsesStreamWithReplayRecovery } from "./thinking.js";

const responsesCreateMock = vi.hoisted(() => vi.fn());

vi.mock("openai", () => {
  class MockOpenAI {
    responses = {
      create: responsesCreateMock,
    };
  }

  return {
    default: MockOpenAI,
    AzureOpenAI: MockOpenAI,
  };
});

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

function buildModel(): Model<"openai-responses"> {
  return {
    id: "gpt-5.4",
    name: "gpt-5.4",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
  };
}

function buildReplayableAssistantMessage(): Extract<AgentMessage, { role: "assistant" }> {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.4",
    usage: ZERO_USAGE,
    stopReason: "stop",
    timestamp: Date.now(),
    content: [
      {
        type: "thinking",
        thinking: "private reasoning",
        thinkingSignature: JSON.stringify({
          type: "reasoning",
          id: "rs_test",
          summary: [],
        }),
      },
      {
        type: "text",
        text: "visible answer",
        textSignature: JSON.stringify({ v: 1, id: "msg_test", phase: "final_answer" }),
      },
    ],
  };
}

async function* successfulResponsesStream() {
  yield { type: "response.created", response: { id: "resp_recovered" } };
  yield { type: "response.output_item.added", item: { type: "message", id: "msg_recovered" } };
  yield { type: "response.output_text.delta", delta: "recovered" };
  yield {
    type: "response.output_item.done",
    item: {
      type: "message",
      id: "msg_recovered",
      status: "completed",
      content: [{ type: "output_text", text: "recovered" }],
    },
  };
  yield {
    type: "response.completed",
    response: {
      id: "resp_recovered",
      status: "completed",
      usage: {
        input_tokens: 2,
        output_tokens: 1,
        total_tokens: 3,
        input_tokens_details: { cached_tokens: 0 },
      },
    },
  };
}

function extractInputTypes(payload: Record<string, unknown> | undefined): string[] {
  const input = Array.isArray(payload?.input) ? payload.input : [];
  return input
    .map((item) =>
      item && typeof item === "object" ? (item as Record<string, unknown>).type : undefined,
    )
    .filter((type): type is string => typeof type === "string");
}

describe("OpenAI Responses transport replay recovery", () => {
  beforeEach(() => {
    responsesCreateMock.mockReset();
  });

  it("recovers the current transport error-event path by retrying without replayed reasoning", async () => {
    responsesCreateMock
      .mockRejectedValueOnce(
        new Error(
          '400 {"error":{"code":"thinking_signature_invalid","message":"The encrypted content for item rs_test could not be verified. Reason: Encrypted content could not be decrypted or parsed.","type":"invalid_request_error"}}',
        ),
      )
      .mockResolvedValueOnce(successfulResponsesStream());

    const capturedPayloads: Record<string, unknown>[] = [];
    const wrapped = wrapOpenAIResponsesStreamWithReplayRecovery(
      createOpenAIResponsesTransportStreamFn(),
      { id: "transport-proof-session" },
    );

    const stream = wrapped(
      buildModel(),
      {
        systemPrompt: "system",
        messages: [
          { role: "user", content: "continue", timestamp: Date.now() },
          buildReplayableAssistantMessage(),
          { role: "user", content: "continue again", timestamp: Date.now() },
        ],
      } as never,
      {
        apiKey: "test",
        onPayload: (payload) => {
          capturedPayloads.push(payload as Record<string, unknown>);
        },
      } as never,
    ) as { result: () => Promise<AgentMessage> };

    await expect(stream.result()).resolves.toMatchObject({
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "recovered" }],
    });

    expect(responsesCreateMock).toHaveBeenCalledTimes(2);
    expect(extractInputTypes(capturedPayloads[0])).toContain("reasoning");
    expect(extractInputTypes(capturedPayloads[1])).not.toContain("reasoning");
    expect(extractInputTypes(capturedPayloads[1])).toContain("message");
  });
});
