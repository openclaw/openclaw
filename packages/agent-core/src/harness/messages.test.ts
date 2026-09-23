// Agent Core tests cover messages behavior.
import type { Message } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../types.js";
import { convertToLlm, createCustomMessage } from "./messages.js";

describe("convertToLlm message ownership", () => {
  it("preserves standard message objects and their private metadata", () => {
    const user: Message = { role: "user", content: "question", timestamp: 1 };
    const identity = Symbol("message identity");
    Object.defineProperty(user, identity, { value: "original", enumerable: false });
    const messages: Message[] = [
      user,
      {
        role: "assistant",
        content: [{ type: "text", text: "answer" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.6-sol",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call",
        toolName: "fixture",
        content: [{ type: "text", text: "result" }],
        isError: false,
        timestamp: 3,
      },
    ];
    const converted = convertToLlm(messages);

    expect(converted).not.toBe(messages);
    expect(converted).toHaveLength(messages.length);
    messages.forEach((message, index) => expect(converted[index]).toBe(message));
    expect(Object.getOwnPropertyDescriptor(converted[0], identity)).toEqual(
      Object.getOwnPropertyDescriptor(user, identity),
    );
  });

  it.each([false, true])("preserves custom content ownership with carrier=%s", (carrier) => {
    const timestamp = "2026-05-30T17:00:00.000Z";
    const blocks = [{ type: "text" as const, text: "array content" }];
    const customType = carrier ? "openclaw.runtime-context" : "note";
    const details = carrier
      ? { source: "openclaw-runtime-context", runtimeContextCarrier: true }
      : { source: "other" };
    const arrayMessage = createCustomMessage(customType, blocks, false, details, timestamp);
    const textMessage = createCustomMessage(customType, "text content", false, details, timestamp);
    const [array, text] = convertToLlm([arrayMessage, textMessage]);
    const [repeatedText] = convertToLlm([textMessage]);

    expect(array).not.toBe(arrayMessage);
    expect(array?.content).toBe(blocks);
    expect(array).toEqual({
      role: "user",
      content: blocks,
      timestamp: Date.parse(timestamp),
      ...(carrier ? { runtimeContextCarrier: true } : {}),
    });
    expect(text).not.toBe(textMessage);
    expect(text).toEqual({
      role: "user",
      content: [{ type: "text", text: "text content" }],
      timestamp: Date.parse(timestamp),
      ...(carrier ? { runtimeContextCarrier: true } : {}),
    });
    expect(text?.content).not.toBe(repeatedText?.content);
  });

  it("skips array holes and does not visit messages appended during conversion", () => {
    const messages: AgentMessage[] = [];
    messages.length = 3;
    const appended: AgentMessage = { role: "user", content: "later", timestamp: 2 };
    const first: AgentMessage = {
      get role() {
        messages.push(appended);
        return "user" as const;
      },
      content: "first",
      timestamp: 1,
    };
    messages[1] = first;
    const converted = convertToLlm(messages);

    expect(converted).toHaveLength(1);
    expect(converted[0]).toBe(first);
    expect(messages).toHaveLength(4);
  });
});

describe("harness message timestamps", () => {
  it("rejects invalid timestamps before creating context messages", () => {
    expect(() => createCustomMessage("note", "content", true, {}, "not-a-date")).toThrow(
      "custom message timestamp must be a valid timestamp",
    );
  });
  it("normalizes persisted compaction summary timestamp strings", () => {
    const timestamp = "2026-05-30T17:00:00.000Z";
    const persistedMessages: Parameters<typeof convertToLlm>[0] = [
      {
        role: "compactionSummary",
        summary: "older context",
        tokensBefore: 123,
        timestamp,
      },
    ];

    const [message] = convertToLlm(persistedMessages);

    expect(message?.timestamp).toBe(Date.parse(timestamp));
  });

  it.each(["0", "2026"])(
    "preserves Date.parse semantics for numeric-looking persisted timestamp %s",
    (timestamp) => {
      const [message] = convertToLlm([
        {
          role: "compactionSummary",
          summary: "older context",
          tokensBefore: 123,
          timestamp,
        },
      ]);

      expect(message?.timestamp).toBe(Date.parse(timestamp));
    },
  );

  it("keeps corrupt persisted compaction timestamps non-fatal", () => {
    const persistedMessages: Parameters<typeof convertToLlm>[0] = [
      {
        role: "compactionSummary",
        summary: "older context",
        tokensBefore: 123,
        timestamp: "not a timestamp",
      },
    ];

    const [message] = convertToLlm(persistedMessages);

    expect(message?.timestamp).toBe(0);
  });
});
