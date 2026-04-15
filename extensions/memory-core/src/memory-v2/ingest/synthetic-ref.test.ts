import { describe, expect, it } from "vitest";
import { memoryRefId } from "../ref.js";
import { CONVERSATION_PATH_PREFIX, synthesizeConversationRef } from "./synthetic-ref.js";

describe("synthesizeConversationRef", () => {
  it("uses the conversation path prefix", () => {
    const ref = synthesizeConversationRef({
      sessionId: "s1",
      messageIndex: 4,
      candidateText: "I prefer dark mode",
    });
    expect(ref.path.startsWith(CONVERSATION_PATH_PREFIX)).toBe(true);
    expect(ref.path).toBe(`${CONVERSATION_PATH_PREFIX}s1`);
  });

  it("places message index on both line bounds", () => {
    const ref = synthesizeConversationRef({
      sessionId: "s",
      messageIndex: 7,
      candidateText: "hi",
    });
    expect(ref.startLine).toBe(7);
    expect(ref.endLine).toBe(7);
  });

  it("produces stable ref ids for the same normalized text", () => {
    const a = synthesizeConversationRef({
      sessionId: "s",
      messageIndex: 1,
      candidateText: "I prefer dark mode",
    });
    const b = synthesizeConversationRef({
      sessionId: "s",
      messageIndex: 1,
      candidateText: "I PREFER  dark mode!!",
    });
    expect(memoryRefId(a)).toBe(memoryRefId(b));
  });

  it("produces different ref ids for different message indices", () => {
    const a = synthesizeConversationRef({
      sessionId: "s",
      messageIndex: 1,
      candidateText: "x",
    });
    const b = synthesizeConversationRef({
      sessionId: "s",
      messageIndex: 2,
      candidateText: "x",
    });
    expect(memoryRefId(a)).not.toBe(memoryRefId(b));
  });

  it("produces different ref ids for different sessions", () => {
    const a = synthesizeConversationRef({
      sessionId: "s1",
      messageIndex: 1,
      candidateText: "x",
    });
    const b = synthesizeConversationRef({
      sessionId: "s2",
      messageIndex: 1,
      candidateText: "x",
    });
    expect(memoryRefId(a)).not.toBe(memoryRefId(b));
  });
});
