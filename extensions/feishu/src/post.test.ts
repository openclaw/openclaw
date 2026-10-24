import { describe, expect, it } from "vitest";
import { parseFeishuMarkdown } from "./markdown.js";
import { parsePostContent } from "./post.js";

function post(content: unknown[][], title = "", extra: Record<string, unknown> = {}) {
  return JSON.stringify({ title, content, ...extra });
}
function file(file_key: string, file_name: string, is_folder = false) {
  return { file_key, file_name, is_folder };
}
function topLevelFile(key: string, fileName: string) {
  return { kind: "file", key, fileName, origin: "top-level" };
}
function localePost(content: unknown[][], extra: Record<string, unknown> = {}) {
  return JSON.stringify({ post: { zh_cn: { title: "", content, ...extra } } });
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
  it("renders title and styled text as markdown", () => {
    const content = post(
      [
        spaced([
          text("Bold", ["bold"]),
          text("Italic", ["italic"]),
          text("Underline", ["underline"]),
          text("Strike", ["lineThrough"]),
          { tag: "code", text: "Code" },
        ]),
      ],
      "Daily *Plan*",
    );

    expect(parsePostContent(content)).toStrictEqual(
      parsed("Daily \\*Plan\\*\n\n**Bold** *Italic* <u>Underline</u> ~~Strike~~ `Code`"),
    );
  });

  it("keeps boundary whitespace outside emphasis delimiters", () => {
    const result = parsePostContent(
      post([[text("Before"), text(" styled ", ["bold"]), text("after")]]),
    );

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

  it("renders styled links and mentions", () => {
    const content = post([
      spaced([
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
    ]);

    expect(parsePostContent(content)).toMatchObject({
      textContent:
        "~~***[Docs \\[v2\\]](https://example.com/guide(a))***~~ <u>@alice\\_bob</u> @ou\\_123 [https://example.com/no\\-text](https://example.com/no-text)",
      mentionedOpenIds: ["ou_123"],
    });
  });

  it("inserts image placeholders and collects image attachments", () => {
    const content = post([[text("Before "), image("img_1"), text(" after")], [image("img_2")]]);

    expect(parsePostContent(content)).toEqual(
      parsed("Before ![image] after\n![image]", [
        { kind: "image", key: "img_1" },
        { kind: "image", key: "img_2" },
      ]),
    );
    expect(
      parsePostContent(content, { renderMediaPlaceholders: false, emptyTextFallback: "" })
        .textContent,
    ).toBe("Before  after");
  });

  it("preserves interleaved rich-post attachment occurrences in their original order", () => {
    const content = post(
      [
        [
          media("file_first", "first.mov"),
          image("img_shared"),
          media("file_last", "last.mov"),
          image("img_shared"),
          media("invalid/key"),
        ],
      ],
      "Attachments",
    );

    expect(parsePostContent(content).attachments).toEqual([
      { kind: "file", key: "file_first", fileName: "first.mov" },
      { kind: "image", key: "img_shared" },
      { kind: "file", key: "file_last", fileName: "last.mov" },
      { kind: "image", key: "img_shared" },
    ]);
  });

  it("collects top-level files[] from captioned and multi-file posts", () => {
    const captioned = post([[text("这是账本")]], "", {
      content_v2: [[text("这是账本")]],
      files: [file("file_v3_caption", "amount.csv")],
    });

    expect(parsePostContent(captioned)).toEqual(
      parsed("这是账本", [topLevelFile("file_v3_caption", "amount.csv")]),
    );
    const multiFile = post([[]], "", {
      content_v2: [[]],
      files: [
        file("file_v3_zip_aug", "aug.zip"),
        file("file_v3_zip_sep", "sep.zip"),
        file("file_v3_folder", "ignored-folder", true),
        file("invalid/key", "bad.csv"),
      ],
    });
    expect(parsePostContent(multiFile).attachments).toEqual([
      topLevelFile("file_v3_zip_aug", "aug.zip"),
      topLevelFile("file_v3_zip_sep", "sep.zip"),
    ]);
    const localized = localePost([[text("附件")]], {
      files: [file("file_v3_locale", "locale.csv")],
    });
    expect(parsePostContent(localized).attachments).toEqual([
      topLevelFile("file_v3_locale", "locale.csv"),
    ]);
    expect(
      parsePostContent(post([[]], "", { files: [{ file_key: "file_pdf" }] })).attachments,
    ).toEqual([{ kind: "file", key: "file_pdf", origin: "top-level" }]);
  });

  it.each([true, false])("supports locale wrapper (nested post: %s)", (nested) => {
    const payload = { zh_cn: { title: "标题", content: [[text("内容")]] } };
    const content = JSON.stringify(nested ? { post: payload } : payload);
    expect(parsePostContent(content)).toEqual(parsed("标题\n\n内容"));
  });
});

it("preserves code-block content containing Markdown fences through rich-post parsing", () => {
  const code = "Before\n```markdown\n# literal heading\n```\nAfter";
  const result = parsePostContent(
    JSON.stringify({ content: [[{ tag: "code_block", language: "markdown", text: code }]] }),
  );
  expect(parseFeishuMarkdown(result.textContent)).toMatchObject({
    children: [{ type: "code", lang: "markdown", value: code }],
  });
});
