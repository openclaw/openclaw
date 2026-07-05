import { describe, expect, it } from "vitest";
import {
  describeToolResultMediaPlaceholder,
  extractToolResultBlockText,
  extractToolResultText,
} from "./tool-result-text.js";

// Helper: 创建 base64 编码的假图片数据
function fakeImageBase64() {
  return Buffer.from("fake-image-data-for-testing").toString("base64");
}

describe("extractToolResultText", () => {
  it("keeps media-only blocks out of provider replay text", () => {
    const text = extractToolResultText([
      { type: "text", text: "summary" },
      { type: "image", data: "image-binary", mimeType: "image/png" },
      { type: "image_url", image_url: { url: "data:image/png;base64,abc123" } },
      { type: "input_image", image_url: "data:image/png;base64,def456" },
      { type: "audio", data: "audio-binary", mimeType: "audio/mpeg" },
    ]);

    expect(text).toBe("summary");
    expect(text).not.toContain("image-binary");
    expect(text).not.toContain("abc123");
    expect(text).not.toContain("def456");
    expect(text).not.toContain("audio-binary");
  });

  it("omits MIME-tagged binary data while preserving textual resource data", () => {
    const text = extractToolResultText([
      { type: "resource", mime_type: "application/octet-stream", data: "AAECAwQFBgc=" },
      { type: "resource", mediaType: "application/json", data: '{"ok":true}' },
    ]);

    expect(text).toContain('"data":"[binary data omitted: 12 chars]"');
    expect(text).toContain('{\\"ok\\":true}');
    expect(text).not.toContain("AAECAwQFBgc=");
  });

  it("redacts inline data URIs without touching ordinary data-colon prose", () => {
    const text = extractToolResultText([
      {
        type: "json",
        value: {
          note: "metadata:ready",
          prose: "data: is ordinary prose",
          preview: "thumbnail=data:image/png;base64,abcdef done",
        },
      },
    ]);

    expect(text).toContain("metadata:ready");
    expect(text).toContain("data: is ordinary prose");
    expect(text).toContain("[inline data URI:");
    expect(text).not.toContain("abcdef");
  });

  it("omits opaque or binary structured fields", () => {
    const text = extractToolResultText([
      {
        type: "json",
        encrypted_content: "ciphertext",
        bytes: [1, 2, 3],
        visible: "safe-value",
      },
    ]);

    expect(text).toContain('"encrypted_content":"[omitted encrypted_content]"');
    expect(text).toContain('"bytes":"[omitted bytes]"');
    expect(text).toContain('"visible":"safe-value"');
    expect(text).not.toContain("ciphertext");
  });

  it("uses structured replay only as a no-text fallback without capping explicit text", () => {
    const textTail = "explicit-tail-marker";
    const text = extractToolResultText([
      { type: "text", text: `${"x".repeat(8_200)}${textTail}` },
      { type: "json", internal: "extra structured detail" },
    ]);

    expect(text).toContain(textTail);
    expect(text).not.toContain("…(truncated)…");
    expect(text).not.toContain("extra structured detail");
  });

  it("truncates structured fallback text before provider replay", () => {
    const tail = "tail-marker";
    const text = extractToolResultText([
      {
        type: "json",
        data: {
          payload: `${"x".repeat(8_200)}${tail}`,
        },
      },
    ]);

    expect(text.length).toBeLessThan(8_100);
    expect(text).toContain("…(truncated)…");
    expect(text).not.toContain(tail);
  });
});

describe("describeToolResultMediaPlaceholder", () => {
  it("describes image-only tool result media", () => {
    expect(
      describeToolResultMediaPlaceholder([{ type: "image", mimeType: "image/png", data: "img" }]),
    ).toBe("(see attached image)");
  });

  it("describes audio-only tool result media", () => {
    expect(
      describeToolResultMediaPlaceholder([
        { type: "audio", mimeType: "audio/mpeg", data: "audio" },
      ]),
    ).toBe("(see attached audio)");
  });

  it("describes mixed image and audio tool result media", () => {
    expect(
      describeToolResultMediaPlaceholder([
        { type: "image", mimeType: "image/png", data: "img" },
        { type: "audio", mimeType: "audio/mpeg", data: "audio" },
      ]),
    ).toBe("(see attached media)");
  });

  it("detects image from mimeType alone (no type field)", () => {
    expect(describeToolResultMediaPlaceholder([{ mimeType: "image/png", data: "img" }])).toBe(
      "(see attached image)",
    );
  });

  it("detects image from type=input_image", () => {
    expect(
      describeToolResultMediaPlaceholder([
        { type: "input_image", image_url: "https://example.com/img.png" },
      ]),
    ).toBe("(see attached image)");
  });

  it("returns undefined when no media blocks present", () => {
    expect(
      describeToolResultMediaPlaceholder([
        { type: "text", text: "hello" },
        { type: "json", data: { key: "value" } },
      ]),
    ).toBeUndefined();
  });
});

describe("Issue #99881 regression — image leaking into tool results on non-multimodal models", () => {
  const FAKE_IMG = fakeImageBase64();

  it("工具结果混入图片块: extractToolResultText 跳过图片块但保留文本块", () => {
    // 模拟场景: 用户上传图片后，工具结果中混入了图片块
    const contaminatedContent = [
      { type: "text", text: "exec output: file created successfully" },
      { type: "image", mimeType: "image/png", data: FAKE_IMG },
    ];

    const text = extractToolResultText(contaminatedContent);
    const media = describeToolResultMediaPlaceholder(contaminatedContent);

    console.log("[#99881 复现 - 混入图片]");
    console.log(`  extractToolResultText: "${text}"`);
    console.log(`  describeToolResultMediaPlaceholder: "${media}"`);

    // 文本被提取 (图片块被跳过)
    expect(text).toBe("exec output: file created successfully");
    // 但因为存在图片块，mediaPlaceholder 返回 "(see attached image)"
    expect(media).toBe("(see attached image)");
  });

  it("工具结果只有图片块 (无文本): 回退到 (see attached image)", () => {
    // 模拟场景: 工具结果完全被图片块替代 (极端情况)
    const imageOnlyContent = [{ type: "image", mimeType: "image/png", data: FAKE_IMG }];

    const text = extractToolResultText(imageOnlyContent);
    const media = describeToolResultMediaPlaceholder(imageOnlyContent);

    console.log("[#99881 复现 - 纯图片]");
    console.log(`  extractToolResultText: "${text}"`);
    console.log(`  describeToolResultMediaPlaceholder: "${media}"`);

    // 没有文本块，extractToolResultText 返回 ""
    expect(text).toBe("");
    // mediaPlaceholder 返回 "(see attached image)"
    expect(media).toBe("(see attached image)");
  });

  it("extractToolResultBlockText 正确处理 image 类型块", () => {
    // 验证 image 类型的块不会被提取为文本
    const imageBlock = { type: "image", mimeType: "image/png", data: FAKE_IMG };
    const textBlock = { type: "text", text: "real output" };

    expect(extractToolResultBlockText(imageBlock)).toBeUndefined();
    expect(extractToolResultBlockText(textBlock)).toBe("real output");
  });

  it("describeToolResultMediaPlaceholder 通过 mimeType 前缀匹配检测图片", () => {
    // 验证: 即使没有 type 字段，只要 mimeType 以 "image/" 开头就检测为图片
    const blocks = [
      { type: "text", text: "exec output here" },
      { mimeType: "image/png", data: "base64data" }, // 无 type 字段的图片
    ];

    const media = describeToolResultMediaPlaceholder(blocks);
    console.log(`[#99881 复现 - mimeType 检测] describeToolResultMediaPlaceholder: "${media}"`);
    expect(media).toBe("(see attached image)");
  });

  it("关键场景: 当工具结果既有文本又有图片时，用户看到的是哪个?", () => {
    // 这模拟了真实场景: 用户上传图片后，执行的工具(如 exec)返回正常文本，
    // 但图片块泄漏到了工具结果中
    const mixedContent = [
      { type: "text", text: "Command executed successfully.\nOutput:\nfile1.txt\nfile2.txt" },
      { type: "image", mimeType: "image/png", data: FAKE_IMG },
    ];

    const textResult = extractToolResultText(mixedContent);
    const mediaPlaceholder = describeToolResultMediaPlaceholder(mixedContent);

    console.log("[#99881 复现 - 最终判断]");
    console.log(`  文本提取结果: "${textResult}"`);
    console.log(`  媒体占位符: "${mediaPlaceholder}"`);

    // 关键: 在 openai-completions.ts 中，sanitizeToolResultText 使用:
    //   sanitizeToolResultText(textResult, mediaPlaceholder ?? EMPTY_TOOL_RESULT_TEXT)
    // 如果 textResult 非空，使用 textResult；否则使用 mediaPlaceholder
    //
    // 这里 textResult 非空，所以会使用 "Command executed successfully..."
    // 但如果 textResult 为空 (纯图片工具结果)，则会回退到 "(see attached image)"
    //
    // 问题: 图片是从哪泄漏到工具结果中的?
    // 可能的根因: 用户上传的图片在消息历史中，被误合并到工具结果内容中
    expect(textResult).toBeTruthy();
    expect(mediaPlaceholder).toBe("(see attached image)");
  });
});
