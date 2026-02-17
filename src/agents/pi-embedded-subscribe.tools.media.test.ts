import { describe, expect, it } from "vitest";
import { extractToolResultMediaPaths } from "./pi-embedded-subscribe.tools.js";

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
});
