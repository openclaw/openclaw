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

function historyItem(
  id: string,
  text: string,
  fields: Partial<CodexThreadItem> = {},
): CodexThreadItem {
  return {
    id,
    text,
    type: "agentMessage",
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
    ...fields,
  };
}

function userItem(id: string, text: string): CodexThreadItem {
  return historyItem(id, "", { type: "userMessage", content: [{ type: "text", text }] });
}

function project(thread: CodexThread, throughTurnId: string | null, modelProvider?: string) {
  return projectBoundedCodexThreadHistory({
    thread,
    throughTurnId,
    modelProvider,
    importedAt: 1_800_000_000_000,
  });
}

describe("projectBoundedCodexThreadHistory", () => {
  const thread: CodexThread = {
    id: "thread-prefix",
    projectId: null,
    createdAt: 1_700_000_000,
    turns: [
      {
        id: "turn-a",
        status: "completed",
        startedAt: 1_700_000_001,
        completedAt: 1_700_000_002,
        items: [
          userItem("user-a", "First question"),
          historyItem("assistant-a", "First answer", { phase: "commentary" }),
        ],
      },
      {
        id: "turn-b",
        status: "completed",
        startedAt: 1_700_000_003,
        completedAt: 1_700_000_004,
        items: [
          userItem("user-b", "Second question"),
          historyItem("assistant-b", "Second answer", { phase: "final_answer" }),
        ],
      },
      {
        id: "turn-active",
        status: "inProgress",
        items: [historyItem("active-secret", "Do not import the active tail")],
      },
      {
        id: "turn-failed",
        status: "failed",
        items: [historyItem("failed-secret", "Do not import the failed tail")],
      },
    ],
  };

  it("uses one inclusive completed-turn prefix for transcript and Responses API projection", () => {
    const projection = project(thread, "turn-b", "native-provider");

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
    const importedThread: CodexThread = {
      ...thread,
      turns: [
        {
          id: "turn-async-history",
          status: "completed",
          items: [
            userItem("user-async-history", "Investigate this"),
            historyItem("commentary-history", "Checking the deployment.", { phase: "commentary" }),
            historyItem("async-history", "Which environment should I use?", {
              phase: "final_answer",
              delivery: "async",
              questions: [
                { title: "Which environment should I use?", options: ["Staging", "Local"] },
              ],
            }),
            historyItem("final-history", "Deployment complete.", { phase: "final_answer" }),
          ],
        },
      ],
    };

    const projection = project(importedThread, "turn-async-history");

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
      const terminalThread: CodexThread = {
        ...thread,
        turns: [
          ...(thread.turns?.slice(0, 2) ?? []),
          {
            id: `turn-${status}`,
            status,
            ...(status === "failed" ? { error: { message: "provider disconnected" } } : {}),
            items: [
              userItem(`user-${status}`, `${status} question`),
              historyItem(`assistant-${status}`, `${status} answer`),
            ],
          },
        ],
      };
      const projection = project(terminalThread, `turn-${status}`);
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

  it.each([true])("retains refused history with an assistant item: %s", (withAssistant) => {
    const explanation = "The proposed action differed from the requested task.";
    const continuation = { message: "  Continue only the requested task.\n" };
    const assistantItem = historyItem("assistant-refused", "The request was paused.");
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
    const projection = project(importedThread, "turn-refused");
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
    const projection = project({ ...thread, turns }, "turn-review-9");
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
    const oversizedThread: CodexThread = {
      id: "thread-byte-bounds",
      projectId: null,
      turns: Array.from({ length: 9 }, (_, index) => ({
        id: `turn-${index}`,
        status: "completed",
        items: [userItem(`user-${index}`, `${index}:${oversizedText}`)],
      })),
    };

    const projection = project(oversizedThread, "turn-8");
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
    expect(() => project(thread, "turn-active")).toThrow(
      "Codex history boundary turn is not terminal: turn-active",
    );
    expect(() => project(thread, "turn-missing")).toThrow(
      "Codex history boundary turn not found: turn-missing",
    );
    expect(project(thread, null)).toEqual({
      importedMessages: 0,
      omittedMessages: 0,
      responseItems: [],
      transcriptMessages: [],
    });
  });
});
