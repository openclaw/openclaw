import { describe, expect, it } from "vitest";
import { buildPromptPrefix } from "./prompt.js";
import { buildSearchQuery, extractRecentTurns } from "./query.js";

describe("active-memory search queries", () => {
  it.each([
    [
      `what should I pack?\n\n${buildPromptPrefix("User prefers aisle seats.")}`,
      [],
      "what should I pack?",
    ],
    ["Context: my project uses TypeScript", [], "Context: my project uses TypeScript"],
    [
      "why?",
      [{ role: "user" as const, text: `${"x".repeat(119)}🚀tail` }],
      `${"x".repeat(119)} why?`,
    ],
  ])("builds a safe query from %#", (latestUserMessage, recentTurns, expected) => {
    const query = buildSearchQuery({ latestUserMessage, recentTurns });
    expect(query).toBe(expected);
    expect(query).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
    );
  });
});

describe("active-memory recent turn block boundaries", () => {
  const header = "Context:";
  const open = "<active_memory_plugin>";
  const close = "</active_memory_plugin>";

  it.each([
    {
      name: "multiple blocks after an earlier close",
      lines: [
        close,
        "before",
        header,
        open,
        "hidden",
        close,
        "middle",
        header,
        open,
        "hidden",
        close,
        "after",
      ],
      assistant: "before middle after",
      user: `${close} before middle after`,
    },
    {
      name: "a physical blank between header and open",
      lines: [header, "", open, "visible", close, "after"],
      assistant: "after",
      user: `${header} ${open} visible ${close} after`,
    },
    {
      name: "an unclosed block",
      lines: [header, open, "visible"],
      assistant: `${open} visible`,
      user: `${header} ${open} visible`,
    },
    {
      name: "the first close after nested opening text",
      lines: [header, open, "outer", open, "inner", close, "tail", close, "after"],
      assistant: "tail after",
      user: `tail ${close} after`,
    },
    {
      name: "trimmed CRLF markers",
      lines: [` ${header} \r`, `\t${open}\r`, "hidden\r", ` ${close} \r`, " after "],
      assistant: "after",
      user: "after",
    },
    {
      name: "a block-only turn",
      lines: [header, open, "hidden", close],
      assistant: "",
      user: "",
    },
  ])("preserves role-specific cleanup for $name", ({ lines, assistant, user }) => {
    const content = lines.join("\n");
    for (const [role, text] of [
      ["assistant", assistant],
      ["user", user],
    ] as const) {
      expect(extractRecentTurns([{ role, content }])).toEqual(text ? [{ role, text }] : []);
    }
  });
});
