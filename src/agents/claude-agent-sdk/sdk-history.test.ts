import { describe, expect, it } from "vitest";
import type { SdkConversationTurn } from "./sdk-runner.types.js";
import { buildHistorySystemPromptSuffix, serializeConversationHistory } from "./sdk-history.js";

describe("serializeConversationHistory", () => {
  it("returns empty string for undefined history", () => {
    expect(serializeConversationHistory(undefined)).toBe("");
  });

  it("returns empty string for empty history", () => {
    expect(serializeConversationHistory([])).toBe("");
  });

  it("serializes a single user turn", () => {
    const turns: SdkConversationTurn[] = [{ role: "user", content: "Hello" }];
    const result = serializeConversationHistory(turns);
    expect(result).toContain("<conversation-history>");
    expect(result).toContain("[User]:");
    expect(result).toContain("Hello");
    expect(result).toContain("</conversation-history>");
  });

  it("serializes user and assistant turns", () => {
    const turns: SdkConversationTurn[] = [
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: "4" },
    ];
    const result = serializeConversationHistory(turns);
    expect(result).toContain("[User]:");
    expect(result).toContain("What is 2+2?");
    expect(result).toContain("[Assistant]:");
    expect(result).toContain("4");
  });

  it("includes timestamps when provided", () => {
    const turns: SdkConversationTurn[] = [
      { role: "user", content: "Hi", timestamp: "2025-01-26T10:00:00Z" },
    ];
    const result = serializeConversationHistory(turns);
    expect(result).toContain("(2025-01-26T10:00:00Z)");
  });

  it("omits timestamps when not provided", () => {
    const turns: SdkConversationTurn[] = [{ role: "user", content: "Hi" }];
    const result = serializeConversationHistory(turns);
    expect(result).not.toContain("(");
  });

  it("limits to maxTurns", () => {
    const turns: SdkConversationTurn[] = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `Message ${i}`,
    }));
    const result = serializeConversationHistory(turns, { maxTurns: 5 });
    // Should only include messages 25-29.
    expect(result).toContain("Message 25");
    expect(result).toContain("Message 29");
    expect(result).not.toContain("Message 24");
    expect(result).toContain("earlier turns omitted");
  });

  it("limits to maxChars", () => {
    const turns: SdkConversationTurn[] = [
      { role: "user", content: "A".repeat(100) },
      { role: "assistant", content: "B".repeat(100) },
    ];
    // Set maxChars low enough that only one turn fits.
    const result = serializeConversationHistory(turns, { maxChars: 150 });
    expect(result).toContain("A".repeat(100));
    expect(result).not.toContain("B".repeat(100));
  });

  it("trims whitespace from content", () => {
    const turns: SdkConversationTurn[] = [{ role: "user", content: "  Hello  \n\n" }];
    const result = serializeConversationHistory(turns);
    expect(result).toContain("[User]:\nHello");
  });
});

describe("buildHistorySystemPromptSuffix", () => {
  it("returns empty string for no history", () => {
    expect(buildHistorySystemPromptSuffix(undefined)).toBe("");
    expect(buildHistorySystemPromptSuffix([])).toBe("");
  });

  it("includes instruction header and serialized history", () => {
    const turns: SdkConversationTurn[] = [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
    ];
    const result = buildHistorySystemPromptSuffix(turns);
    expect(result).toContain("## Prior Conversation Context");
    expect(result).toContain("conversation history from prior turns");
    expect(result).toContain("<conversation-history>");
    expect(result).toContain("[User]:");
    expect(result).toContain("[Assistant]:");
  });

  it("respects options", () => {
    const turns: SdkConversationTurn[] = Array.from({ length: 30 }, (_, i) => ({
      role: "user" as const,
      content: `Turn ${i}`,
    }));
    const result = buildHistorySystemPromptSuffix(turns, { maxTurns: 3 });
    expect(result).toContain("Turn 27");
    expect(result).toContain("Turn 29");
    expect(result).not.toContain("Turn 26");
  });
});
