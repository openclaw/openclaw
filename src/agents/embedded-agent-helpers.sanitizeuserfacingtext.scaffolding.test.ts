import { describe, expect, it } from "vitest";
import { sanitizeUserFacingText } from "./embedded-agent-helpers/sanitize-user-facing-text.js";

describe("sanitizeUserFacingText conversation and exec scaffolding", () => {
  it.each([
    {
      name: "drops the canonical empty exec placeholder",
      input: "(no output)",
      expected: "",
    },
    {
      name: "removes an empty exec placeholder without dropping its surrounding answer",
      input: "Before\n(no output)\nAfter",
      expected: "Before\nAfter",
    },
    {
      name: "preserves an inline discussion of the empty exec placeholder",
      input: "The literal (no output) text is relevant.",
      expected: "The literal (no output) text is relevant.",
    },
    {
      name: "preserves a quoted empty exec placeholder",
      input: "> (no output)\n\nThat is the exact command output.",
      expected: "> (no output)\n\nThat is the exact command output.",
    },
    {
      name: "preserves an indented Markdown code example of the empty placeholder",
      input: "Command output:\n\n    (no output)",
      expected: "Command output:\n\n    (no output)",
    },
    {
      name: "preserves placeholders and context markers inside a Markdown code fence",
      input: ["```text", "[Current message - respond to this]", "(no output)", "```"].join("\n"),
      expected: ["```text", "[Current message - respond to this]", "(no output)", "```"].join("\n"),
    },
    {
      name: "preserves replay and exec placeholders inside a tilde code fence",
      input: ["~~~text", "[tool calls omitted]", "(no output)", "~~~"].join("\n"),
      expected: ["~~~text", "[tool calls omitted]", "(no output)", "~~~"].join("\n"),
    },
    {
      name: "preserves context markers inside a multi-paragraph fenced example",
      input: [
        "```text",
        "[Chat messages since your last reply - for context]",
        "earlier example",
        "",
        "[Current message - respond to this]",
        "current example",
        "```",
      ].join("\n"),
      expected: [
        "```text",
        "[Chat messages since your last reply - for context]",
        "earlier example",
        "",
        "[Current message - respond to this]",
        "current example",
        "```",
      ].join("\n"),
    },
    {
      name: "strips an actual current-message context block",
      input: [
        "[Current message - respond to this]",
        "[Telegram 2026-05-05T20:20:00Z] Danny: ping",
        "[from: Danny]",
        "",
        "Pong.",
      ].join("\n"),
      expected: "Pong.",
      conversationContext: [
        "[Current message - respond to this]",
        "[Telegram 2026-05-05T20:20:00Z] Danny: ping",
        "[from: Danny]",
      ].join("\n"),
    },
    {
      name: "strips actual history and current-message context blocks",
      input: [
        "[Chat messages since your last reply - for context]",
        "[Telegram 2026-05-05T20:19:00Z] Danny: previous",
        "",
        "[Current message - respond to this]",
        "[Telegram 2026-05-05T20:20:00Z] Danny: current",
        "",
        "Visible reply.",
      ].join("\n"),
      expected: "Visible reply.",
      conversationContext: [
        "[Chat messages since your last reply - for context]",
        "[Telegram 2026-05-05T20:19:00Z] Danny: previous",
        "",
        "[Current message - respond to this]",
        "[Telegram 2026-05-05T20:20:00Z] Danny: current",
      ].join("\n"),
    },
    {
      name: "strips a priority header only beside an actual context marker",
      input: [
        "Current message priority: high",
        "[Current message - respond to this]",
        "[Telegram 2026-05-05T20:20:00Z] Danny: ping",
        "",
        "Pong.",
      ].join("\n"),
      expected: "Pong.",
      conversationContext: [
        "Current message priority: high",
        "[Current message - respond to this]",
        "[Telegram 2026-05-05T20:20:00Z] Danny: ping",
      ].join("\n"),
    },
    {
      name: "preserves ordinary user-visible priority prose",
      input: "Current message priority: high means the sender flagged this ticket.",
      expected: "Current message priority: high means the sender flagged this ticket.",
    },
    {
      name: "preserves a quoted conversation context",
      input: [
        "> [Current message - respond to this]",
        "> [Telegram] quoted example",
        "",
        "That is the format you asked about.",
      ].join("\n"),
      expected: [
        "> [Current message - respond to this]",
        "> [Telegram] quoted example",
        "",
        "That is the format you asked about.",
      ].join("\n"),
    },
    {
      name: "preserves an indented Markdown code example of a conversation context",
      input: [
        "Prompt format:",
        "",
        "    [Current message - respond to this]",
        "    [Telegram] example",
      ].join("\n"),
      expected: [
        "Prompt format:",
        "",
        "    [Current message - respond to this]",
        "    [Telegram] example",
      ].join("\n"),
    },
    {
      name: "preserves CRLF while stripping an actual copied context",
      input: [
        "Current message priority: high",
        "[Current message - respond to this]",
        "[Telegram] ping",
        "",
        "Pong.",
      ].join("\r\n"),
      expected: "Pong.",
      conversationContext: [
        "Current message priority: high",
        "[Current message - respond to this]",
        "[Telegram] ping",
      ].join("\r\n"),
    },
    {
      name: "strips real scaffolding even when copied user text contains a code fence",
      input: [
        "[Current message - respond to this]",
        "[Telegram] explain this",
        "```text",
        "example",
        "```",
        "",
        "Visible answer.",
      ].join("\n"),
      expected: "Visible answer.",
      conversationContext: [
        "[Current message - respond to this]",
        "[Telegram] explain this",
        "```text",
        "example",
        "```",
      ].join("\n"),
    },
  ])(
    "$name",
    ({
      input,
      expected,
      conversationContext,
    }: {
      input: string;
      expected: string;
      conversationContext?: string;
    }) => {
      expect(sanitizeUserFacingText(input, { conversationContext })).toBe(expected);
    },
  );

  it("preserves a same-paragraph answer when there is no verified inbound context", () => {
    expect(
      sanitizeUserFacingText(
        "[Current message - respond to this]\nA real answer starts immediately.",
      ),
    ).toBe("A real answer starts immediately.");
  });

  it("removes repeated verified multiline context without exposing later inbound paragraphs", () => {
    const conversationContext = [
      "[Current message - respond to this]",
      "[Telegram] first inbound paragraph",
      "",
      "private second inbound paragraph",
    ].join("\n");

    expect(
      sanitizeUserFacingText(
        `${conversationContext}\n\n${conversationContext}\n\nVisible answer.`,
        { conversationContext },
      ),
    ).toBe("Visible answer.");
  });

  it("matches inbound prompt provenance before destructive tool-call XML cleanup", () => {
    const conversationContext = [
      "[Current message - respond to this]",
      "[Telegram] explain this tool call",
      '<function_calls><invoke name="exec">private inbound XML</invoke></function_calls>',
      "",
      "private second inbound paragraph",
    ].join("\n");

    expect(
      sanitizeUserFacingText(`${conversationContext}\n\nVisible answer.`, {
        conversationContext,
      }),
    ).toBe("Visible answer.");
  });

  it("removes the complete verified multiline context without dropping a multiline answer", () => {
    const conversationContext = [
      "Current message priority: high",
      "[Current message - respond to this]",
      "[Telegram] first message paragraph",
      "",
      "second message paragraph",
      "",
      "```text",
      "a fenced snippet in the inbound message",
      "```",
    ].join("\n");
    const visibleReply = "First answer paragraph.\n\nSecond answer paragraph.";

    expect(
      sanitizeUserFacingText(`${conversationContext}\n\n${visibleReply}`, {
        conversationContext,
      }),
    ).toBe(visibleReply);
  });

  it("removes a CRLF inbound context when the model echoes it with LF", () => {
    const lfContext = [
      "[Current message - respond to this]",
      "[Telegram] first inbound paragraph",
      "",
      "second inbound paragraph",
    ].join("\n");
    const conversationContext = lfContext.replace(/\n/gu, "\r\n");
    const visibleReply = "First answer paragraph.\n\nSecond answer paragraph.";

    expect(sanitizeUserFacingText(`${lfContext}\n\n${visibleReply}`, { conversationContext })).toBe(
      visibleReply,
    );
  });

  it("removes an LF inbound context when the model echoes it with CRLF", () => {
    const conversationContext = [
      "[Current message - respond to this]",
      "[Telegram] first inbound paragraph",
      "",
      "second inbound paragraph",
    ].join("\n");
    const crlfContext = conversationContext.replace(/\n/gu, "\r\n");
    const visibleReply = "First answer paragraph.\r\n\r\nSecond answer paragraph.";

    expect(
      sanitizeUserFacingText(`${crlfContext}\r\n\r\n${visibleReply}`, { conversationContext }),
    ).toBe(visibleReply);
  });

  it("removes a mixed-newline inbound context when the model normalizes it to LF", () => {
    const lfContext = [
      "[Current message - respond to this]",
      "[Telegram] first inbound paragraph",
      "",
      "private second inbound paragraph",
    ].join("\n");
    const mixedContext = lfContext.replace("\n", "\r\n");

    expect(
      sanitizeUserFacingText(`${lfContext}\n\nVisible answer.`, {
        conversationContext: mixedContext,
      }),
    ).toBe("Visible answer.");
  });

  it("never removes the verified inbound context when it is intentionally quoted", () => {
    const conversationContext = [
      "[Current message - respond to this]",
      "[Telegram] quoted example",
    ].join("\n");
    const quotedReply = conversationContext
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");

    expect(sanitizeUserFacingText(quotedReply, { conversationContext })).toBe(quotedReply);
  });

  it("never removes the verified inbound context when it is intentionally fenced", () => {
    const conversationContext = [
      "[Current message - respond to this]",
      "[Telegram] fenced example",
    ].join("\n");
    const fencedReply = `\`\`\`text\n${conversationContext}\n\`\`\``;

    expect(sanitizeUserFacingText(fencedReply, { conversationContext })).toBe(fencedReply);
  });
});
