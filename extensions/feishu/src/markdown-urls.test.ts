// Feishu tests cover post markdown URL normalization behavior.
import { describe, expect, it } from "vitest";
import { preserveFeishuBareMarkdownUrls } from "./markdown-urls.js";

describe("preserveFeishuBareMarkdownUrls", () => {
  it("wraps bare http(s) URLs with underscores so Feishu keeps the full link target", () => {
    expect(
      preserveFeishuBareMarkdownUrls(
        "see https://example.com/path_with_under_score and http://x.test/a_b?c=d_e#f_g",
      ),
    ).toBe(
      [
        "see [https://example.com/path_with_under_score]",
        "(https://example.com/path_with_under_score) and ",
        "[http://x.test/a_b?c=d_e#f_g](http://x.test/a_b?c=d_e#f_g)",
      ].join(""),
    );
  });

  it("keeps markdown links, image links, angle autolinks, and code regions unchanged", () => {
    const markdown = [
      "[regular](https://example.com/already_linked_path)",
      "![image](https://example.com/image_name.png)",
      "<https://example.com/angle_link_path>",
      "`https://example.com/inline_code_path`",
      "```md",
      "https://example.com/fenced_code_path",
      "```",
    ].join("\n");

    expect(preserveFeishuBareMarkdownUrls(markdown)).toBe(markdown);
  });

  it("keeps nested-bracket markdown link destinations masked", () => {
    expect(
      preserveFeishuBareMarkdownUrls(
        "[docs [v2]](https://example.com/already_linked_path) and https://example.com/live_path",
      ),
    ).toBe(
      [
        "[docs [v2]](https://example.com/already_linked_path) and ",
        "[https://example.com/live_path](https://example.com/live_path)",
      ].join(""),
    );
  });

  it("keeps balanced URL parentheses but leaves trailing sentence punctuation outside", () => {
    expect(
      preserveFeishuBareMarkdownUrls("see https://example.com/releases/v1_(beta)_notes?file=a_b."),
    ).toBe(
      [
        "see [https://example.com/releases/v1_(beta)_notes?file=a_b]",
        "(https://example.com/releases/v1_(beta)_notes?file=a_b).",
      ].join(""),
    );
  });

  it("leaves bare URLs without underscores unchanged", () => {
    expect(preserveFeishuBareMarkdownUrls("see https://example.com/plain")).toBe(
      "see https://example.com/plain",
    );
  });
});
