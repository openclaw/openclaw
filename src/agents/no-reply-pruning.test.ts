import { describe, expect, it } from "vitest";
import { countNoReplies, pruneConsecutiveNoReplies } from "./no-reply-pruning.js";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

function makeUserMessage(text: string): AgentMessage {
  return { role: "user", content: text };
}

function makeAssistantMessage(text: string): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function makeNoReply(): AgentMessage {
  return makeAssistantMessage("NO_REPLY");
}

describe("pruneConsecutiveNoReplies", () => {
  it("returns empty array for empty input", () => {
    expect(pruneConsecutiveNoReplies([])).toEqual([]);
  });

  it("keeps single NO_REPLY", () => {
    const messages = [makeUserMessage("hi"), makeNoReply()];
    const result = pruneConsecutiveNoReplies(messages);
    expect(result).toEqual(messages);
  });

  it("prunes consecutive NO_REPLY messages, keeping 1", () => {
    const messages = [
      makeUserMessage("hi"),
      makeNoReply(),
      makeNoReply(),
      makeNoReply(),
      makeUserMessage("hello"),
    ];
    const result = pruneConsecutiveNoReplies(messages);
    expect(result).toEqual([
      makeUserMessage("hi"),
      makeNoReply(),
      makeUserMessage("hello"),
    ]);
  });

  it("keeps multiple separate NO_REPLY runs", () => {
    const messages = [
      makeUserMessage("1"),
      makeNoReply(),
      makeUserMessage("2"),
      makeNoReply(),
      makeNoReply(),
      makeUserMessage("3"),
    ];
    const result = pruneConsecutiveNoReplies(messages);
    expect(result).toEqual([
      makeUserMessage("1"),
      makeNoReply(),
      makeUserMessage("2"),
      makeNoReply(),
      makeUserMessage("3"),
    ]);
  });

  it("respects maxConsecutive parameter", () => {
    const messages = [
      makeUserMessage("hi"),
      makeNoReply(),
      makeNoReply(),
      makeNoReply(),
      makeNoReply(),
    ];
    const result = pruneConsecutiveNoReplies(messages, 2);
    expect(result).toEqual([
      makeUserMessage("hi"),
      makeNoReply(),
      makeNoReply(),
    ]);
  });

  it("handles maxConsecutive=0 (prune all NO_REPLYs)", () => {
    const messages = [
      makeUserMessage("hi"),
      makeNoReply(),
      makeNoReply(),
      makeUserMessage("bye"),
    ];
    const result = pruneConsecutiveNoReplies(messages, 0);
    expect(result).toEqual([
      makeUserMessage("hi"),
      makeUserMessage("bye"),
    ]);
  });

  it("preserves normal assistant messages", () => {
    const messages = [
      makeUserMessage("hi"),
      makeAssistantMessage("Hello!"),
      makeNoReply(),
      makeNoReply(),
      makeAssistantMessage("Goodbye!"),
    ];
    const result = pruneConsecutiveNoReplies(messages);
    expect(result).toEqual([
      makeUserMessage("hi"),
      makeAssistantMessage("Hello!"),
      makeNoReply(),
      makeAssistantMessage("Goodbye!"),
    ]);
  });

  it("handles case-insensitive NO_REPLY matching", () => {
    const messages = [
      makeUserMessage("hi"),
      makeAssistantMessage("no_reply"),
      makeAssistantMessage("NO_REPLY"),
      makeAssistantMessage("No_Reply"),
    ];
    const result = pruneConsecutiveNoReplies(messages);
    expect(result).toEqual([
      makeUserMessage("hi"),
      makeAssistantMessage("no_reply"),
    ]);
  });

  it("handles NO_REPLY with whitespace", () => {
    const messages = [
      makeUserMessage("hi"),
      makeAssistantMessage("  NO_REPLY  "),
      makeAssistantMessage("NO_REPLY"),
    ];
    const result = pruneConsecutiveNoReplies(messages);
    expect(result).toEqual([
      makeUserMessage("hi"),
      makeAssistantMessage("  NO_REPLY  "),
    ]);
  });
});

describe("countNoReplies", () => {
  it("returns zeros for empty array", () => {
    expect(countNoReplies([])).toEqual({ total: 0, maxConsecutive: 0, runs: 0 });
  });

  it("counts total and consecutive NO_REPLYs", () => {
    const messages = [
      makeUserMessage("1"),
      makeNoReply(),
      makeNoReply(),
      makeUserMessage("2"),
      makeNoReply(),
      makeNoReply(),
      makeNoReply(),
      makeUserMessage("3"),
    ];
    const result = countNoReplies(messages);
    expect(result).toEqual({ total: 5, maxConsecutive: 3, runs: 2 });
  });

  it("counts single NO_REPLY correctly", () => {
    const messages = [makeUserMessage("hi"), makeNoReply()];
    const result = countNoReplies(messages);
    expect(result).toEqual({ total: 1, maxConsecutive: 1, runs: 1 });
  });
});
