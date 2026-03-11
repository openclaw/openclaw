import { SessionManager } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { sessionHasRealMessages } from "./compact.js";

function createInMemorySession(
  messages: Array<{ role: string; content: string | Array<{ type: string; text: string }> }>,
): SessionManager {
  const sm = SessionManager.inMemory("/tmp/test");
  for (const msg of messages) {
    sm.appendMessage(msg as never);
  }
  return sm;
}

describe("sessionHasRealMessages", () => {
  it("returns false for a session with no entries", () => {
    const sm = SessionManager.inMemory("/tmp/test");
    expect(sessionHasRealMessages(sm)).toBe(false);
  });

  it("returns false for a session with only system-like entries", () => {
    const sm = SessionManager.inMemory("/tmp/test");
    // Custom entries are not real conversation messages
    sm.appendCustomEntry("some-extension", { foo: "bar" });
    expect(sessionHasRealMessages(sm)).toBe(false);
  });

  it("returns true for a session with a user message", () => {
    const sm = createInMemorySession([{ role: "user", content: "Hello" }]);
    expect(sessionHasRealMessages(sm)).toBe(true);
  });

  it("returns true for a session with an assistant message", () => {
    const sm = createInMemorySession([
      { role: "user", content: "Hello" },
      { role: "assistant", content: [{ type: "text", text: "Hi there" }] },
    ]);
    expect(sessionHasRealMessages(sm)).toBe(true);
  });

  it("returns true for a session with a toolResult message", () => {
    const sm = SessionManager.inMemory("/tmp/test");
    sm.appendMessage({ role: "user", content: "run a tool" } as never);
    sm.appendMessage({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tool-1",
          name: "test",
          input: {},
        },
      ],
    } as never);
    sm.appendMessage({
      role: "toolResult",
      toolCallId: "tool-1",
      content: "result",
    } as never);
    expect(sessionHasRealMessages(sm)).toBe(true);
  });
});
