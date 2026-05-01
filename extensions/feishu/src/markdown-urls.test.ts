import { describe, expect, it } from "vitest";
import { wrapBareUrlsForFeishuMarkdown } from "./markdown-urls.js";

describe("wrapBareUrlsForFeishuMarkdown", () => {
  it("returns input untouched when no http(s) URL is present", () => {
    expect(wrapBareUrlsForFeishuMarkdown("hello world")).toBe("hello world");
    expect(wrapBareUrlsForFeishuMarkdown("")).toBe("");
  });

  it("wraps a bare URL containing underscores and ampersands", () => {
    const input = "请打开 https://example.com/v1/verify?flow_id=A_B_C&user_code=DEMO-1234 完成授权";
    const expected =
      "请打开 [https://example.com/v1/verify?flow_id=A_B_C&user_code=DEMO-1234](https://example.com/v1/verify?flow_id=A_B_C&user_code=DEMO-1234) 完成授权";
    expect(wrapBareUrlsForFeishuMarkdown(input)).toBe(expected);
  });

  it("stops at adjacent Chinese characters without absorbing them", () => {
    const input = "see https://example.com/a_b你好";
    const expected = "see [https://example.com/a_b](https://example.com/a_b)你好";
    expect(wrapBareUrlsForFeishuMarkdown(input)).toBe(expected);
  });

  it("leaves existing markdown links alone", () => {
    const input = "[docs](https://example.com/a_b_c) and bare https://example.com/x_y";
    const expected =
      "[docs](https://example.com/a_b_c) and bare [https://example.com/x_y](https://example.com/x_y)";
    expect(wrapBareUrlsForFeishuMarkdown(input)).toBe(expected);
  });

  it("leaves image syntax alone", () => {
    const input = "![logo](https://cdn.example.com/a_b.png) plus https://example.com/z_1";
    const expected =
      "![logo](https://cdn.example.com/a_b.png) plus [https://example.com/z_1](https://example.com/z_1)";
    expect(wrapBareUrlsForFeishuMarkdown(input)).toBe(expected);
  });

  it("leaves angle-bracket autolinks alone", () => {
    const input = "<https://example.com/a_b> vs https://example.com/c_d";
    const expected =
      "<https://example.com/a_b> vs [https://example.com/c_d](https://example.com/c_d)";
    expect(wrapBareUrlsForFeishuMarkdown(input)).toBe(expected);
  });

  it("does not touch URLs inside inline code", () => {
    const input = "run `curl https://example.com/a_b` then open https://example.com/c_d";
    const expected =
      "run `curl https://example.com/a_b` then open [https://example.com/c_d](https://example.com/c_d)";
    expect(wrapBareUrlsForFeishuMarkdown(input)).toBe(expected);
  });

  it("does not touch URLs inside fenced code blocks", () => {
    const input = [
      "prefix https://example.com/a_b",
      "```",
      "GET https://example.com/in_code",
      "```",
      "suffix https://example.com/c_d",
    ].join("\n");
    const expected = [
      "prefix [https://example.com/a_b](https://example.com/a_b)",
      "```",
      "GET https://example.com/in_code",
      "```",
      "suffix [https://example.com/c_d](https://example.com/c_d)",
    ].join("\n");
    expect(wrapBareUrlsForFeishuMarkdown(input)).toBe(expected);
  });

  it("trims a trailing sentence period out of the URL", () => {
    const input = "see https://example.com/a_b.";
    const expected = "see [https://example.com/a_b](https://example.com/a_b).";
    expect(wrapBareUrlsForFeishuMarkdown(input)).toBe(expected);
  });

  it("trims a trailing comma out of the URL", () => {
    const input = "visit https://example.com/a_b, then continue";
    const expected = "visit [https://example.com/a_b](https://example.com/a_b), then continue";
    expect(wrapBareUrlsForFeishuMarkdown(input)).toBe(expected);
  });

  it("does not absorb a closing paren that wraps the URL in prose", () => {
    const input = "(see https://example.com/a_b)";
    const expected = "(see [https://example.com/a_b](https://example.com/a_b))";
    expect(wrapBareUrlsForFeishuMarkdown(input)).toBe(expected);
  });

  it("keeps inner parens in display text and percent-encodes them in the destination", () => {
    const input = "wiki https://example.com/Foo_(bar)_baz end";
    const expected =
      "wiki [https://example.com/Foo_(bar)_baz](https://example.com/Foo_%28bar%29_baz) end";
    expect(wrapBareUrlsForFeishuMarkdown(input)).toBe(expected);
  });

  it("percent-encodes an unmatched mid-URL `)` so the destination is not truncated", () => {
    const input = "bug https://example.com/a)b_c here";
    const expected = "bug [https://example.com/a)b_c](https://example.com/a%29b_c) here";
    expect(wrapBareUrlsForFeishuMarkdown(input)).toBe(expected);
  });

  it("percent-encodes an unmatched mid-URL `(` in the destination", () => {
    const input = "case https://example.com/a(b_c end";
    const expected = "case [https://example.com/a(b_c](https://example.com/a%28b_c) end";
    expect(wrapBareUrlsForFeishuMarkdown(input)).toBe(expected);
  });

  it("wraps multiple URLs in the same line", () => {
    const input = "a https://example.com/a_1 b https://example.com/b_2 c";
    const expected =
      "a [https://example.com/a_1](https://example.com/a_1) b [https://example.com/b_2](https://example.com/b_2) c";
    expect(wrapBareUrlsForFeishuMarkdown(input)).toBe(expected);
  });

  it("wraps http URLs as well as https", () => {
    const input = "open http://example.com/a_b now";
    const expected = "open [http://example.com/a_b](http://example.com/a_b) now";
    expect(wrapBareUrlsForFeishuMarkdown(input)).toBe(expected);
  });

  it("is idempotent on already-wrapped output", () => {
    const input = "open https://example.com/a_b please";
    const once = wrapBareUrlsForFeishuMarkdown(input);
    const twice = wrapBareUrlsForFeishuMarkdown(once);
    expect(twice).toBe(once);
  });

  it("wraps URL at the start of the string", () => {
    const input = "https://example.com/a_b is ready";
    const expected = "[https://example.com/a_b](https://example.com/a_b) is ready";
    expect(wrapBareUrlsForFeishuMarkdown(input)).toBe(expected);
  });

  it("wraps URL at the end of the string with no trailing char", () => {
    const input = "open https://example.com/a_b";
    const expected = "open [https://example.com/a_b](https://example.com/a_b)";
    expect(wrapBareUrlsForFeishuMarkdown(input)).toBe(expected);
  });

  it("strips mask sentinels from input to block forged placeholders", () => {
    const forged = "prefix \u0001MDURL0\u0002 and https://example.com/a_b after";
    const expected = "prefix MDURL0 and [https://example.com/a_b](https://example.com/a_b) after";
    expect(wrapBareUrlsForFeishuMarkdown(forged)).toBe(expected);
  });
});
