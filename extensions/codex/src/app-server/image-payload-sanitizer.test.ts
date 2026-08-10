// Codex tests cover image payload sanitizer plugin behavior.
import { describe, expect, it } from "vitest";
import {
  invalidInlineImageText,
  sanitizeCodexHistoryImagePayloads,
  sanitizeInlineImageDataUrl,
} from "./image-payload-sanitizer.js";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";

describe("Codex app-server image payload sanitizer", () => {
  it("drops malformed data URL image payloads", () => {
    expect(sanitizeInlineImageDataUrl("data:image/jpeg;base64,not base64!")).toBeUndefined();
  });

  it("canonicalizes valid data URL images with sniffed MIME type", () => {
    expect(sanitizeInlineImageDataUrl(`data:image/jpeg;base64,\n${PNG_1X1}`)).toBe(
      `data:image/png;base64,${PNG_1X1}`,
    );
  });

  it("formats the text replacement used for invalid images", () => {
    expect(invalidInlineImageText("codex user input")).toContain("invalid inline image data");
  });

  it("returns image-free history by identity", () => {
    const content = [{ type: "text", text: "hello" }];
    const message = { role: "user", content, metadata: { retained: true } };
    const history = [message];

    const sanitized = sanitizeCodexHistoryImagePayloads(history, "codex mirrored history");

    expect(sanitized).toBe(history);
    expect(sanitized[0]).toBe(message);
    expect(sanitized[0]?.content).toBe(content);
  });

  it("copies only ancestors of a repaired image", () => {
    const untouched = { role: "assistant", content: [{ type: "text", text: "kept" }] };
    const invalidImage = {
      role: "toolResult",
      content: [{ type: "input_image", image_url: "data:image/png;base64,not base64!" }],
    };
    const history = [untouched, invalidImage];

    const sanitized = sanitizeCodexHistoryImagePayloads(history, "codex mirrored history");

    expect(sanitized).not.toBe(history);
    expect(sanitized[0]).toBe(untouched);
    expect(sanitized[1]).not.toBe(invalidImage);
    expect(sanitized[1]?.content).toEqual([
      {
        type: "input_text",
        text: "[codex mirrored history] omitted image payload: invalid inline image data",
      },
    ]);
  });

  it("preserves canonical image records and unknown metadata by identity", () => {
    const nativeImage = {
      type: "image",
      mimeType: "image/png",
      data: PNG_1X1,
      detail: "original",
      metadata: { retained: true },
    };
    const camelImage = {
      type: "inputImage",
      imageUrl: `data:image/png;base64,${PNG_1X1}`,
      detail: "high",
    };
    const snakeImage = {
      type: "input_image",
      image_url: "https://example.test/image.png",
      detail: "low",
    };
    const history = [nativeImage, camelImage, snakeImage];

    const sanitized = sanitizeCodexHistoryImagePayloads(history, "codex mirrored history");

    expect(sanitized).toBe(history);
    expect(sanitized[0]).toBe(nativeImage);
    expect(sanitized[1]).toBe(camelImage);
    expect(sanitized[2]).toBe(snakeImage);
  });

  it("preserves unknown metadata when canonicalizing an image record", () => {
    const metadata = { retained: true };
    const image = {
      type: "image",
      mimeType: "image/jpeg",
      data: PNG_1X1,
      detail: "original",
      metadata,
    };

    const sanitized = sanitizeCodexHistoryImagePayloads(image, "codex mirrored history");

    expect(sanitized).not.toBe(image);
    expect(sanitized).toEqual({
      ...image,
      mimeType: "image/png",
    });
    expect(sanitized.metadata).toBe(metadata);
  });

  it("scrubs invalid image blocks from mirrored history values", () => {
    expect(
      sanitizeCodexHistoryImagePayloads(
        [
          {
            role: "toolResult",
            content: [{ type: "image", mimeType: "image/jpeg", data: "not base64!" }],
          },
        ],
        "codex mirrored history",
      ),
    ).toEqual([
      {
        role: "toolResult",
        content: [
          {
            type: "text",
            text: "[codex mirrored history] omitted image payload: invalid inline image data",
          },
        ],
      },
    ]);
  });
});
