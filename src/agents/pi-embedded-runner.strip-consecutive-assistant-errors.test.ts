import { describe, expect, it } from "vitest";
import { stripConsecutiveAssistantErrors } from "./pi-embedded-runner/google.js";
import {
  castAgentMessages,
  makeAgentAssistantMessage,
  makeAgentUserMessage,
} from "./test-helpers/agent-message-fixtures.js";

describe("stripConsecutiveAssistantErrors", () => {
  const makeErrorAssistant = (errorMessage = "Connection error.") =>
    makeAgentAssistantMessage({
      content: [],
      stopReason: "error",
      errorMessage,
    });

  const makeOkAssistant = (text = "Hello") =>
    makeAgentAssistantMessage({
      content: [{ type: "text", text }],
      stopReason: "stop",
    });

  const makeUser = (content = "hi") => makeAgentUserMessage({ content });

  it("returns empty array unchanged", () => {
    expect(stripConsecutiveAssistantErrors([])).toEqual([]);
  });

  it("returns single message unchanged", () => {
    const msgs = castAgentMessages([makeUser()]);
    expect(stripConsecutiveAssistantErrors(msgs)).toEqual(msgs);
  });

  it("does not touch messages without errors", () => {
    const msgs = castAgentMessages([makeUser(), makeOkAssistant(), makeUser("bye")]);
    expect(stripConsecutiveAssistantErrors(msgs)).toEqual(msgs);
  });

  it("keeps a single error entry untouched", () => {
    const msgs = castAgentMessages([makeUser(), makeErrorAssistant()]);
    expect(stripConsecutiveAssistantErrors(msgs)).toEqual(msgs);
  });

  it("collapses two consecutive error entries into the last one", () => {
    const err1 = makeErrorAssistant("first error");
    const err2 = makeErrorAssistant("second error");
    const msgs = castAgentMessages([makeUser(), err1, err2]);
    const result = stripConsecutiveAssistantErrors(msgs);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(msgs[0]); // user message preserved
    expect(result[1]).toBe(msgs[2]); // last error kept
  });

  it("collapses three consecutive error entries into the last one", () => {
    const err1 = makeErrorAssistant("error 1");
    const err2 = makeErrorAssistant("error 2");
    const err3 = makeErrorAssistant("error 3");
    const msgs = castAgentMessages([makeUser(), err1, err2, err3]);
    const result = stripConsecutiveAssistantErrors(msgs);
    expect(result).toHaveLength(2);
    expect(result[1]).toBe(msgs[3]); // last error kept
  });

  it("preserves non-error assistant between error runs", () => {
    const err1 = makeErrorAssistant("err A");
    const err2 = makeErrorAssistant("err B");
    const ok = makeOkAssistant("success");
    const err3 = makeErrorAssistant("err C");
    const err4 = makeErrorAssistant("err D");
    const msgs = castAgentMessages([makeUser(), err1, err2, ok, err3, err4]);
    const result = stripConsecutiveAssistantErrors(msgs);
    // user, err2 (collapsed from err1+err2), ok, err4 (collapsed from err3+err4)
    expect(result).toHaveLength(4);
    expect(result[0]).toBe(msgs[0]); // user
    expect(result[1]).toBe(msgs[2]); // err2 (last of first run)
    expect(result[2]).toBe(msgs[3]); // ok assistant
    expect(result[3]).toBe(msgs[5]); // err4 (last of second run)
  });

  it("preserves user messages between error entries", () => {
    const err1 = makeErrorAssistant("err 1");
    const user2 = makeUser("retry");
    const err2 = makeErrorAssistant("err 2");
    const msgs = castAgentMessages([makeUser(), err1, user2, err2]);
    const result = stripConsecutiveAssistantErrors(msgs);
    // No consecutive errors — all messages preserved
    expect(result).toEqual(msgs);
  });

  it("handles session with only error entries", () => {
    const msgs = castAgentMessages([
      makeErrorAssistant("e1"),
      makeErrorAssistant("e2"),
      makeErrorAssistant("e3"),
    ]);
    const result = stripConsecutiveAssistantErrors(msgs);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(msgs[2]); // last one kept
  });

  it("handles realistic session poisoning scenario", () => {
    // Simulate: user sends message, 5 consecutive connection errors during retries,
    // then user sends another message
    const user1 = makeUser("what is 2+2?");
    const errors = Array.from({ length: 5 }, (_, i) =>
      makeErrorAssistant(`Connection error. (attempt ${i + 1})`),
    );
    const user2 = makeUser("please try again");
    const ok = makeOkAssistant("2+2 = 4");
    const msgs = castAgentMessages([user1, ...errors, user2, ok]);
    const result = stripConsecutiveAssistantErrors(msgs);
    // user1, last error, user2, ok
    expect(result).toHaveLength(4);
    expect(result[0]).toBe(msgs[0]); // user1
    expect((result[1] as { errorMessage?: string }).errorMessage).toBe(
      "Connection error. (attempt 5)",
    ); // last error
    expect(result[2]).toBe(msgs[6]); // user2
    expect(result[3]).toBe(msgs[7]); // ok
  });
});
