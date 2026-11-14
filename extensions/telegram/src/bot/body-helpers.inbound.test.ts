import type { Message, MessageEntity } from "grammy/types";
import { markdownToIR } from "openclaw/plugin-sdk/text-chunking";
import { expect, it } from "vitest";
import { getTelegramTextParts, joinTelegramTextParts } from "./body-helpers.js";
import { renderTelegramTextEntities } from "./inbound-text-entities.js";

function joinParts(...parts: Parameters<typeof getTelegramTextParts>[0][]) {
  const messages = parts.map((part) => part as Message);
  return joinTelegramTextParts(messages, "\n");
}

function span(type: "bold" | "code" | "blockquote", text: string, content = text): MessageEntity {
  return { type, offset: text.indexOf(content), length: content.length };
}

it.each<"regular" | "quiz">(["regular", "quiz"])("renders %s polls with escaped links", (type) => {
  const quiz = type === "quiz";
  const label = "docs]more";
  const url = "https://example.com/report)final";
  const result = getTelegramTextParts({
    poll: {
      id: "poll-1",
      question: "Ship the release?",
      options: [
        { persistent_id: "yes", text: "Yes", voter_count: 2 },
        { persistent_id: "no", text: "No", voter_count: 1 },
      ],
      total_voter_count: 3,
      is_closed: false,
      is_anonymous: !quiz,
      type,
      allows_multiple_answers: false,
      allows_revoting: false,
      members_only: false,
      correct_option_ids: quiz ? [0] : undefined,
      description: `Read ${label}`,
      description_entities: [{ type: "text_link", offset: 5, length: label.length, url }],
      explanation: quiz ? "All checks passed." : undefined,
      explanation_entities: [{ type: "bold", offset: 0, length: 3 }],
    },
  });
  expect(result).toEqual({
    text: `[Poll] Ship the release?
Read [docs\\]more](https://example.com/report\\)final)
1. Yes — 2 votes${quiz ? " (correct)" : ""}
2. No — 1 vote
Total voters: 3
Type: ${type}
Visibility: ${quiz ? "public" : "anonymous"}
Selection: single answer
Status: open${quiz ? "\nExplanation: **All** checks passed." : ""}`,
    entities: [],
  });
  const parsed = markdownToIR(result.text);
  expect(parsed.text).toContain(`Read ${label}`);
  expect(parsed.links.map((link) => link.href)).toEqual([url]);
});

it("skips empty segments without shifting later entity offsets", () => {
  const result = joinParts({ text: "" }, { text: "bold", entities: [span("bold", "bold")] });

  expect(result).toEqual({
    text: "bold",
    entities: [{ type: "bold", offset: 0, length: 4 }],
  });
});

it.each(["a`b", "npm`", " npm ", " "])("round-trips inline code %j", (code) => {
  const prefix = "😀 Code: ";
  const text = `${prefix}${code} end`;
  const entities = [{ ...span("code", code), offset: prefix.length }];
  const result = joinParts({ text, entities }, { caption: text, caption_entities: entities });

  const parsed = markdownToIR(renderTelegramTextEntities(result.text, result.entities));

  expect(parsed.text).toBe(result.text);
  expect(
    parsed.styles
      .filter((style) => style.style === "code")
      .map((style) => parsed.text.slice(style.start, style.end)),
  ).toEqual([code, code]);
});

it("preserves normalized spaces in inline code", () => {
  const parsed = markdownToIR(
    renderTelegramTextEntities("Code:  \r\n  end", [{ type: "code", offset: 6, length: 4 }]),
  );

  expect(parsed.text).toBe("Code:     end");
  expect(parsed.styles).toEqual([{ start: 6, end: 9, style: "code" }]);
});

it("preserves multiline blockquote entities and nested formatting", () => {
  const text = "Before\n😀 quoted\nsecond link\nAfter";
  const quote = "😀 quoted\nsecond link";
  const entities: MessageEntity[] = [span("blockquote", text, quote), span("bold", text, "quoted")];

  expect(renderTelegramTextEntities(text, entities)).toBe(
    "Before\n> 😀 **quoted**\n> second link\n\nAfter",
  );
});

it("reopens enclosing formatting across a quote block", () => {
  const text = "bold before\nquoted\nbold after";
  const entities = [span("bold", text), span("blockquote", text, "quoted")];

  expect(renderTelegramTextEntities(text, entities)).toBe(
    "**bold before**\n> **quoted**\n\n**bold after**",
  );
});
