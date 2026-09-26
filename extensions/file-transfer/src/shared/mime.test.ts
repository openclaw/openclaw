// File Transfer tests cover mime plugin behavior.
import { describe, expect, it } from "vitest";
import { IMAGE_MIME_INLINE_SET, mimeFromExtension } from "./mime.js";

describe("mimeFromExtension", () => {
  it("falls back to application/octet-stream for unknown extensions", () => {
    expect(mimeFromExtension("blob.xyz")).toBe("application/octet-stream");
    expect(mimeFromExtension("Makefile")).toBe("application/octet-stream");
  });
});

describe("MIME constants", () => {
  it("IMAGE_MIME_INLINE_SET is the inline-renderable image set", () => {
    expect(IMAGE_MIME_INLINE_SET.has("image/png")).toBe(true);
    expect(IMAGE_MIME_INLINE_SET.has("image/jpeg")).toBe(true);
    expect(IMAGE_MIME_INLINE_SET.has("image/webp")).toBe(true);
    expect(IMAGE_MIME_INLINE_SET.has("image/gif")).toBe(true);
    // heic/heif intentionally excluded
    expect(IMAGE_MIME_INLINE_SET.has("image/heic")).toBe(false);
    expect(IMAGE_MIME_INLINE_SET.has("image/heif")).toBe(false);
  });
});
