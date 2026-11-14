import { marked } from "marked";
import { expect, it } from "vitest";
import { extractMessageText, formatModelName, formatSummarizationHistoryText } from "./utils.js";

it.each([
  ["openai/gpt-4o", "GPT-4o"],
  ["local/custom-model", "Custom Model"],
  ["local/constructor", "Constructor"],
  ["toString", "ToString"],
])("formatModelName formats %s as %s", (model, expected) => {
  expect(formatModelName(model)).toBe(expected);
});

it.each([
  ["const answer = 42;", "javascript"],
  ["Before\n```markdown\n# literal heading\n```\nAfter", "markdown"],
  ["Before\n`````text\n- literal\n`````\nAfter", "markdown"],
  ["", ""],
])("extractMessageText preserves %j as one Markdown code block (%s)", (code, lang) => {
  const text = extractMessageText([{ block: { code: { code, lang } } }]);
  const tokens = marked.lexer(text).filter((token) => token.type !== "space");
  expect(tokens).toMatchObject([{ type: "code", lang, text: code }]);
});

const MAX_DEPTH = 100;
const render = (...inline: unknown[]) => extractMessageText([{ inline }]);

function nest(style: "bold" | "italics" | "strike", levels: number, leaf: unknown = "x") {
  let node: unknown = leaf;
  for (let i = 0; i < levels; i += 1) {
    node = { [style]: [node] };
  }
  return node;
}

it("renders legitimate nested inline styles", () => {
  expect(render({ bold: [{ italics: ["deep "] }, { strike: ["text"] }] })).toBe(
    "***deep *~~text~~**",
  );
});

it("keeps the leaf at exactly the depth cap and drops it one level deeper", () => {
  expect(render(nest("bold", MAX_DEPTH))).toBe(
    `${"**".repeat(MAX_DEPTH)}x${"**".repeat(MAX_DEPTH)}`,
  );
  expect(render(nest("bold", MAX_DEPTH + 1))).toBe("**".repeat(MAX_DEPTH * 2));
});

it.each(["bold", "italics", "strike"] as const)(
  "bounds deep %s nesting and preserves later verses",
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

const SAMPLE_TS = Date.UTC(2026, 6, 1, 12);

it("shifts the local time relative to the UTC baseline when a non-UTC zone is configured", () => {
  const history = [{ author: "~a", content: "x", timestamp: SAMPLE_TS }];
  const [utc, shanghai, newYork] = ["UTC", "Asia/Shanghai", "America/New_York"].map(
    (userTimezone) =>
      formatSummarizationHistoryText(history, { agents: { defaults: { userTimezone } } }),
  );
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
