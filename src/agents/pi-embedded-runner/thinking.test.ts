import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { castAgentMessage, castAgentMessages } from "../test-helpers/agent-message-fixtures.js";
import {
  assessLastAssistantMessage,
  dropThinkingBlocks,
  isAssistantMessageWithContent,
  isInvalidThinkingSignatureError,
  sanitizeThinkingForRecovery,
  stripInvalidThinkingSignatures,
  wrapAnthropicStreamWithRecovery,
} from "./thinking.js";

type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

function dropSingleAssistantContent(content: Array<Record<string, unknown>>) {
  const messages: AgentMessage[] = [
    castAgentMessage({
      role: "assistant",
      content,
    }),
  ];

  const result = dropThinkingBlocks(messages);
  return {
    assistant: result[0] as Extract<AgentMessage, { role: "assistant" }>,
    messages,
    result,
  };
}

describe("isAssistantMessageWithContent", () => {
  it("accepts assistant messages with array content and rejects others", () => {
    const assistant = castAgentMessage({
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
    });
    const user = castAgentMessage({ role: "user", content: "hi" });
    const malformed = castAgentMessage({ role: "assistant", content: "not-array" });

    expect(isAssistantMessageWithContent(assistant)).toBe(true);
    expect(isAssistantMessageWithContent(user)).toBe(false);
    expect(isAssistantMessageWithContent(malformed)).toBe(false);
  });
});

describe("dropThinkingBlocks", () => {
  it("returns the original reference when no thinking blocks are present", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({ role: "user", content: "hello" }),
      castAgentMessage({ role: "assistant", content: [{ type: "text", text: "world" }] }),
    ];

    const result = dropThinkingBlocks(messages);
    expect(result).toBe(messages);
  });

  it("preserves thinking blocks when the assistant message is the latest assistant turn", () => {
    const { assistant, messages, result } = dropSingleAssistantContent([
      { type: "thinking", thinking: "internal" },
      { type: "text", text: "final" },
    ]);
    expect(result).toBe(messages);
    expect(assistant.content).toEqual([
      { type: "thinking", thinking: "internal" },
      { type: "text", text: "final" },
    ]);
  });

  it("preserves a latest assistant turn even when all content blocks are thinking", () => {
    const { assistant } = dropSingleAssistantContent([
      { type: "thinking", thinking: "internal-only" },
    ]);
    expect(assistant.content).toEqual([{ type: "thinking", thinking: "internal-only" }]);
  });

  it("preserves thinking blocks in the latest assistant message", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({ role: "user", content: "first" }),
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "old" },
          { type: "text", text: "old text" },
        ],
      }),
      castAgentMessage({ role: "user", content: "second" }),
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "latest", thinkingSignature: "sig_latest" },
          { type: "text", text: "latest text" },
        ],
      }),
    ];

    const result = dropThinkingBlocks(messages);
    const firstAssistant = result[1] as Extract<AgentMessage, { role: "assistant" }>;
    const latestAssistant = result[3] as Extract<AgentMessage, { role: "assistant" }>;

    expect(firstAssistant.content).toEqual([{ type: "text", text: "old text" }]);
    expect(latestAssistant.content).toEqual([
      { type: "thinking", thinking: "latest", thinkingSignature: "sig_latest" },
      { type: "text", text: "latest text" },
    ]);
  });
});

describe("stripInvalidThinkingSignatures", () => {
  it("returns the original reference when no thinking blocks are present", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({ role: "user", content: "hello" }),
      castAgentMessage({ role: "assistant", content: [{ type: "text", text: "world" }] }),
    ];

    const result = stripInvalidThinkingSignatures(messages);
    expect(result).toBe(messages);
  });

  it("returns the original reference when all thinking blocks have valid signatures", () => {
    const validSig = "a".repeat(356); // Real signatures are 356-2344+ chars
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reasoning", thinkingSignature: validSig },
          { type: "text", text: "answer" },
        ],
      }),
    ];

    const result = stripInvalidThinkingSignatures(messages);
    expect(result).toBe(messages);
  });

  it("strips thinking blocks with empty thinkingSignature", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reasoning", thinkingSignature: "" },
          { type: "text", text: "answer" },
        ],
      }),
    ];

    const result = stripInvalidThinkingSignatures(messages);
    expect(result).not.toBe(messages);
    const assistant = result[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(assistant.content).toEqual([{ type: "text", text: "answer" }]);
  });

  it("strips thinking blocks with missing thinkingSignature", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reasoning" },
          { type: "text", text: "answer" },
        ],
      }),
    ];

    const result = stripInvalidThinkingSignatures(messages);
    expect(result).not.toBe(messages);
    const assistant = result[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(assistant.content).toEqual([{ type: "text", text: "answer" }]);
  });

  it("keeps thinking blocks with non-empty signatures regardless of length", () => {
    // Non-empty signatures are kept — the API is the source of truth for validity.
    // stripInvalidThinkingSignatures only catches empty/missing/non-string signatures.
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reasoning", thinkingSignature: "short" },
          { type: "text", text: "answer" },
        ],
      }),
    ];

    const result = stripInvalidThinkingSignatures(messages);
    expect(result).toBe(messages);
  });

  it("preserves assistant turn when all thinking blocks are invalid", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [{ type: "thinking", thinking: "reasoning", thinkingSignature: "" }],
      }),
    ];

    const result = stripInvalidThinkingSignatures(messages);
    const assistant = result[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(assistant.content).toEqual([{ type: "text", text: "" }]);
  });

  it("keeps valid thinking blocks while stripping invalid ones in same message", () => {
    const validSig = "b".repeat(356); // Real signatures are 356-2344+ chars
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "valid reasoning", thinkingSignature: validSig },
          { type: "thinking", thinking: "bad reasoning", thinkingSignature: "" },
          { type: "text", text: "answer" },
        ],
      }),
    ];

    const result = stripInvalidThinkingSignatures(messages);
    expect(result).not.toBe(messages);
    const assistant = result[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(assistant.content).toHaveLength(2);
    expect((assistant.content[0] as { type: string }).type).toBe("thinking");
    expect((assistant.content[1] as { type: string }).type).toBe("text");
  });

  it("does not touch non-assistant messages", () => {
    const messages: AgentMessage[] = [castAgentMessage({ role: "user", content: "hello" })];

    const result = stripInvalidThinkingSignatures(messages);
    expect(result).toBe(messages);
  });

  it("strips redacted_thinking blocks with empty signature", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "redacted_thinking", signature: "" },
          { type: "text", text: "answer" },
        ],
      }),
    ];

    const result = stripInvalidThinkingSignatures(messages);
    expect(result).not.toBe(messages);
    const assistant = result[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(assistant.content).toEqual([{ type: "text", text: "answer" }]);
  });

  it("strips redacted_thinking blocks with missing signature", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [{ type: "redacted_thinking" }, { type: "text", text: "answer" }],
      }),
    ];

    const result = stripInvalidThinkingSignatures(messages);
    expect(result).not.toBe(messages);
    const assistant = result[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(assistant.content).toEqual([{ type: "text", text: "answer" }]);
  });

  it("keeps redacted_thinking blocks with non-empty signatures", () => {
    const validSig = "c".repeat(356);
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "redacted_thinking", signature: validSig },
          { type: "text", text: "answer" },
        ],
      }),
    ];

    const result = stripInvalidThinkingSignatures(messages);
    expect(result).toBe(messages);
  });
});

describe("isInvalidThinkingSignatureError", () => {
  it("matches the Anthropic invalid signature error message", () => {
    expect(isInvalidThinkingSignatureError("Invalid signature in thinking block")).toBe(true);
    expect(
      isInvalidThinkingSignatureError(
        'Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Invalid signature in thinking block"}}',
      ),
    ).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isInvalidThinkingSignatureError("context overflow")).toBe(false);
    expect(isInvalidThinkingSignatureError("Invalid signature")).toBe(false);
    expect(isInvalidThinkingSignatureError("")).toBe(false);
  });
});

describe("sanitizeThinkingForRecovery", () => {
  it("drops the latest assistant message when the thinking block is unsigned", () => {
    const messages = castAgentMessages([
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "partial" }],
      },
    ]);

    const result = sanitizeThinkingForRecovery(messages);
    expect(result.messages).toEqual([messages[0]]);
    expect(result.prefill).toBe(false);
  });

  it("preserves later turns when dropping an incomplete assistant message", () => {
    const messages = castAgentMessages([
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "partial" }],
      },
      { role: "user", content: "follow up" },
    ]);

    const result = sanitizeThinkingForRecovery(messages);
    expect(result.messages).toEqual([messages[0], messages[2]]);
    expect(result.prefill).toBe(false);
  });

  it("marks signed thinking without text as a prefill recovery case", () => {
    const messages = castAgentMessages([
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "complete", thinkingSignature: "sig" }],
      },
    ]);

    const result = sanitizeThinkingForRecovery(messages);
    expect(result.messages).toBe(messages);
    expect(result.prefill).toBe(true);
  });

  it("marks signed thinking with an empty text block as incomplete text", () => {
    const message = castAgentMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "complete", thinkingSignature: "sig" },
        { type: "text", text: "" },
      ],
    });

    expect(assessLastAssistantMessage(message)).toBe("incomplete-text");
  });

  it("treats partial text after signed thinking as valid", () => {
    const message = castAgentMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "complete", thinkingSignature: "sig" },
        { type: "text", text: "Here is my answ" },
      ],
    });

    expect(assessLastAssistantMessage(message)).toBe("valid");
  });

  it("treats non-string text blocks as incomplete text when thinking is signed", () => {
    const message = castAgentMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "complete", thinkingSignature: "sig" },
        { type: "text", text: { bad: true } },
      ],
    });

    expect(assessLastAssistantMessage(message)).toBe("incomplete-text");
  });
});

describe("wrapAnthropicStreamWithRecovery", () => {
  const anthropicThinkingError = new Error(
    "thinking or redacted_thinking blocks in the latest assistant message cannot be modified",
  );

  it("retries once when the request is rejected before streaming", async () => {
    let callCount = 0;
    const wrapped = wrapAnthropicStreamWithRecovery(
      (() => {
        callCount += 1;
        return Promise.reject(anthropicThinkingError);
      }) as Parameters<typeof wrapAnthropicStreamWithRecovery>[0],
      { id: "test-session" },
    );

    await expect(
      wrapped(
        {} as never,
        {
          messages: castAgentMessages([
            {
              role: "assistant",
              content: [{ type: "thinking", thinking: "secret", thinkingSignature: "sig" }],
            },
          ]),
        } as never,
        {} as never,
      ),
    ).rejects.toBe(anthropicThinkingError);
    expect(callCount).toBe(2);
  });

  it("does not retry when the stream fails after yielding a chunk", async () => {
    let callCount = 0;
    const wrapped = wrapAnthropicStreamWithRecovery(
      (() => {
        callCount += 1;
        return (async function* failingStream() {
          yield "chunk";
          throw anthropicThinkingError;
        })();
      }) as unknown as Parameters<typeof wrapAnthropicStreamWithRecovery>[0],
      { id: "test-session" },
    );

    const chunks: unknown[] = [];
    const response = wrapped({} as never, { messages: [] } as never, {} as never) as {
      result: () => Promise<unknown>;
    } & AsyncIterable<unknown>;
    for await (const chunk of response) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["chunk"]);
    await expect(response.result()).rejects.toBe(anthropicThinkingError);
    expect(callCount).toBe(1);
  });

  it("does not retry non-Anthropic-thinking errors", async () => {
    const rateLimitError = new Error("rate limit exceeded");
    let callCount = 0;
    const wrapped = wrapAnthropicStreamWithRecovery(
      (() => {
        callCount += 1;
        return Promise.reject(rateLimitError);
      }) as Parameters<typeof wrapAnthropicStreamWithRecovery>[0],
      { id: "test-session" },
    );

    await expect(wrapped({} as never, { messages: [] } as never, {} as never)).rejects.toBe(
      rateLimitError,
    );
    expect(callCount).toBe(1);
  });

  it("preserves result() for synchronous event streams", async () => {
    const finalMessage = castAgentMessage({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    }) as AssistantMessage;

    const wrapped = wrapAnthropicStreamWithRecovery(
      (() => {
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          stream.push({ type: "start", partial: finalMessage });
          stream.push({ type: "done", reason: "stop", message: finalMessage });
          stream.end();
        });
        return stream;
      }) as Parameters<typeof wrapAnthropicStreamWithRecovery>[0],
      { id: "test-session" },
    );

    const response = wrapped({} as never, { messages: [] } as never, {} as never) as {
      result: () => Promise<unknown>;
    } & AsyncIterable<unknown>;
    const events: unknown[] = [];
    for await (const event of response) {
      events.push(event);
    }

    await expect(response.result()).resolves.toEqual(finalMessage);
    expect(events).toHaveLength(2);
  });
});
