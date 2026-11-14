import { describe, expect, it } from "vitest";
import { parseFeishuMarkdown } from "./markdown.js";
import { parsePostContent } from "./post.js";

function post(content: unknown[][], title = "", extra: Record<string, unknown> = {}) {
  return JSON.stringify({ title, content, ...extra });
}
const parseRow = (content: unknown[], title = "", extra: Record<string, unknown> = {}) =>
  parsePostContent(post([content], title, extra));
function file(file_key: string, file_name: string, is_folder = false) {
  return { file_key, file_name, is_folder };
}
function topLevelFile(key: string, fileName: string) {
  return { kind: "file", key, fileName, origin: "top-level" };
}
function text(value: string, style?: string[]) {
  return { tag: "text", text: value, ...(style ? { style } : {}) };
}
function image(image_key: string) {
  return { tag: "img", image_key };
}
function media(file_key: string, file_name?: string) {
  return { tag: "media", file_key, file_name };
}
function spaced(elements: unknown[]) {
  return elements.flatMap((element, index) => (index ? [text(" "), element] : [element]));
}
function parsed(textContent: string, attachments: unknown[] = [], mentionedOpenIds: string[] = []) {
  return { textContent, attachments, mentionedOpenIds };
}

describe("parsePostContent", () => {
  it("renders titles, styled text, links and mentions as escaped Markdown", () => {
    expect(
      parseRow(
        spaced([
          text("Bold", ["bold"]),
          text("Italic", ["italic"]),
          text("Underline", ["underline"]),
          text("Strike", ["lineThrough"]),
          { tag: "code", text: "Code" },
          {
            tag: "a",
            text: "Docs [v2]",
            href: "https://example.com/guide(a)",
            style: ["lineThrough", "bold", "italic"],
          },
          { tag: "at", user_name: "alice_bob", style: ["underline"] },
          { tag: "at", open_id: "ou_123" },
          { tag: "a", href: "https://example.com/no-text" },
        ]),
        "Daily *Plan*",
      ),
    ).toStrictEqual(
      parsed(
        "Daily \\*Plan\\*\n\n**Bold** *Italic* <u>Underline</u> ~~Strike~~ `Code` ~~***[Docs \\[v2\\]](https://example.com/guide(a))***~~ <u>@alice\\_bob</u> @ou\\_123 [https://example.com/no\\-text](https://example.com/no-text)",
        [],
        ["ou_123"],
      ),
    );
  });

  it("keeps boundary whitespace outside emphasis delimiters", () => {
    const result = parseRow([text("Before"), text(" styled ", ["bold"]), text("after")]);
    expect(parseFeishuMarkdown(result.textContent)).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", value: "Before " },
            { type: "strong", children: [{ type: "text", value: "styled" }] },
            { type: "text", value: " after" },
          ],
        },
      ],
    });
  });

  it("renders optional placeholders and preserves mixed attachment order and duplicates", () => {
    const content = post([
      [
        text("Before "),
        media("file_first", "first.mov"),
        image("img_shared"),
        media("file_last", "last.mov"),
        image("img_shared"),
        media("invalid/key"),
        text(" after"),
      ],
      [image("img_2")],
    ]);
    expect(parsePostContent(content)).toEqual(
      parsed("Before [media]![image][media]![image][media] after\n![image]", [
        { kind: "file", key: "file_first", fileName: "first.mov" },
        { kind: "image", key: "img_shared" },
        { kind: "file", key: "file_last", fileName: "last.mov" },
        { kind: "image", key: "img_shared" },
        { kind: "image", key: "img_2" },
      ]),
    );
    expect(
      parsePostContent(content, { renderMediaPlaceholders: false, emptyTextFallback: "" })
        .textContent,
    ).toBe("Before  after");
  });

  it.each([true, false])("supports locale wrapper (nested post: %s)", (nested) => {
    const payload = {
      zh_cn: {
        title: "标题",
        content: [[text("内容")]],
        files: [
          file("file_valid", "amount.csv"),
          file("folder", "ignored", true),
          file("invalid/key", "bad.csv"),
        ],
      },
    };
    const content = JSON.stringify(nested ? { post: payload } : payload);
    expect(parsePostContent(content)).toEqual(
      parsed("标题\n\n内容", [topLevelFile("file_valid", "amount.csv")]),
    );
  });
});

it("preserves code-block content containing Markdown fences through rich-post parsing", () => {
  const code = "Before\n```markdown\n# literal heading\n```\nAfter";
  const result = parseRow([{ tag: "code_block", language: "markdown", text: code }]);
  expect(parseFeishuMarkdown(result.textContent)).toMatchObject({
    children: [{ type: "code", lang: "markdown", value: code }],
  });
});
