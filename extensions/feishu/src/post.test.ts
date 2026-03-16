import { describe, expect, it } from "vitest";
import { parsePostContent } from "./post.js";

describe("parsePostContent", () => {
  it("renders title and styled text as markdown", () => {
    const content = JSON.stringify({
      title: "Daily *Plan*",
      content: [
        [
          { tag: "text", text: "Bold", style: { bold: true } },
          { tag: "text", text: " " },
          { tag: "text", text: "Italic", style: { italic: true } },
          { tag: "text", text: " " },
          { tag: "text", text: "Underline", style: { underline: true } },
          { tag: "text", text: " " },
          { tag: "text", text: "Strike", style: { strikethrough: true } },
          { tag: "text", text: " " },
          { tag: "text", text: "Code", style: { code: true, bold: true } },
        ],
      ],
    });

    const result = parsePostContent(content);

    expect(result.textContent).toBe(
      "Daily \\*Plan\\*\n\n**Bold** *Italic* <u>Underline</u> ~~Strike~~ `Code`",
    );
    expect(result.imageKeys).toEqual([]);
    expect(result.mentionedOpenIds).toEqual([]);
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

  it("inserts image placeholders and collects image keys", () => {
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
    expect(result.imageKeys).toEqual(["img_1", "img_2"]);
    expect(result.mentionedOpenIds).toEqual([]);
  });

  it("adds spaces around anchors and mentions to prevent UI text concatenation", () => {
    const content = JSON.stringify({
      title: "",
      content: [
        [
          { tag: "text", text: "打开文档[" },
          { tag: "a", href: "https://example.com", text: "项目A" },
          { tag: "text", text: "]并重新理解" },
        ],
      ],
    });

    const result = parsePostContent(content);

    // Should automatically insert spaces around the 'a' tag to prevent the CJK characters from sticking to it
    expect(result.textContent).toBe("打开文档\\[ [项目A](https://example.com) \\]并重新理解");
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
      imageKeys: [],
      mediaKeys: [],
      mentionedOpenIds: [],
    });
    expect(parsePostContent(wrappedByLocale)).toEqual({
      textContent: "标题\n\n内容B",
      imageKeys: [],
      mediaKeys: [],
      mentionedOpenIds: [],
    });
  });
});
