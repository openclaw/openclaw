import { Buffer } from "node:buffer";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import type { CodexThread, CodexThreadItem } from "./protocol.js";
import {
  projectBoundedCodexThreadHistory,
  projectBoundedCodexVisibleSessionHistory,
} from "./transcript-history-projection.js";

function messageContent(message: AgentMessage | undefined) {
  if (!message || !("content" in message)) {
    throw new Error("expected transcript message content");
  }
  return message.content;
}

describe("projectBoundedCodexThreadHistory", () => {
  const thread = {
    id: "thread-prefix",
    createdAt: 1_700_000_000,
    turns: [
      {
        id: "turn-a",
        status: "completed",
        startedAt: 1_700_000_001,
        completedAt: 1_700_000_002,
        items: [
          {
            id: "user-a",
            type: "userMessage",
            content: [{ type: "text", text: "First question" }],
          },
          {
            id: "assistant-a",
            type: "agentMessage",
            text: "First answer",
            phase: "commentary",
          },
        ],
      },
      {
        id: "turn-b",
        status: "completed",
        startedAt: 1_700_000_003,
        completedAt: 1_700_000_004,
        items: [
          {
            id: "user-b",
            type: "userMessage",
            content: [{ type: "text", text: "Second question" }],
          },
          {
            id: "assistant-b",
            type: "agentMessage",
            text: "Second answer",
            phase: "final_answer",
          },
        ],
      },
      {
        id: "turn-active",
        status: "inProgress",
        items: [
          {
            id: "active-secret",
            type: "agentMessage",
            text: "Do not import the active tail",
          },
        ],
      },
      {
        id: "turn-failed",
        status: "failed",
        items: [
          {
            id: "failed-secret",
            type: "agentMessage",
            text: "Do not import the failed tail",
          },
        ],
      },
    ],
  } as unknown as CodexThread;

  it("uses one inclusive completed-turn prefix for transcript and Responses API projection", () => {
    const projection = projectBoundedCodexThreadHistory({
      thread,
      throughTurnId: "turn-b",
      importedAt: 1_800_000_000_000,
      modelProvider: "native-provider",
    });

    expect(projection).toMatchObject({ importedMessages: 4, omittedMessages: 0 });
    expect(projection.transcriptMessages.map(messageContent)).toEqual([
      "First question",
      [{ type: "text", text: "First answer" }],
      "Second question",
      [{ type: "text", text: "Second answer" }],
    ]);
    expect(projection.transcriptMessages[1]).toMatchObject({
      role: "assistant",
      api: "openai-chatgpt-responses",
      provider: "native-provider",
      model: "native-history",
    });
    expect(projection.responseItems).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "First question" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "First answer" }],
        phase: "commentary",
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Second question" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Second answer" }],
        phase: "final_answer",
      },
    ]);
    expect(JSON.stringify(projection)).not.toContain("active tail");
    expect(JSON.stringify(projection)).not.toContain("failed tail");
  });

  it("preserves imported async and commentary ownership while keeping async messages out of model history", () => {
    const importedThread = {
      ...thread,
      turns: [
        {
          id: "turn-async-history",
          status: "completed",
          items: [
            {
              id: "user-async-history",
              type: "userMessage",
              content: [{ type: "text", text: "Investigate this" }],
            },
            {
              id: "commentary-history",
              type: "agentMessage",
              text: "Checking the deployment.",
              phase: "commentary",
            },
            {
              id: "async-history",
              type: "agentMessage",
              text: "Which environment should I use?",
              phase: "final_answer",
              delivery: "async",
              questions: [
                { title: "Which environment should I use?", options: ["Staging", "Local"] },
              ],
            },
            {
              id: "final-history",
              type: "agentMessage",
              text: "Deployment complete.",
              phase: "final_answer",
            },
          ],
        },
      ],
    } as unknown as CodexThread;

    const projection = projectBoundedCodexThreadHistory({
      thread: importedThread,
      throughTurnId: "turn-async-history",
      importedAt: 1_800_000_000_000,
    });

    expect(projection.transcriptMessages).toHaveLength(4);
    expect(projection.transcriptMessages[1]).toMatchObject({ phase: "commentary" });
    expect(projection.transcriptMessages[2]).toMatchObject({
      phase: "final_answer",
      openclawAsyncDelivery: {
        itemId: "async-history",
        questions: [{ title: "Which environment should I use?", options: ["Staging", "Local"] }],
      },
    });
    expect(JSON.stringify(projection.responseItems)).not.toContain(
      "Which environment should I use?",
    );
    expect(projection.responseItems).toHaveLength(3);
    const visibleSessionHistory = projectBoundedCodexVisibleSessionHistory(
      projection.transcriptMessages.map((message, index) => ({
        entryId: `entry-${index}`,
        parentId: index === 0 ? null : `entry-${index - 1}`,
        seq: index,
        role: message.role,
        message,
      })),
    );
    expect(visibleSessionHistory).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Investigate this" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Checking the deployment." }],
        phase: "commentary",
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Deployment complete." }],
        phase: "final_answer",
      },
    ]);
  });

  it("accepts terminal boundaries", () => {
    for (const [status, stopReason] of [
      ["completed", "stop"],
      ["interrupted", "aborted"],
      ["failed", "error"],
    ] as const) {
      const terminalThread = {
        ...thread,
        turns: [
          ...(thread.turns?.slice(0, 2) ?? []),
          {
            id: `turn-${status}`,
            status,
            ...(status === "failed" ? { error: { message: "provider disconnected" } } : {}),
            items: [
              {
                id: `user-${status}`,
                type: "userMessage",
                content: [{ type: "text", text: `${status} question` }],
              },
              {
                id: `assistant-${status}`,
                type: "agentMessage",
                text: `${status} answer`,
              },
            ],
          },
        ],
      } as unknown as CodexThread;
      const projection = projectBoundedCodexThreadHistory({
        thread: terminalThread,
        throughTurnId: `turn-${status}`,
        importedAt: 1_800_000_000_000,
      });
      expect(messageContent(projection.transcriptMessages.at(-2))).toBe(`${status} question`);
      const assistant = projection.transcriptMessages.at(-1);
      expect(messageContent(assistant)).toEqual([{ type: "text", text: `${status} answer` }]);
      expect(assistant).toMatchObject({ role: "assistant", stopReason });
      expect(projection.responseItems).toHaveLength(status === "completed" ? 6 : 5);
      expect(projection.responseItems.at(-1)).toEqual(
        status === "completed"
          ? {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "completed answer" }],
            }
          : {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: `${status} question` }],
            },
      );
      if (status === "failed") {
        expect(assistant).toMatchObject({ errorMessage: "provider disconnected" });
      } else {
        expect(assistant).not.toHaveProperty("errorMessage");
      }
    }
  });

  it.each([false, true])("retains refused history with an assistant item: %s", (withAssistant) => {
    const explanation = "The proposed action differed from the requested task.";
    const continuation = { message: "  Continue only the requested task.\n" };
    const assistantItem: CodexThreadItem = {
      id: "assistant-refused",
      type: "agentMessage",
      text: "The request was paused.",
      title: null,
      status: null,
      name: null,
      tool: null,
      server: null,
      command: null,
      cwd: null,
      query: null,
      aggregatedOutput: null,
      changes: [],
    };
    const importedThread: CodexThread = {
      ...thread,
      turns: [
        {
          id: "turn-refused",
          status: "failed",
          error: {
            message: "The provider paused this request.",
            codexErrorInfo: "misalignmentPolicyViolation",
            misalignment: {
              errorType: "future_category",
              detailedExplanation: explanation,
              steer: continuation,
            },
          },
          items: withAssistant ? [assistantItem] : [],
        },
      ],
    };
    const projection = projectBoundedCodexThreadHistory({
      thread: importedThread,
      throughTurnId: "turn-refused",
      importedAt: 1_800_000_000_000,
    });
    expect(projection.transcriptMessages).toHaveLength(1);
    expect(projection.transcriptMessages[0]).toMatchObject({
      role: "assistant",
      stopReason: "error",
      diagnostics: [
        {
          type: "provider_refusal",
          details: {
            provider: "openai",
            category: "misalignment",
            nativeThreadId: importedThread.id,
            nativeTurnId: "turn-refused",
            review: { explanation, continuation, errorType: "future_category" },
          },
        },
      ],
    });
    expect(projection.responseItems).toEqual([]);
  });

  it("includes review findings in the bounded history byte budget", () => {
    const explanation = "x".repeat(64 * 1024);
    const turns = Array.from({ length: 10 }, (_, index) => ({
      id: `turn-review-${index}`,
      status: "failed",
      items: [],
      error: {
        message: "The provider paused this request.",
        codexErrorInfo: "misalignmentPolicyViolation",
        misalignment: { detailedExplanation: explanation },
      },
    }));
    const projection = projectBoundedCodexThreadHistory({
      thread: { ...thread, turns },
      throughTurnId: "turn-review-9",
      importedAt: 1_800_000_000_000,
    });
    expect(projection.importedMessages).toBeGreaterThan(0);
    expect(projection.omittedMessages).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(projection.transcriptMessages), "utf8")).toBeLessThan(
      512 * 1024,
    );
    expect(projection.transcriptMessages.at(-1)).toMatchObject({
      diagnostics: [{ details: { review: { explanation } } }],
    });
  });

  it("enforces UTF-8 byte limits without splitting multibyte text", () => {
    const oversizedText = `prefix-${"🙂".repeat(20_000)}-suffix`;
    const oversizedThread = {
      id: "thread-byte-bounds",
      turns: Array.from({ length: 9 }, (_, index) => ({
        id: `turn-${index}`,
        status: "completed",
        items: [
          {
            id: `user-${index}`,
            type: "userMessage",
            content: [{ type: "text", text: `${index}:${oversizedText}` }],
          },
        ],
      })),
    } as unknown as CodexThread;

    const projection = projectBoundedCodexThreadHistory({
      thread: oversizedThread,
      throughTurnId: "turn-8",
      importedAt: 1_800_000_000_000,
    });
    const texts = projection.transcriptMessages.map((message) => {
      const content = messageContent(message);
      return typeof content === "string" ? content : "";
    });

    expect(projection).toMatchObject({ importedMessages: 8, omittedMessages: 1 });
    expect(texts[0]).toMatch(/^1:prefix-/u);
    expect(texts.every((text) => Buffer.byteLength(text, "utf8") <= 64 * 1024)).toBe(true);
    expect(
      texts.reduce((bytes, text) => bytes + Buffer.byteLength(text, "utf8"), 0),
    ).toBeLessThanOrEqual(512 * 1024);
    expect(texts.every((text) => !text.includes("�"))).toBe(true);
    expect(
      texts.every((text) => text.endsWith("[Message truncated during Codex history import.]")),
    ).toBe(true);
  });

  it("rejects a non-terminal or missing boundary and projects no history without one", () => {
    expect(() =>
      projectBoundedCodexThreadHistory({
        thread,
        throughTurnId: "turn-active",
        importedAt: 1_800_000_000_000,
      }),
    ).toThrow("Codex history boundary turn is not terminal: turn-active");
    expect(() =>
      projectBoundedCodexThreadHistory({
        thread,
        throughTurnId: "turn-missing",
        importedAt: 1_800_000_000_000,
      }),
    ).toThrow("Codex history boundary turn not found: turn-missing");
    expect(
      projectBoundedCodexThreadHistory({
        thread,
        throughTurnId: null,
        importedAt: 1_800_000_000_000,
      }),
    ).toEqual({
      importedMessages: 0,
      omittedMessages: 0,
      responseItems: [],
      transcriptMessages: [],
    });
  });
});
