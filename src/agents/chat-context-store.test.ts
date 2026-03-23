import { describe, expect, it } from "vitest";
import {
  buildChatSummaryRecord,
  buildSummaryContextMessages,
  type ChatSummaryRecord,
} from "./chat-context-store.js";

function textMessage(role: string, text: string, timestamp = Date.now()) {
  return {
    role,
    content: [{ type: "text", text }],
    timestamp,
  };
}

function syntheticSummary(text = "[Context summary]") {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    timestamp: Date.now(),
    synthetic: true as const,
    summary: true as const,
  };
}

describe("chat context summary store", () => {
  it("extracts env/path/id/hash/error into technical buckets", () => {
    const summary = buildChatSummaryRecord({
      agentId: "main",
      sessionKey: "agent:main:main",
      messages: [
        textMessage(
          "user",
          "Deploy commit 0123abcd on branch. Use OPENAI_API_KEY from .env and inspect src/server.ts:42. Request id 123e4567-e89b-12d3-a456-426614174000.",
        ),
        textMessage(
          "assistant",
          "Current goal: fix ENOENT: no such file or directory at src/server.ts:42",
        ),
      ],
    });

    expect(summary.technicalFacts.commitHashes).toContain("0123abcd");
    expect(summary.technicalFacts.envNames).toContain("OPENAI_API_KEY");
    expect(summary.technicalFacts.filePaths).toContain(".env");
    expect(summary.technicalFacts.filePaths).toContain("src/server.ts:42");
    expect(summary.technicalFacts.ids).toContain("123e4567-e89b-12d3-a456-426614174000");
    expect(summary.technicalFacts.errorSnippets.some((line) => line.includes("ENOENT"))).toBe(true);
  });

  it("ignores synthetic summary when building new summary", () => {
    const summary = buildChatSummaryRecord({
      agentId: "main",
      sessionKey: "agent:main:main",
      messages: [syntheticSummary(), textMessage("user", "Use API_TOKEN in app/config.ts")],
    });

    expect(summary.sourceMessageCount).toBe(1);
    expect(summary.importantFacts.join(" ")).toContain("API_TOKEN");
  });

  it("repeated compact does not reduce source facts count unexpectedly", () => {
    const first = buildChatSummaryRecord({
      agentId: "main",
      sessionKey: "agent:main:main",
      messages: [textMessage("user", "Use DATABASE_URL in src/db.ts and commit deadbeef")],
    });
    const second = buildChatSummaryRecord({
      agentId: "main",
      sessionKey: "agent:main:main",
      previous: first,
      messages: [
        syntheticSummary(),
        textMessage("assistant", "Status: still investigating ENOENT in src/db.ts"),
      ],
    });

    expect(second.summaryGeneration).toBe(2);
    expect(second.technicalFacts.envNames).toContain("DATABASE_URL");
    expect(second.technicalFacts.filePaths).toContain("src/db.ts");
    expect(second.technicalFacts.commitHashes).toContain("deadbeef");
  });

  it("summary mode injects exactly one summary and filters transcript summary line from tail", () => {
    const summary: ChatSummaryRecord = buildChatSummaryRecord({
      agentId: "main",
      sessionKey: "agent:main:main",
      messages: [textMessage("user", "Goal: ship release")],
    });
    const messages = buildSummaryContextMessages({
      messages: [
        syntheticSummary("old transcript summary"),
        textMessage("user", "recent 1", 1),
        textMessage("assistant", "recent 2", 2),
      ],
      summary,
      tailCount: 5,
      mode: "summary",
    });

    const summaryCount = messages.filter(
      (message) => (message as { summary?: boolean }).summary === true,
    ).length;
    expect(summaryCount).toBe(1);
    expect((messages[0] as { summary?: boolean }).summary).toBe(true);
    expect(JSON.stringify(messages)).not.toContain("old transcript summary");
  });
});
