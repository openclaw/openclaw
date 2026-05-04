import { SessionManager } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import {
  reconcileAssistantTextsWithTranscript,
  resolveUnpersistedAssistantTexts,
} from "./assistant-text-persistence.js";

type AppendMessage = Parameters<SessionManager["appendMessage"]>[0];

function getPersistedMessages(sessionManager: SessionManager) {
  return sessionManager
    .getEntries()
    .filter((entry) => entry.type === "message")
    .map((entry) => (entry as { message: AppendMessage }).message);
}

function textAssistant(text: string, timestamp: number): AppendMessage {
  return makeAgentAssistantMessage({
    content: [{ type: "text", text }],
    timestamp,
  }) as AppendMessage;
}

function toolUseAssistant(timestamp: number): AppendMessage {
  return makeAgentAssistantMessage({
    content: [{ type: "toolCall", id: "call_1", name: "web_search", arguments: {} }],
    stopReason: "toolUse",
    timestamp,
  }) as AppendMessage;
}

function toolResult(timestamp: number): AppendMessage {
  return {
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "web_search",
    content: [{ type: "text", text: "tool output" }],
    isError: false,
    timestamp,
  } as AppendMessage;
}

describe("assistant text transcript persistence", () => {
  it("persists delivered assistant text before the next unrelated user turn", () => {
    const sessionManager = SessionManager.inMemory();
    const userA = { role: "user", content: "question A", timestamp: 1 } as const;
    sessionManager.appendMessage(userA);
    sessionManager.appendMessage(toolUseAssistant(2));
    sessionManager.appendMessage(toolResult(3));

    const messagesSnapshot = getPersistedMessages(sessionManager);
    const reconciled = reconcileAssistantTextsWithTranscript({
      sessionManager,
      messagesSnapshot,
      prePromptMessageCount: 0,
      assistantTexts: ["Answer A was delivered to the requester."],
      provider: "openai-codex",
      modelId: "gpt-test",
      timestamp: 4,
    });

    expect(reconciled).toBeDefined();
    sessionManager.appendMessage({
      role: "user",
      content: "question B",
      timestamp: 5,
    });

    const persisted = getPersistedMessages(sessionManager);
    expect(persisted.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "user",
    ]);
    expect(JSON.stringify(persisted[3])).toContain("Answer A was delivered");
    expect(JSON.stringify(persisted[4])).toContain("question B");
  });

  it("does not duplicate assistant text already persisted by the session manager", () => {
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage({ role: "user", content: "question A", timestamp: 1 });
    sessionManager.appendMessage(textAssistant("Answer A already persisted.", 2));
    const messagesSnapshot = getPersistedMessages(sessionManager);

    expect(
      resolveUnpersistedAssistantTexts({
        assistantTexts: ["Answer A already persisted."],
        messagesSnapshot,
        prePromptMessageCount: 0,
      }),
    ).toEqual([]);
    expect(
      reconcileAssistantTextsWithTranscript({
        sessionManager,
        messagesSnapshot,
        prePromptMessageCount: 0,
        assistantTexts: ["Answer A already persisted."],
        provider: "openai-codex",
        modelId: "gpt-test",
      }),
    ).toBeUndefined();
    expect(
      getPersistedMessages(sessionManager).filter((message) => message.role === "assistant"),
    ).toHaveLength(1);
  });

  it("persists only visible text from delivery directive payloads", () => {
    expect(
      resolveUnpersistedAssistantTexts({
        assistantTexts: [
          "Here is the spreadsheet.\nMEDIA:./exports/report.xlsx",
          "NO_REPLY\nMEDIA:./exports/audio.opus\n[[audio_as_voice]]",
        ],
        messagesSnapshot: [],
        prePromptMessageCount: 0,
      }),
    ).toEqual(["Here is the spreadsheet."]);
  });
});
