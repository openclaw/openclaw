import { Buffer } from "node:buffer";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import type { CodexThread, CodexThreadItem, CodexTurn } from "./protocol.js";
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

function turn(id: string, items: CodexThreadItem[], fields: Partial<CodexTurn> = {}): CodexTurn {
  return { id, status: "completed", items, ...fields };
}

function exchange(id: string, label: string, phase?: string, fields: Partial<CodexTurn> = {}) {
  const items = [
    userItem(`user-${id}`, `${label} question`),
    historyItem(`assistant-${id}`, `${label} answer`, { phase }),
  ];
  return turn(id, items, fields);
}

function responseMessage(role: "user" | "assistant", text: string, phase?: string) {
  return {
    type: "message",
    role,
    content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    ...(phase ? { phase } : {}),
  };
}

function project(
  thread: CodexThread | CodexTurn[],
  throughTurnId = Array.isArray(thread) ? (thread.at(-1)?.id ?? null) : null,
  modelProvider?: string,
) {
  return projectBoundedCodexThreadHistory({
    thread: Array.isArray(thread)
      ? { id: "thread-prefix", projectId: null, turns: thread }
      : thread,
    throughTurnId,
    modelProvider,
    importedAt: 1_800_000_000_000,
  });
}

function refusal(detailedExplanation: string, fields = {}) {
  return {
    message: "The provider paused this request.",
    codexErrorInfo: "misalignmentPolicyViolation",
    misalignment: { detailedExplanation, ...fields },
  };
}

describe("projectBoundedCodexThreadHistory", () => {
  const thread: CodexThread = {
    id: "thread-prefix",
    projectId: null,
    createdAt: 1_700_000_000,
    turns: [
      exchange("turn-a", "First", "commentary", {
        startedAt: 1_700_000_001,
        completedAt: 1_700_000_002,
      }),
      exchange("turn-b", "Second", "final_answer", {
        startedAt: 1_700_000_003,
        completedAt: 1_700_000_004,
      }),
      turn("turn-active", [historyItem("active-secret", "active tail")], { status: "inProgress" }),
      turn("turn-failed", [historyItem("failed-secret", "failed tail")], { status: "failed" }),
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
      responseMessage("user", "First question"),
      responseMessage("assistant", "First answer", "commentary"),
      responseMessage("user", "Second question"),
      responseMessage("assistant", "Second answer", "final_answer"),
    ]);
    expect(JSON.stringify(projection)).not.toContain("active tail");
    expect(JSON.stringify(projection)).not.toContain("failed tail");
  });

  it("preserves imported async and commentary ownership while keeping async messages out of model history", () => {
    const question = "Which environment should I use?";
    const questions = [{ title: question, options: ["Staging", "Local"] }];
    const projection = project([
      turn("turn-async-history", [
        userItem("user-async-history", "Investigate this"),
        historyItem("commentary-history", "Checking the deployment.", { phase: "commentary" }),
        historyItem("async-history", question, {
          phase: "final_answer",
          delivery: "async",
          questions,
        }),
        historyItem("final-history", "Deployment complete.", { phase: "final_answer" }),
      ]),
    ]);

    expect(projection.transcriptMessages).toHaveLength(4);
    expect(projection.transcriptMessages[1]).toMatchObject({ phase: "commentary" });
    expect(projection.transcriptMessages[2]).toMatchObject({
      phase: "final_answer",
      openclawAsyncDelivery: { itemId: "async-history", questions },
    });
    expect(JSON.stringify(projection.responseItems)).not.toContain(question);
    expect(projection.responseItems).toHaveLength(3);
    expect(
      projectBoundedCodexVisibleSessionHistory(
        projection.transcriptMessages.map((message, index) => ({
          entryId: `entry-${index}`,
          parentId: index === 0 ? null : `entry-${index - 1}`,
          seq: index,
          role: message.role,
          message,
        })),
      ),
    ).toEqual([
      responseMessage("user", "Investigate this"),
      responseMessage("assistant", "Checking the deployment.", "commentary"),
      responseMessage("assistant", "Deployment complete.", "final_answer"),
    ]);
  });

  it("accepts terminal boundaries", () => {
    for (const [status, stopReason] of [
      ["completed", "stop"],
      ["interrupted", "aborted"],
      ["failed", "error"],
    ] as const) {
      const projection = project([
        ...(thread.turns?.slice(0, 2) ?? []),
        exchange(`turn-${status}`, status, undefined, {
          status,
          ...(status === "failed" ? { error: { message: "provider disconnected" } } : {}),
        }),
      ]);
      expect(messageContent(projection.transcriptMessages.at(-2))).toBe(`${status} question`);
      const assistant = projection.transcriptMessages.at(-1);
      expect(messageContent(assistant)).toEqual([{ type: "text", text: `${status} answer` }]);
      expect(assistant).toMatchObject({ role: "assistant", stopReason });
      expect(projection.responseItems).toHaveLength(status === "completed" ? 6 : 5);
      expect(projection.responseItems.at(-1)).toEqual(
        status === "completed"
          ? responseMessage("assistant", "completed answer")
          : responseMessage("user", `${status} question`),
      );
      if (status === "failed") {
        expect(assistant).toMatchObject({ errorMessage: "provider disconnected" });
      } else {
        expect(assistant).not.toHaveProperty("errorMessage");
      }
    }
  });

  it("retains refused history with an assistant item", () => {
    const explanation = "The proposed action differed from the requested task.";
    const continuation = { message: "  Continue only the requested task.\n" };
    const projection = project([
      turn("turn-refused", [historyItem("assistant-refused", "The request was paused.")], {
        status: "failed",
        error: refusal(explanation, { errorType: "future_category", steer: continuation }),
      }),
    ]);
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
            nativeThreadId: thread.id,
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
    const turns = Array.from({ length: 10 }, (_, index) =>
      turn(`turn-review-${index}`, [], {
        status: "failed",
        error: refusal(explanation),
      }),
    );
    const projection = project(turns);
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
    const projection = project(
      Array.from({ length: 9 }, (_, index) =>
        turn(`turn-${index}`, [userItem(`user-${index}`, `${index}:${oversizedText}`)]),
      ),
    );
    const texts = projection.transcriptMessages.map((message) => {
      const content = messageContent(message);
      return typeof content === "string" ? content : "";
    });

    expect(projection).toMatchObject({ importedMessages: 8, omittedMessages: 1 });
    expect(texts[0]).toMatch(/^1:prefix-/u);
    for (const text of texts) {
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(64 * 1024);
      expect(text).not.toContain("�");
      expect(text.endsWith("[Message truncated during Codex history import.]")).toBe(true);
    }
    expect(
      texts.reduce((bytes, text) => bytes + Buffer.byteLength(text, "utf8"), 0),
    ).toBeLessThanOrEqual(512 * 1024);
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
