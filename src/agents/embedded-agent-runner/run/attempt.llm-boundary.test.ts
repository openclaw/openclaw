import { describe, expect, it } from "vitest";
import {
  insertRuntimeContextMessageForPrompt,
  normalizeMessagesForLlmBoundary,
} from "./attempt.llm-boundary.js";

describe("normalizeMessagesForLlmBoundary", () => {
  it("strips inbound metadata from historical user turns before model replay", () => {
    const historicalEnvelope =
      'Conversation info (untrusted metadata):\n```json\n{"channel":"telegram","chatType":"dm"}\n```\n\nSender (untrusted metadata):\n```json\n{"id":"user-1"}\n```\n\nActual historical ask';
    const currentEnvelope =
      'Conversation info (untrusted metadata):\n```json\n{"channel":"discord","has_reply_context":true}\n```\n\nReply target of current user message (untrusted, for context):\n```json\n{"body":"quoted status body"}\n```\n\nCurrent ask';
    const input = [
      {
        role: "user",
        content: [{ type: "text", text: historicalEnvelope }],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Historical answer" }],
        timestamp: 2,
      },
      {
        role: "user",
        content: [{ type: "text", text: currentEnvelope }],
        timestamp: 3,
      },
    ];

    const output = normalizeMessagesForLlmBoundary(
      input as Parameters<typeof normalizeMessagesForLlmBoundary>[0],
    ) as unknown as Array<{ content?: Array<{ text?: string }> }>;

    expect(output[0]?.content?.[0]?.text).toBe("Actual historical ask");
    expect(output[2]?.content?.[0]?.text).toContain(
      "Reply target of current user message (untrusted, for context):",
    );
    expect(JSON.stringify(input)).toContain("Conversation info");
  });

  it("strips tool result details before provider conversion", () => {
    const input = [
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "exec",
        content: [{ type: "text", text: "visible output" }],
        details: { aggregated: "hidden diagnostics" },
        isError: false,
        timestamp: 1,
      },
    ];

    const output = normalizeMessagesForLlmBoundary(
      input as Parameters<typeof normalizeMessagesForLlmBoundary>[0],
    ) as unknown as Array<Record<string, unknown>>;

    expect(output[0]).not.toHaveProperty("details");
    expect(output[0]?.content).toEqual([{ type: "text", text: "visible output" }]);
    expect(input[0]).toHaveProperty("details");
  });

  it("keeps overflow retry runtime context immediately before the active user", () => {
    const rebuiltAfterOverflow = [
      {
        role: "user",
        content: [{ type: "text", text: "old ask" }],
        timestamp: 0,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "old answer" }],
        timestamp: 1,
      },
      {
        role: "user",
        content: [{ type: "text", text: "retry ask" }],
        timestamp: 2,
      },
    ];
    const runtimeContext = {
      role: "custom",
      customType: "openclaw.runtime-context",
      content: "retry runtime context",
      display: false,
      timestamp: 3,
    };

    const retryMessages = insertRuntimeContextMessageForPrompt({
      message: runtimeContext as Parameters<
        typeof insertRuntimeContextMessageForPrompt
      >[0]["message"],
      messages: rebuiltAfterOverflow as Parameters<typeof normalizeMessagesForLlmBoundary>[0],
    });
    const retryInput = normalizeMessagesForLlmBoundary(retryMessages) as unknown as Array<
      Record<string, unknown>
    >;

    expect(retryInput.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "custom",
      "user",
    ]);
    expect(retryInput[2]).toMatchObject({
      customType: "openclaw.runtime-context",
      content: "retry runtime context",
    });
  });
});
