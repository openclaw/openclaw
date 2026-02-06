import { describe, expect, it } from "vitest";
import { sanitizeWhatsAppOutboundText, sanitizeWhatsAppOutboundPoll } from "./sanitize.js";

describe("sanitizeWhatsAppOutboundText", () => {
  it("replaces raw numeric mention IDs", () => {
    expect(sanitizeWhatsAppOutboundText("hi @69771945103584")).toBe("hi [mention]");
  });

  it("replaces raw hex mention IDs", () => {
    expect(sanitizeWhatsAppOutboundText("hi @AC8E7CBDDC9C0A1B")).toBe("hi [mention]");
  });

  it("replaces raw mention IDs followed by punctuation", () => {
    expect(sanitizeWhatsAppOutboundText("hi @69771945103584,")).toBe("hi [mention],");
    expect(sanitizeWhatsAppOutboundText("@AC8E7CBDDC9C0A1B.")).toBe("[mention].");
  });

  it("does not touch normal @usernames", () => {
    expect(sanitizeWhatsAppOutboundText("hi @eliehabib")).toBe("hi @eliehabib");
  });

  it("strips standalone [message_id: ...] lines", () => {
    expect(sanitizeWhatsAppOutboundText("ok\n[message_id: 7391]\nthanks")).toBe("ok\nthanks");
  });
});

describe("sanitizeWhatsAppOutboundPoll", () => {
  it("sanitizes question + options", () => {
    const poll = sanitizeWhatsAppOutboundPoll({
      question: "Ping @69771945103584?",
      options: ["Yes", "No", "Ask @AC8E7CBDDC9C0A1B"],
      maxSelections: 1,
    });
    expect(poll.question).toBe("Ping [mention]?");
    expect(poll.options).toEqual(["Yes", "No", "Ask [mention]"]);
    expect(poll.maxSelections).toBe(1);
  });

  it("handles null/undefined question and options", () => {
    const poll = sanitizeWhatsAppOutboundPoll({
      question: undefined,
      options: [null, "test"],
      maxSelections: 1,
    });
    expect(poll.question).toBe("");
    expect(poll.options).toEqual(["", "test"]);
    expect(poll.maxSelections).toBe(1);
  });
});
