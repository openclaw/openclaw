import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  extractToolResultMediaPaths,
  extractToolResultMediaPathsAsync,
} from "./pi-embedded-subscribe.tools.js";

describe("extractToolResultMediaPaths", () => {
  it("returns empty array for null/undefined", () => {
    expect(extractToolResultMediaPaths(null)).toEqual([]);
    expect(extractToolResultMediaPaths(undefined)).toEqual([]);
  });

  it("returns empty array for non-object", () => {
    expect(extractToolResultMediaPaths("hello")).toEqual([]);
    expect(extractToolResultMediaPaths(42)).toEqual([]);
  });

  it("returns empty array when content is missing", () => {
    expect(extractToolResultMediaPaths({ details: { path: "/tmp/img.png" } })).toEqual([]);
  });

  it("returns empty array when content has no text or image blocks", () => {
    expect(extractToolResultMediaPaths({ content: [{ type: "other" }] })).toEqual([]);
  });

  it("extracts MEDIA: path from text content block", () => {
    const result = {
      content: [
        { type: "text", text: "MEDIA:/tmp/screenshot.png" },
        { type: "image", data: "base64data", mimeType: "image/png" },
      ],
      details: { path: "/tmp/screenshot.png" },
    };
    expect(extractToolResultMediaPaths(result)).toEqual(["/tmp/screenshot.png"]);
  });

  it("extracts MEDIA: path with extra text in the block", () => {
    const result = {
      content: [{ type: "text", text: "Here is the image\nMEDIA:/tmp/output.jpg\nDone" }],
    };
    expect(extractToolResultMediaPaths(result)).toEqual(["/tmp/output.jpg"]);
  });

  it("extracts multiple MEDIA: paths from different text blocks", () => {
    const result = {
      content: [
        { type: "text", text: "MEDIA:/tmp/page1.png" },
        { type: "text", text: "MEDIA:/tmp/page2.png" },
      ],
    };
    expect(extractToolResultMediaPaths(result)).toEqual(["/tmp/page1.png", "/tmp/page2.png"]);
  });

  it("falls back to details.path when image content exists but no MEDIA: text", () => {
    // Pi SDK read tool doesn't include MEDIA: but OpenClaw imageResult
    // sets details.path as fallback.
    const result = {
      content: [
        { type: "text", text: "Read image file [image/png]" },
        { type: "image", data: "base64data", mimeType: "image/png" },
      ],
      details: { path: "/tmp/generated.png" },
    };
    expect(extractToolResultMediaPaths(result)).toEqual(["/tmp/generated.png"]);
  });

  it("returns empty array when image content exists but no MEDIA: and no details.path", () => {
    // Pi SDK read tool: has image content but no path anywhere in the result.
    const result = {
      content: [
        { type: "text", text: "Read image file [image/png]" },
        { type: "image", data: "base64data", mimeType: "image/png" },
      ],
    };
    expect(extractToolResultMediaPaths(result)).toEqual([]);
  });

  it("does not fall back to details.path when MEDIA: paths are found", () => {
    const result = {
      content: [
        { type: "text", text: "MEDIA:/tmp/from-text.png" },
        { type: "image", data: "base64data", mimeType: "image/png" },
      ],
      details: { path: "/tmp/from-details.png" },
    };
    // MEDIA: text takes priority; details.path is NOT also included.
    expect(extractToolResultMediaPaths(result)).toEqual(["/tmp/from-text.png"]);
  });

  it("handles backtick-wrapped MEDIA: paths", () => {
    const result = {
      content: [{ type: "text", text: "MEDIA: `/tmp/screenshot.png`" }],
    };
    expect(extractToolResultMediaPaths(result)).toEqual(["/tmp/screenshot.png"]);
  });

  it("ignores null/undefined items in content array", () => {
    const result = {
      content: [null, undefined, { type: "text", text: "MEDIA:/tmp/ok.png" }],
    };
    expect(extractToolResultMediaPaths(result)).toEqual(["/tmp/ok.png"]);
  });

  it("returns empty array for text-only results without MEDIA:", () => {
    const result = {
      content: [{ type: "text", text: "Command executed successfully" }],
    };
    expect(extractToolResultMediaPaths(result)).toEqual([]);
  });

  it("ignores details.path when no image content exists", () => {
    // details.path without image content is not media.
    const result = {
      content: [{ type: "text", text: "File saved" }],
      details: { path: "/tmp/data.json" },
    };
    expect(extractToolResultMediaPaths(result)).toEqual([]);
  });

  it("handles details.path with whitespace", () => {
    const result = {
      content: [{ type: "image", data: "base64", mimeType: "image/png" }],
      details: { path: "  /tmp/image.png  " },
    };
    expect(extractToolResultMediaPaths(result)).toEqual(["/tmp/image.png"]);
  });

  it("skips empty details.path", () => {
    const result = {
      content: [{ type: "image", data: "base64", mimeType: "image/png" }],
      details: { path: "   " },
    };
    expect(extractToolResultMediaPaths(result)).toEqual([]);
  });

  it("does not match <media:audio> placeholder as a MEDIA: token", () => {
    const result = {
      content: [
        {
          type: "text",
          text: "<media:audio> placeholder with successful preflight voice transcript",
        },
      ],
    };
    expect(extractToolResultMediaPaths(result)).toEqual([]);
  });

  it("does not match <media:image> placeholder as a MEDIA: token", () => {
    const result = {
      content: [{ type: "text", text: "<media:image> (2 images)" }],
    };
    expect(extractToolResultMediaPaths(result)).toEqual([]);
  });

  it("does not match other media placeholder variants", () => {
    for (const tag of [
      "<media:video>",
      "<media:document>",
      "<media:sticker>",
      "<media:attachment>",
    ]) {
      const result = {
        content: [{ type: "text", text: `${tag} some context` }],
      };
      expect(extractToolResultMediaPaths(result)).toEqual([]);
    }
  });

  it("does not match mid-line MEDIA: in documentation text", () => {
    const result = {
      content: [
        {
          type: "text",
          text: 'Use MEDIA: "https://example.com/voice.ogg", asVoice: true to send voice',
        },
      ],
    };
    expect(extractToolResultMediaPaths(result)).toEqual([]);
  });

  it("does not treat malformed MEDIA:-prefixed prose as a file path", () => {
    const result = {
      content: [
        {
          type: "text",
          text: "MEDIA:-prefixed paths (lenient whitespace) when loading outbound media",
        },
      ],
    };
    expect(extractToolResultMediaPaths(result)).toEqual([]);
  });

  it("still extracts MEDIA: at line start after other text lines", () => {
    const result = {
      content: [
        {
          type: "text",
          text: "Generated screenshot\nMEDIA:/tmp/screenshot.png\nDone",
        },
      ],
    };
    expect(extractToolResultMediaPaths(result)).toEqual(["/tmp/screenshot.png"]);
  });

  it("extracts indented MEDIA: line", () => {
    const result = {
      content: [{ type: "text", text: "  MEDIA:/tmp/indented.png" }],
    };
    expect(extractToolResultMediaPaths(result)).toEqual(["/tmp/indented.png"]);
  });

  it("extracts valid MEDIA: line while ignoring <media:audio> on another line", () => {
    const result = {
      content: [
        {
          type: "text",
          text: "<media:audio> was transcribed\nMEDIA:/tmp/tts-output.opus\nDone",
        },
      ],
    };
    expect(extractToolResultMediaPaths(result)).toEqual(["/tmp/tts-output.opus"]);
  });

  it("extracts multiple MEDIA: lines from a single text block", () => {
    const result = {
      content: [
        {
          type: "text",
          text: "MEDIA:/tmp/page1.png\nSome text\nMEDIA:/tmp/page2.png",
        },
      ],
    };
    expect(extractToolResultMediaPaths(result)).toEqual(["/tmp/page1.png", "/tmp/page2.png"]);
  });
});

describe("extractToolResultMediaPathsAsync", () => {
  // A tiny 1x1 PNG (base64 encoded)
  const TINY_PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

  it("saves base64 image to temp file when no MEDIA: or details.path", async () => {
    const result = {
      content: [
        { type: "text", text: "Read image file [image/png]" },
        { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
      ],
    };
    const paths = await extractToolResultMediaPathsAsync(result);
    expect(paths.length).toBe(1);

    const filePath = paths[0];
    // Should be a PNG file
    expect(filePath).toMatch(/\.png$/);
    // File should exist
    expect(existsSync(filePath)).toBe(true);

    // Verify the content is correct
    const fileBuffer = await readFile(filePath);
    const fileBase64 = fileBuffer.toString("base64");
    expect(fileBase64).toBe(TINY_PNG_BASE64);

    // Cleanup
    await rm(filePath, { force: true });
  });

  it("handles multiple image blocks", async () => {
    const result = {
      content: [
        { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
        { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
      ],
    };
    const paths = await extractToolResultMediaPathsAsync(result);
    expect(paths.length).toBe(2);
    expect(paths[0]).toMatch(/\.png$/);
    expect(paths[1]).toMatch(/\.png$/);
    expect(paths[0]).not.toBe(paths[1]);

    // Cleanup
    for (const p of paths) {
      await rm(p, { force: true });
    }
  });

  it("extracts extension from mimeType", async () => {
    // Test JPEG
    const jpegResult = {
      content: [{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/jpeg" }],
    };
    const jpegPaths = await extractToolResultMediaPathsAsync(jpegResult);
    expect(jpegPaths[0]).toMatch(/\.jpg$/);

    // Test WebP
    const webpResult = {
      content: [{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/webp" }],
    };
    const webpPaths = await extractToolResultMediaPathsAsync(webpResult);
    expect(webpPaths[0]).toMatch(/\.webp$/);

    // Cleanup
    for (const p of [...jpegPaths, ...webpPaths]) {
      await rm(p, { force: true });
    }
  });

  it("returns paths from MEDIA: text when available", async () => {
    const result = {
      content: [
        { type: "text", text: "MEDIA:/tmp/existing.png" },
        { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
      ],
    };
    // When MEDIA: exists, it should use that path instead of creating temp file
    const paths = await extractToolResultMediaPathsAsync(result);
    expect(paths).toEqual(["/tmp/existing.png"]);
  });

  it("returns paths from details.path when available", async () => {
    const result = {
      content: [{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
      details: { path: "/tmp/from-details.png" },
    };
    // When details.path exists, it should use that path instead of creating temp file
    const paths = await extractToolResultMediaPathsAsync(result);
    expect(paths).toEqual(["/tmp/from-details.png"]);
  });

  it("returns empty array for results without images", async () => {
    const result = {
      content: [{ type: "text", text: "No images here" }],
    };
    const paths = await extractToolResultMediaPathsAsync(result);
    expect(paths).toEqual([]);
  });

  it("ignores image blocks without data", async () => {
    const result = {
      content: [{ type: "image", mimeType: "image/png" }],
    };
    const paths = await extractToolResultMediaPathsAsync(result);
    expect(paths).toEqual([]);
  });

  it("ignores image blocks without mimeType", async () => {
    const result = {
      content: [{ type: "image", data: TINY_PNG_BASE64 }],
    };
    const paths = await extractToolResultMediaPathsAsync(result);
    expect(paths).toEqual([]);
  });
});
