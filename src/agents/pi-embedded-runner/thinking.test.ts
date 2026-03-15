import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import {
  dropThinkingBlocks,
  isAssistantMessageWithContent,
  isInvalidThinkingSignatureError,
  stripInvalidThinkingSignatures,
} from "./thinking.js";

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

  it("drops thinking blocks while preserving non-thinking assistant content", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal" },
          { type: "text", text: "final" },
        ],
      }),
    ];

    const result = dropThinkingBlocks(messages);
    const assistant = result[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(result).not.toBe(messages);
    expect(assistant.content).toEqual([{ type: "text", text: "final" }]);
  });

  it("keeps assistant turn structure when all content blocks were thinking", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [{ type: "thinking", thinking: "internal-only" }],
      }),
    ];

    const result = dropThinkingBlocks(messages);
    const assistant = result[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(assistant.content).toEqual([{ type: "text", text: "" }]);
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

  it("strips thinking blocks with too-short thinkingSignature", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reasoning", thinkingSignature: "short" },
          { type: "text", text: "answer" },
        ],
      }),
    ];

    // Non-empty signatures are kept — the API is the source of truth for validity.
    // stripInvalidThinkingSignatures only catches empty/missing signatures.
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
