import { describe, expect, it } from "vitest";
import { extractUrl } from "./extract-url.js";

describe("extractUrl", () => {
  it("pulls the first http(s) URL out of free text", () => {
    expect(extractUrl("请看这条 https://www.msn.cn/zh-cn/news/ar-AA25E70U 谢谢")).toBe(
      "https://www.msn.cn/zh-cn/news/ar-AA25E70U",
    );
  });

  it("returns a bare URL unchanged", () => {
    expect(extractUrl("https://weibo.com/x/123")).toBe("https://weibo.com/x/123");
  });

  it("trims trailing CJK/ascii punctuation", () => {
    expect(extractUrl("链接：https://a.com/p。")).toBe("https://a.com/p");
    expect(extractUrl("see https://a.com/p, ok")).toBe("https://a.com/p");
  });

  it("returns empty string when there is no URL", () => {
    expect(extractUrl("这是一段纯文本内容，没有链接")).toBe("");
    expect(extractUrl("")).toBe("");
  });
});
