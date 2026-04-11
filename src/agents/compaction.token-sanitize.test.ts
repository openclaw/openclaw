import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";

const piCodingAgentMocks = vi.hoisted(() => ({
  estimateTokens: vi.fn((_message: unknown) => 1),
  generateSummary: vi.fn(async () => "summary"),
}));

vi.mock("@mariozechner/pi-coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-coding-agent")>(
    "@mariozechner/pi-coding-agent",
  );
  return {
    ...actual,
    estimateTokens: piCodingAgentMocks.estimateTokens,
    generateSummary: piCodingAgentMocks.generateSummary,
  };
});

import {
  chunkMessagesByMaxTokens,
  estimateMessageTokens,
  splitMessagesByTokenShare,
} from "./compaction.js";

describe("compaction token accounting sanitization", () => {
  it("counts legacy tool-role messages when fallback estimation is used", () => {
    piCodingAgentMocks.estimateTokens.mockImplementation(() => {
      throw new TypeError("boom");
    });

    const message = {
      role: "tool",
      content: "legacy tool output",
      timestamp: 1,
    } as unknown as AgentMessage;

    expect(estimateMessageTokens(message)).toBe(Math.ceil("legacy tool output".length / 4));
  });

  it("counts legacy assistant string content when fallback estimation is used", () => {
    piCodingAgentMocks.estimateTokens.mockImplementation(() => {
      throw new TypeError("boom");
    });

    const message = {
      role: "assistant",
      content: "legacy assistant text",
      timestamp: 1,
    } as unknown as AgentMessage;

    expect(estimateMessageTokens(message)).toBe(Math.ceil("legacy assistant text".length / 4));
  });

  it("counts inline tool-result blocks when fallback estimation is used", () => {
    piCodingAgentMocks.estimateTokens.mockImplementation(() => {
      throw new TypeError("boom");
    });

    const message = {
      role: "assistant",
      content: [
        {
          type: "toolResult",
          toolUseId: "call_1",
          content: [{ type: "text", text: "inline tool output" }],
        },
        {
          type: "tool",
          toolCallId: "call_2",
          content: "legacy inline tool output",
        },
      ],
      timestamp: 1,
    } as unknown as AgentMessage;

    expect(estimateMessageTokens(message)).toBe(
      Math.ceil(("inline tool output".length + "legacy inline tool output".length) / 4),
    );
  });

  it("counts reasoning signature aliases and redacted thinking payloads when fallback estimation is used", () => {
    piCodingAgentMocks.estimateTokens.mockImplementation(() => {
      throw new TypeError("boom");
    });

    const message = {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "draft reasoning",
          thinkingSignature: "sig_payload",
        },
        {
          type: "thinking",
          signature: "legacy_signature_payload",
        },
        {
          type: "thinking",
          thought_signature: "snake_case_signature_payload",
        },
        {
          type: "redacted_thinking",
          data: "redacted_reasoning_blob",
          thinkingSignature: "sig_redacted",
        },
      ],
      timestamp: 1,
    } as unknown as AgentMessage;

    expect(estimateMessageTokens(message)).toBe(
      Math.ceil(
        ("draft reasoning".length +
          "sig_payload".length +
          "legacy_signature_payload".length +
          "snake_case_signature_payload".length +
          "redacted_reasoning_blob".length +
          "sig_redacted".length) /
          4,
      ),
    );
  });

  it("does not pass toolResult.details into per-message token estimates", () => {
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "browser",
        isError: false,
        content: [{ type: "text", text: "ok" }],
        details: { raw: "x".repeat(50_000) },
        timestamp: 1,
      } as any,
      {
        role: "user",
        content: "next",
        timestamp: 2,
      },
    ];

    splitMessagesByTokenShare(messages, 2);
    chunkMessagesByMaxTokens(messages, 16);

    const calledWithDetails = piCodingAgentMocks.estimateTokens.mock.calls.some((call) => {
      const message = call[0] as { details?: unknown } | undefined;
      return Boolean(message?.details);
    });

    expect(calledWithDetails).toBe(false);
  });
});
