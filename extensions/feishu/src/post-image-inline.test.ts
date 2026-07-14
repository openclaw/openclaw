// Feishu tests cover content_v2 image inline-replacement behavior.
import { describe, expect, it } from "vitest";
import { extractMarkdownImageKeys, inlineReplacePostImages } from "./post-image-inline.js";

describe("inlineReplacePostImages", () => {
  it("rewrites only the URL when alt text contains the same (key) substring", () => {
    const text = "![see (img_abc) here](img_abc)";
    const out = inlineReplacePostImages(text, new Map([["img_abc", "/tmp/img_abc.png"]]));
    // alt text's literal "(img_abc)" stays; only the trailing URL is rewritten.
    expect(out).toBe("![see (img_abc) here](/tmp/img_abc.png)");
  });

  it("inserts the path literally even when it contains regex-replacement specials ($)", () => {
    const text = "![a](img_x)";
    const out = inlineReplacePostImages(text, new Map([["img_x", "/tmp/$1$&dir/a.png"]]));
    expect(out).toBe("![a](/tmp/$1$&dir/a.png)");
  });

  it("replaces non-code-block image_key refs with local paths (AC-M1-H2)", () => {
    const text = "看图：\n\n![架构图](img_abc123)\n\n```md\n![fake](img_abc123)\n```";
    const out = inlineReplacePostImages(
      text,
      new Map([["img_abc123", "/tmp/feishu/img_abc123.png"]]),
    );
    expect(out).toContain("![架构图](/tmp/feishu/img_abc123.png)");
    // 代码块内同 key 保留字面，不替换。
    expect(out).toContain("![fake](img_abc123)");
  });

  it("keeps original ref when key has no local path (download failed) (AC-M1-R1)", () => {
    const text = "![a](img_ok) ![b](img_fail)";
    const out = inlineReplacePostImages(text, new Map([["img_ok", "/tmp/ok.png"]]));
    expect(out).toBe("![a](/tmp/ok.png) ![b](img_fail)");
  });

  it("is a no-op when text has no image markdown (content fallback placeholder)", () => {
    const text = "本周进展：![image]\n详见文档";
    const out = inlineReplacePostImages(text, new Map());
    expect(out).toBe(text);
  });
});

describe("extractMarkdownImageKeys", () => {
  it("dedupes a key referenced multiple times (one image, one download)", () => {
    expect(extractMarkdownImageKeys("![a](img_1) and again ![b](img_1)")).toStrictEqual(["img_1"]);
  });

  it("skips code-block images but keeps real ones", () => {
    const text = "![real](img_real)\n\n```md\n![fake](img_code)\n```\n\n`![inline](img_inline)`";
    expect(extractMarkdownImageKeys(text)).toStrictEqual(["img_real"]);
  });

  it.each([
    ["tilde fence", "~~~md\n![fake](img_tilde)\n~~~"],
    ["longer backtick fence", "````md\n![fake](img_long)\n`````"],
    ["unterminated fence", "```md\n![fake](img_unterminated)"],
  ])("skips image refs inside %s", (_name, code) => {
    expect(extractMarkdownImageKeys(`${code}\n![real](img_real)`)).toStrictEqual(
      code.includes("unterminated") ? [] : ["img_real"],
    );
  });
});
