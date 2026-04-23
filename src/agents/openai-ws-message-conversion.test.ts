import { describe, expect, it } from "vitest";
import type { ResponseObject } from "./openai-ws-connection.js";
import { buildAssistantMessageFromResponse } from "./openai-ws-message-conversion.js";

describe("openai ws message conversion", () => {
  it("preserves cached token usage from responses usage details", () => {
    const response: ResponseObject = {
      id: "resp_123",
      object: "response",
      created_at: Date.now(),
      status: "completed",
      model: "gpt-5",
      output: [
        {
          type: "message",
          id: "msg_123",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "hello" }],
        },
      ],
      usage: {
        input_tokens: 120,
        output_tokens: 30,
        total_tokens: 250,
        input_tokens_details: { cached_tokens: 100 },
      },
    };

    const message = buildAssistantMessageFromResponse(response, {
      api: "openai-responses",
      provider: "openai",
      id: "gpt-5",
    });

    expect(message.usage).toMatchObject({
      input: 20,
      output: 30,
      cacheRead: 100,
      cacheWrite: 0,
      totalTokens: 250,
    });
  });

  it("derives cache-inclusive total tokens when responses total is missing", () => {
    const response: ResponseObject = {
      id: "resp_124",
      object: "response",
      created_at: Date.now(),
      status: "completed",
      model: "gpt-5",
      output: [
        {
          type: "message",
          id: "msg_124",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "hello" }],
        },
      ],
      usage: {
        input_tokens: 120,
        output_tokens: 30,
        input_tokens_details: { cached_tokens: 100 },
      },
    };

    const message = buildAssistantMessageFromResponse(response, {
      api: "openai-responses",
      provider: "openai",
      id: "gpt-5",
    });

    expect(message.usage).toMatchObject({
      input: 20,
      output: 30,
      cacheRead: 100,
      cacheWrite: 0,
      totalTokens: 150,
    });
  });
});
