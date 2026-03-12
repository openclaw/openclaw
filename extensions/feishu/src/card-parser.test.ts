import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseFeishuCardToMarkdownString } from "./card-parser.js";

const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../test/fixtures/feishu-card-parser",
);

describe("parseFeishuCardToMarkdownString", () => {
  it("parses complex technical documentation card correctly", () => {
    const card = JSON.parse(fs.readFileSync(path.join(fixturePath, "card-input.json"), "utf8"));
    const expected = fs.readFileSync(path.join(fixturePath, "card-expected.md"), "utf8").trim();
    expect(parseFeishuCardToMarkdownString(card)).toBe(expected);
  });

  it("returns fallback for invalid JSON string", () => {
    expect(parseFeishuCardToMarkdownString("not valid json")).toBe("[Interactive Card]");
  });

  it("returns fallback for empty object", () => {
    expect(parseFeishuCardToMarkdownString({})).toBe("[unknown: ]");
  });

  it("returns fallback for null / non-object input", () => {
    expect(parseFeishuCardToMarkdownString(null)).toBe("[Interactive Card]");
    expect(parseFeishuCardToMarkdownString(42)).toBe("[Interactive Card]");
  });

  it("parses a JSON string input", () => {
    const json = JSON.stringify({ elements: [{ tag: "markdown", content: "hello" }] });
    expect(parseFeishuCardToMarkdownString(json)).toBe("hello");
  });

  it("parses heading with correct level from property", () => {
    expect(
      parseFeishuCardToMarkdownString({
        elements: [
          {
            tag: "heading",
            property: {
              elements: [{ tag: "plain_text", property: { content: "Title" } }],
              level: 3,
            },
          },
        ],
      }),
    ).toBe("### Title");
  });

  it("parses unordered list", () => {
    expect(
      parseFeishuCardToMarkdownString({
        elements: [
          {
            tag: "list",
            property: {
              items: [
                { type: "ul", elements: [{ tag: "plain_text", property: { content: "A" } }] },
                { type: "ul", elements: [{ tag: "plain_text", property: { content: "B" } }] },
              ],
            },
          },
        ],
      }),
    ).toBe("- A\n- B");
  });

  it("parses ordered list with order field", () => {
    expect(
      parseFeishuCardToMarkdownString({
        elements: [
          {
            tag: "list",
            property: {
              items: [
                {
                  type: "ol",
                  order: 1,
                  elements: [{ tag: "plain_text", property: { content: "First" } }],
                },
                {
                  type: "ol",
                  order: 2,
                  elements: [{ tag: "plain_text", property: { content: "Second" } }],
                },
              ],
            },
          },
        ],
      }),
    ).toBe("1. First\n2. Second");
  });

  it("parses code_block with language", () => {
    expect(
      parseFeishuCardToMarkdownString({
        elements: [
          {
            tag: "code_block",
            property: {
              language: "python",
              contents: [{ contents: [{ content: "print('hi')\n" }] }],
            },
          },
        ],
      }),
    ).toContain("```python");
  });

  it("parses code_span", () => {
    expect(
      parseFeishuCardToMarkdownString({
        elements: [{ tag: "code_span", property: { content: "foo" } }],
      }),
    ).toBe("`foo`");
  });

  it("parses blockquote with > prefix", () => {
    expect(
      parseFeishuCardToMarkdownString({
        elements: [
          {
            tag: "blockquote",
            property: {
              elements: [{ tag: "plain_text", property: { content: "quoted text" } }],
            },
          },
        ],
      }),
    ).toContain("> quoted text");
  });

  it("parses table", () => {
    const result = parseFeishuCardToMarkdownString({
      elements: [
        {
          tag: "table",
          property: {
            columns: [
              { displayName: "Name", name: "0" },
              { displayName: "Age", name: "1" },
            ],
            rows: [
              {
                "0": {
                  data: {
                    tag: "markdown",
                    property: { elements: [{ tag: "plain_text", property: { content: "Alice" } }] },
                  },
                },
                "1": {
                  data: {
                    tag: "markdown",
                    property: { elements: [{ tag: "plain_text", property: { content: "30" } }] },
                  },
                },
              },
            ],
          },
        },
      ],
    });
    expect(result).toContain("| Name | Age |");
    expect(result).toContain("| Alice | 30 |");
  });

  it("parses card_header with object title", () => {
    expect(
      parseFeishuCardToMarkdownString({
        elements: [{ tag: "card_header", title: { tag: "plain_text", content: "Card Title" } }],
      }),
    ).toBe("# Card Title");
  });

  it("parses card_header with string title", () => {
    expect(
      parseFeishuCardToMarkdownString({
        elements: [{ tag: "card_header", title: "Simple Title" }],
      }),
    ).toBe("# Simple Title");
  });

  it("parses link with url", () => {
    expect(
      parseFeishuCardToMarkdownString({
        elements: [
          { tag: "link", property: { content: "Click me", url: { url: "https://example.com" } } },
        ],
      }),
    ).toBe("[Click me](https://example.com)");
  });

  it("parses button with actions", () => {
    const result = parseFeishuCardToMarkdownString({
      elements: [
        {
          tag: "button",
          property: {
            text: { content: "Go" },
            actions: [{ action: { url: "https://example.com" } }],
          },
        },
      ],
    });
    expect(result).toBe("[Go](https://example.com)");
  });

  it("parses button without actions (fallback to label)", () => {
    expect(
      parseFeishuCardToMarkdownString({
        elements: [{ tag: "button", property: { text: { content: "OK" } } }],
      }),
    ).toBe("OK");
  });

  it("parses hr and br", () => {
    const result = parseFeishuCardToMarkdownString({
      elements: [
        { tag: "plain_text", content: "above" },
        { tag: "hr" },
        { tag: "plain_text", content: "below" },
      ],
    });
    expect(result).toContain("---");
    expect(result).toContain("above");
    expect(result).toContain("below");
  });

  it("truncates deeply nested cards", () => {
    let card: Record<string, unknown> = { tag: "div", property: { content: "deep" } };
    for (let i = 0; i < 15; i++) {
      card = { tag: "div", property: { elements: [card] } };
    }
    const result = parseFeishuCardToMarkdownString({ elements: [card] });
    expect(result).toContain("[max recursion depth]");
  });

  it("parses top-level card with header and body", () => {
    const result = parseFeishuCardToMarkdownString({
      header: { tag: "card_header", title: { tag: "plain_text", content: "My Card" } },
      body: {
        tag: "body",
        property: {
          elements: [{ tag: "markdown", content: "body text" }],
        },
      },
    });
    expect(result).toContain("# My Card");
    expect(result).toContain("body text");
  });
});
