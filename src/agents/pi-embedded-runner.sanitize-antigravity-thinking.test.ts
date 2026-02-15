import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { sanitizeAntigravityThinkingBlocks } from "./pi-embedded-runner/google.js";

describe("sanitizeAntigravityThinkingBlocks", () => {
  it("converts unsigned thinking block to text", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "deep thought" }],
      },
    ];

    const result = sanitizeAntigravityThinkingBlocks(messages);
    const assistant = result[0] as { content?: Array<{ type?: string; text?: string }> };
    expect(assistant.content).toHaveLength(1);
    expect(assistant.content?.[0]?.type).toBe("text");
    expect(assistant.content?.[0]?.text).toBe("deep thought");
  });

  it("keeps thinking block with valid base64 signature", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "signed thought", thinkingSignature: "c2ln" }],
      },
    ];

    const result = sanitizeAntigravityThinkingBlocks(messages);
    const assistant = result[0] as {
      content?: Array<{ type?: string; thinking?: string; thinkingSignature?: string }>;
    };
    expect(assistant.content).toHaveLength(1);
    expect(assistant.content?.[0]?.type).toBe("thinking");
    expect(assistant.content?.[0]?.thinking).toBe("signed thought");
    expect(assistant.content?.[0]?.thinkingSignature).toBe("c2ln");
  });

  it("normalizes signature key to thinkingSignature", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "signed", signature: "AQID" }],
      },
    ];

    const result = sanitizeAntigravityThinkingBlocks(messages);
    const assistant = result[0] as {
      content?: Array<{ type?: string; thinkingSignature?: string }>;
    };
    expect(assistant.content?.[0]?.type).toBe("thinking");
    expect(assistant.content?.[0]?.thinkingSignature).toBe("AQID");
  });

  it("handles mixed signed and unsigned thinking blocks", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "signed", thinkingSignature: "c2ln" },
          { type: "thinking", thinking: "unsigned thought" },
          { type: "text", text: "response" },
        ],
      },
    ];

    const result = sanitizeAntigravityThinkingBlocks(messages);
    const assistant = result[0] as {
      content?: Array<{ type?: string; text?: string; thinking?: string }>;
    };
    expect(assistant.content).toHaveLength(3);
    expect(assistant.content?.[0]?.type).toBe("thinking");
    expect(assistant.content?.[0]?.thinking).toBe("signed");
    expect(assistant.content?.[1]?.type).toBe("text");
    expect(assistant.content?.[1]?.text).toBe("unsigned thought");
    expect(assistant.content?.[2]?.type).toBe("text");
    expect(assistant.content?.[2]?.text).toBe("response");
  });

  it("drops whitespace-only unsigned thinking blocks", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "   " },
          { type: "text", text: "hello" },
        ],
      },
    ];

    const result = sanitizeAntigravityThinkingBlocks(messages);
    const assistant = result[0] as { content?: Array<{ type?: string }> };
    expect(assistant.content).toHaveLength(1);
    expect(assistant.content?.[0]?.type).toBe("text");
  });

  it("removes assistant message when all blocks are empty unsigned thinking", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: "hi",
      },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "" }],
      },
    ];

    const result = sanitizeAntigravityThinkingBlocks(messages);
    expect(result).toHaveLength(1);
    expect((result[0] as { role?: string }).role).toBe("user");
  });

  it("passes through non-assistant messages unchanged", () => {
    const messages: AgentMessage[] = [{ role: "user", content: "hello" }];

    const result = sanitizeAntigravityThinkingBlocks(messages);
    expect(result).toBe(messages); // same reference = no changes
  });

  it("passes through non-thinking blocks unchanged", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
      },
    ];

    const result = sanitizeAntigravityThinkingBlocks(messages);
    expect(result).toBe(messages); // same reference = no changes
  });

  it("rejects non-base64 signatures and converts to text", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "thought", thought_signature: "msg_abc123" }],
      },
    ];

    const result = sanitizeAntigravityThinkingBlocks(messages);
    const assistant = result[0] as { content?: Array<{ type?: string; text?: string }> };
    expect(assistant.content).toHaveLength(1);
    expect(assistant.content?.[0]?.type).toBe("text");
    expect(assistant.content?.[0]?.text).toBe("thought");
  });
});
