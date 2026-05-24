import { describe, expect, it, vi } from "vitest";
import { extractEventSessionAndText, extractReplyText } from "./router-context.js";

describe("extractEventSessionAndText", () => {
  it("prefers payload session_id and text over body fields", () => {
    const result = extractEventSessionAndText(
      { session_id: "body-session", text: "body text" },
      { session_id: "payload-session", text: "payload text" },
    );
    expect(result).toEqual({ sessionId: "payload-session", text: "payload text" });
  });

  it("falls back to body sessionId and message when payload lacks them", () => {
    const result = extractEventSessionAndText(
      { sessionId: "  sess-1  ", message: "  hello  " },
      {},
    );
    expect(result).toEqual({ sessionId: "sess-1", text: "hello" });
  });

  it("returns null for empty or non-string values", () => {
    expect(extractEventSessionAndText({ session_id: "", text: 42 }, {})).toEqual({
      sessionId: null,
      text: null,
    });
  });
});

describe("extractReplyText", () => {
  it("extracts text, reply, or message in priority order", () => {
    expect(extractReplyText({ text: "from text" })).toBe("from text");
    expect(extractReplyText({ reply: "from reply" })).toBe("from reply");
    expect(extractReplyText({ message: "from message" })).toBe("from message");
    expect(extractReplyText({ text: "a", reply: "b" })).toBe("a");
  });

  it("returns null when output is missing or has no known reply fields", () => {
    expect(extractReplyText(null)).toBeNull();
    expect(extractReplyText({ result: "nope" })).toBeNull();
  });
});
