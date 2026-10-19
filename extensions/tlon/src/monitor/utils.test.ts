import { marked } from "marked";
import { describe, expect, it } from "vitest";
import { extractMessageText, formatModelName, formatSummarizationHistoryText } from "./utils.js";

describe("formatModelName", () => {
  it.each([
    ["openai/gpt-4o", "GPT-4o"],
    ["local/custom-model", "Custom Model"],
    ["local/constructor", "Constructor"],
    ["toString", "ToString"],
  ])("formats %s as %s", (model, expected) => {
    expect(formatModelName(model)).toBe(expected);
  });
});

describe("extractMessageText code blocks", () => {
  it.each([
    { name: "ordinary code", code: "const answer = 42;", lang: "javascript" },
    {
      name: "nested triple-backtick fences",
      code: "Before\n```markdown\n# literal heading\n```\nAfter",
      lang: "markdown",
    },
    {
      name: "longer backtick fences",
      code: "Before\n`````text\n- literal\n`````\nAfter",
      lang: "markdown",
    },
    { name: "empty code without a language", code: "", lang: "" },
  ])("preserves $name as one Markdown code block", ({ code, lang }) => {
    const text = extractMessageText([{ block: { code: { code, lang } } }]);
    const tokens = marked.lexer(text).filter((token) => token.type !== "space");
    expect(tokens).toMatchObject([{ type: "code", lang, text: code }]);
  });
});

// 2026-07-01 12:00:00 UTC. The same instant in any zone, so assertions can
// compare timezone-aware output deterministically.
const SAMPLE_TS = Date.UTC(2026, 6, 1, 12, 0, 0);

describe("extractMessageText nested inline content", () => {
  const MAX_DEPTH = 100;

  function nest(style: "bold" | "italics" | "strike", levels: number, leaf: unknown = "x") {
    let node: unknown = leaf;
    for (let i = 0; i < levels; i += 1) {
      node = { [style]: [node] };
    }
    return node;
  }

  it("renders legitimate nested inline styles", () => {
    const text = extractMessageText([
      { inline: [{ bold: [{ italics: ["deep "] }, { strike: ["text"] }] }] },
    ]);
    expect(text).toBe("***deep *~~text~~**");
  });

  it("keeps the leaf at exactly the depth cap and drops it one level deeper", () => {
    expect(extractMessageText([{ inline: [nest("bold", MAX_DEPTH)] }])).toBe(
      `${"**".repeat(MAX_DEPTH)}x${"**".repeat(MAX_DEPTH)}`,
    );
    expect(extractMessageText([{ inline: [nest("bold", MAX_DEPTH + 1)] }])).toBe(
      "**".repeat(MAX_DEPTH * 2),
    );
  });

  it.each(["bold", "italics", "strike"] as const)(
    "truncates %s nesting at the cap instead of overflowing the stack",
    (style) => {
      const marker = { bold: "**", italics: "*", strike: "~~" }[style];
      const text = extractMessageText([{ inline: [nest(style, 2_000)] }, { inline: ["visible"] }]);
      expect(text).toBe(`${marker.repeat(MAX_DEPTH * 2)}\nvisible`);
    },
  );

  it("truncates mixed-style nesting while keeping shallower siblings and later verses", () => {
    let node: unknown = { strike: ["inner"] };
    for (let i = 0; i < 150; i += 1) {
      node = i % 2 === 0 ? { bold: [node] } : { italics: [node] };
    }
    const text = extractMessageText([{ inline: ["head ", node, " tail"] }, { inline: ["next"] }]);
    expect(text.startsWith("head ")).toBe(true);
    expect(text).toContain(" tail\nnext");
    expect(text).not.toContain("inner");
  });
});

describe("formatSummarizationHistoryText", () => {
  it("shifts the local time relative to the UTC baseline when a non-UTC zone is configured", () => {
    const history = [{ author: "~a", content: "x", timestamp: SAMPLE_TS }];
    const utc = formatSummarizationHistoryText(history, {
      agents: { defaults: { userTimezone: "UTC" } },
    });
    const shanghai = formatSummarizationHistoryText(history, {
      agents: { defaults: { userTimezone: "Asia/Shanghai" } },
    });
    const newYork = formatSummarizationHistoryText(history, {
      agents: { defaults: { userTimezone: "America/New_York" } },
    });
    expect(utc).toContain("2026-07-01T12:00:00Z");
    expect(utc).toContain("~a");
    expect(utc).toContain("x");
    expect(shanghai).toContain("20:00:00");
    expect(newYork).toContain("08:00:00");
    expect(shanghai).not.toBe(utc);
    expect(newYork).not.toBe(utc);
  });

  it("joins multiple entries with newlines", () => {
    const history = [
      { author: "~a", content: "first", timestamp: SAMPLE_TS },
      { author: "~b", content: "second", timestamp: SAMPLE_TS + 60_000 },
    ];
    const text = formatSummarizationHistoryText(history, {
      agents: { defaults: { userTimezone: "UTC" } },
    });
    expect(text.split("\n")).toHaveLength(2);
    expect(text).toContain("first");
    expect(text).toContain("second");
  });
});
