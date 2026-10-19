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

describe("parsePostContent", () => {
  it("renders title and styled text as markdown", () => {
    const content = post(
      [
        [
          { tag: "text", text: "Bold", style: ["bold"] },
          { tag: "text", text: " " },
          { tag: "text", text: "Italic", style: ["italic"] },
          { tag: "text", text: " " },
          { tag: "text", text: "Underline", style: ["underline"] },
          { tag: "text", text: " " },
          { tag: "text", text: "Strike", style: ["lineThrough"] },
          { tag: "text", text: " " },
          { tag: "code", text: "Code" },
        ],
      ],
      "Daily *Plan*",
    );

    const result = parsePostContent(content);

    expect(result.textContent).toBe(
      "Daily \\*Plan\\*\n\n**Bold** *Italic* <u>Underline</u> ~~Strike~~ `Code`",
    );
    expect(result.attachments).toStrictEqual([]);
    expect(result.mentionedOpenIds).toStrictEqual([]);
  });

  it("keeps boundary whitespace outside emphasis delimiters", () => {
    const result = parsePostContent(
      post([
        [
          { tag: "text", text: "Before" },
          { tag: "text", text: " styled ", style: ["bold"] },
          { tag: "text", text: "after" },
        ],
      ]),
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
      [
        {
          tag: "a",
          text: "Docs [v2]",
          href: "https://example.com/guide(a)",
          style: ["lineThrough", "bold", "italic"],
        },
        { tag: "text", text: " " },
        { tag: "at", user_name: "alice_bob", style: ["underline"] },
        { tag: "text", text: " " },
        { tag: "at", open_id: "ou_123" },
        { tag: "text", text: " " },
        { tag: "a", href: "https://example.com/no-text" },
      ],
    ]);

    const result = parsePostContent(content);

    expect(result.textContent).toBe(
      "~~***[Docs \\[v2\\]](https://example.com/guide(a))***~~ <u>@alice\\_bob</u> @ou\\_123 [https://example.com/no\\-text](https://example.com/no-text)",
    );
    expect(result.mentionedOpenIds).toEqual(["ou_123"]);
  });

  it("inserts image placeholders and collects image attachments", () => {
    const content = post([
      [
        { tag: "text", text: "Before " },
        { tag: "img", image_key: "img_1" },
        { tag: "text", text: " after" },
      ],
      [{ tag: "img", image_key: "img_2" }],
    ]);

    const result = parsePostContent(content);

    expect(result.textContent).toBe("Before ![image] after\n![image]");
    expect(result.attachments).toEqual([
      { kind: "image", key: "img_1" },
      { kind: "image", key: "img_2" },
    ]);
    expect(result.mentionedOpenIds).toStrictEqual([]);
    expect(
      parsePostContent(content, { renderMediaPlaceholders: false, emptyTextFallback: "" })
        .textContent,
    ).toBe("Before  after");
  });

  it("preserves interleaved rich-post attachment occurrences in their original order", () => {
    const content = post(
      [
        [
          { tag: "media", file_key: "file_first", file_name: "first.mov" },
          { tag: "img", image_key: "img_shared" },
          { tag: "media", file_key: "file_last", file_name: "last.mov" },
          { tag: "img", image_key: "img_shared" },
          { tag: "media", file_key: "invalid/key" },
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
    const captioned = post([[{ tag: "text", text: "这是账本" }]], "", {
      content_v2: [[{ tag: "text", text: "这是账本" }]],
      files: [
        file(
          "file_v3_0015l_1a389bce-aabb-ccdd-eeff-1234567890ab",
          "amount-2026-08-01_2026-08-31.csv",
        ),
      ],
    });

    expect(parsePostContent(captioned)).toEqual({
      textContent: "这是账本",
      attachments: [
        topLevelFile(
          "file_v3_0015l_1a389bce-aabb-ccdd-eeff-1234567890ab",
          "amount-2026-08-01_2026-08-31.csv",
        ),
      ],
      mentionedOpenIds: [],
    });

    const multiFile = post([[]], "", {
      content_v2: [[]],
      files: [
        file("file_v3_zip_aug", "usage_data_2026-08-01_2026-08-31.zip"),
        file("file_v3_zip_sep", "usage_data_2026-09-01_2026-09-18.zip"),
        file("file_v3_folder", "ignored-folder", true),
        file("invalid/key", "bad.csv"),
      ],
    });

    expect(parsePostContent(multiFile).attachments).toEqual([
      topLevelFile("file_v3_zip_aug", "usage_data_2026-08-01_2026-08-31.zip"),
      topLevelFile("file_v3_zip_sep", "usage_data_2026-09-01_2026-09-18.zip"),
    ]);

    expect(
      parsePostContent(
        JSON.stringify({
          post: {
            zh_cn: {
              title: "",
              content: [[{ tag: "text", text: "附件" }]],
              files: [file("file_v3_locale", "locale.csv")],
            },
          },
        }),
      ).attachments,
    ).toEqual([topLevelFile("file_v3_locale", "locale.csv")]);

    expect(
      parsePostContent(post([[]], "", { files: [{ file_key: "file_pdf" }] })).attachments,
    ).toEqual([{ kind: "file", key: "file_pdf", origin: "top-level" }]);
  });

  it("supports locale wrappers", () => {
    const wrappedByPost = JSON.stringify({
      post: {
        zh_cn: {
          title: "标题",
          content: [[{ tag: "text", text: "内容A" }]],
        },
      },
    });
    const wrappedByLocale = JSON.stringify({
      zh_cn: {
        title: "标题",
        content: [[{ tag: "text", text: "内容B" }]],
      },
    });

    expect(parsePostContent(wrappedByPost)).toEqual({
      textContent: "标题\n\n内容A",
      attachments: [],
      mentionedOpenIds: [],
    });
    expect(parsePostContent(wrappedByLocale)).toEqual({
      textContent: "标题\n\n内容B",
      attachments: [],
      mentionedOpenIds: [],
    });
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
