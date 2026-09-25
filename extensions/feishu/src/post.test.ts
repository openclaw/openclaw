// Feishu tests cover post plugin behavior.
import { describe, expect, it } from "vitest";
import { parseFeishuMarkdown } from "./markdown.js";
import { parsePostContent } from "./post.js";

describe("parsePostContent", () => {
  it.each([false, true])(
    "collects post files while preserving the caption: wrapped=%s",
    (wrapped) => {
      const payload = {
        title: "Report",
        content: [[{ tag: "text", text: "Please compare these files" }]],
        files: [
          { file_key: "file_report", file_name: "report.csv", is_folder: false },
          { file_key: "file_notes", file_name: "notes.txt", is_folder: false },
          { file_key: "file_report", file_name: "duplicate.csv" },
          { file_key: "file_folder", is_folder: true },
          { file_key: "invalid/key" },
          { file_key: 123 },
          null,
        ],
      };
      const result = parsePostContent(
        JSON.stringify(wrapped ? { post: { en_us: payload } } : payload),
      );
      expect(result.textContent).toBe("Report\n\nPlease compare these files");
      expect(result.attachments).toEqual([
        { kind: "file", key: "file_report", fileName: "report.csv", mediaKind: "document" },
        { kind: "file", key: "file_notes", fileName: "notes.txt", mediaKind: "document" },
      ]);
    },
  );

  it("collects a files-only post without inventing text or losing unnamed documents", () => {
    const result = parsePostContent(
      JSON.stringify({ content: [[]], files: [{ file_key: "file_unnamed" }] }),
      { renderMediaPlaceholders: false, emptyTextFallback: "" },
    );
    expect(result.textContent).toBe("");
    expect(result.attachments).toEqual([
      { kind: "file", key: "file_unnamed", mediaKind: "document" },
    ]);
  });

  it("appends envelope files without changing inline attachment occurrences", () => {
    const result = parsePostContent(
      JSON.stringify({
        post: {
          en_us: {
            content: [
              [
                { tag: "media", file_key: "file_clip", file_name: "clip.mp4" },
                { tag: "img", image_key: "img_inline" },
                { tag: "img", image_key: "img_inline" },
              ],
            ],
            files: [{ file_key: "file_report", file_name: "report.csv" }],
          },
        },
        files: [
          { file_key: "file_clip", file_name: "clip.mp4" },
          { file_key: "file_report", file_name: "report.csv" },
          { file_key: "file_other", file_name: "other.txt" },
        ],
      }),
    );
    expect(result.attachments).toEqual([
      { kind: "file", key: "file_clip", fileName: "clip.mp4" },
      { kind: "image", key: "img_inline" },
      { kind: "image", key: "img_inline" },
      { kind: "file", key: "file_report", fileName: "report.csv", mediaKind: "document" },
      { kind: "file", key: "file_other", fileName: "other.txt", mediaKind: "document" },
    ]);
  });

  it("renders title and styled text as markdown", () => {
    const content = JSON.stringify({
      title: "Daily *Plan*",
      content: [
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
    });

    const result = parsePostContent(content);

    expect(result.textContent).toBe(
      "Daily \\*Plan\\*\n\n**Bold** *Italic* <u>Underline</u> ~~Strike~~ `Code`",
    );
    expect(result.attachments).toStrictEqual([]);
    expect(result.mentionedOpenIds).toStrictEqual([]);
  });

  it.each([
    { style: ["bold"], expected: "**x \\* y** **[Docs](https://example.com)** **@Alice**" },
    { style: ["italic"], expected: "*x \\* y* *[Docs](https://example.com)* *@Alice*" },
    {
      style: ["underline"],
      expected: "<u>x \\* y</u> <u>[Docs](https://example.com)</u> <u>@Alice</u>",
    },
    { style: ["lineThrough"], expected: "~~x \\* y~~ ~~[Docs](https://example.com)~~ ~~@Alice~~" },
    {
      style: ["lineThrough", "bold", "italic"],
      expected: "~~***x \\* y***~~ ~~***[Docs](https://example.com)***~~ ~~***@Alice***~~",
    },
    { style: [], expected: "x \\* y [Docs](https://example.com) @Alice" },
  ])("preserves native inline styles $style", ({ style, expected }) => {
    const result = parsePostContent(
      JSON.stringify({
        content: [
          [
            { tag: "text", text: "x * y", style },
            { tag: "text", text: " " },
            { tag: "a", text: "Docs", href: "https://example.com", style },
            { tag: "text", text: " " },
            { tag: "at", user_name: "Alice", user_id: "ou_alice", style },
          ],
        ],
      }),
    );

    expect(result.textContent).toBe(expected);
    expect(result.mentionedOpenIds).toEqual(["ou_alice"]);
    expect(result.attachments).toEqual([]);
  });

  it.each([
    { style: "bold", nodeType: "strong" },
    { style: "italic", nodeType: "emphasis" },
  ])("keeps boundary whitespace outside $style delimiters", ({ style, nodeType }) => {
    const result = parsePostContent(
      JSON.stringify({
        content: [
          [
            { tag: "text", text: "Before" },
            { tag: "text", text: " styled ", style: [style] },
            { tag: "text", text: "after" },
          ],
        ],
      }),
    );

    expect(parseFeishuMarkdown(result.textContent)).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", value: "Before " },
            { type: nodeType, children: [{ type: "text", value: "styled" }] },
            { type: "text", value: " after" },
          ],
        },
      ],
    });
  });

  it("renders links and mentions", () => {
    const content = JSON.stringify({
      title: "",
      content: [
        [
          { tag: "a", text: "Docs [v2]", href: "https://example.com/guide(a)" },
          { tag: "text", text: " " },
          { tag: "at", user_name: "alice_bob" },
          { tag: "text", text: " " },
          { tag: "at", open_id: "ou_123" },
          { tag: "text", text: " " },
          { tag: "a", href: "https://example.com/no-text" },
        ],
      ],
    });

    const result = parsePostContent(content);

    expect(result.textContent).toBe(
      "[Docs \\[v2\\]](https://example.com/guide(a)) @alice\\_bob @ou\\_123 [https://example.com/no\\-text](https://example.com/no-text)",
    );
    expect(result.mentionedOpenIds).toEqual(["ou_123"]);
  });

  it("inserts image placeholders and collects image attachments", () => {
    const content = JSON.stringify({
      title: "",
      content: [
        [
          { tag: "text", text: "Before " },
          { tag: "img", image_key: "img_1" },
          { tag: "text", text: " after" },
        ],
        [{ tag: "img", image_key: "img_2" }],
      ],
    });

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
    const content = JSON.stringify({
      title: "Attachments",
      content: [
        [
          { tag: "media", file_key: "file_first", file_name: "first.mov" },
          { tag: "img", image_key: "img_shared" },
          { tag: "media", file_key: "file_last", file_name: "last.mov" },
          { tag: "img", image_key: "img_shared" },
          { tag: "media", file_key: "invalid/key" },
        ],
      ],
    });

    expect(parsePostContent(content).attachments).toEqual([
      { kind: "file", key: "file_first", fileName: "first.mov" },
      { kind: "image", key: "img_shared" },
      { kind: "file", key: "file_last", fileName: "last.mov" },
      { kind: "image", key: "img_shared" },
    ]);
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
