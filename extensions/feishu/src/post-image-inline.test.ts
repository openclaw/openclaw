// Feishu tests cover content_v2 image inline-replacement behavior.
import { describe, expect, it } from "vitest";
import { inlineReplacePostImages } from "./post-image-inline.js";

describe("inlineReplacePostImages", () => {
  it("replaces non-code-block image_key refs with local paths (AC-M1-H2)", () => {
    const text = "看图：\n\n![架构图](img_abc123)\n\n```md\n![fake](img_abc123)\n```";
    const out = inlineReplacePostImages(text, new Map([["img_abc123", "/tmp/feishu/img_abc123.png"]]));
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
