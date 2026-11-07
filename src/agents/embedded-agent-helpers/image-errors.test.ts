import { describe, expect, it } from "vitest";
import { isImageSizeError, parseImageDimensionError, parseImageSizeError } from "./image-errors.js";

describe("parseImageSizeError", () => {
  it("preserves optional max MB values for recognized errors", () => {
    expect(parseImageSizeError("image exceeds 5 MB maximum")?.maxMb).toBe(5);
    expect(parseImageSizeError("Image exceeds 5.5 MB limit")?.maxMb).toBe(5.5);
    expect(parseImageSizeError("IMAGE EXCEEDS\nUPSTREAM MB LIMIT")).toEqual({ maxMb: undefined });
  });

  it("ignores unrelated, absent and empty errors", () => {
    expect(parseImageSizeError("context overflow")).toBeNull();
    expect(isImageSizeError(undefined)).toBe(false);
    expect(isImageSizeError("")).toBe(false);
  });
});

describe("image dimension errors", () => {
  it("parses optional image dimension details and ignores unrelated errors", () => {
    const raw =
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.84.content.1.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels"}}';
    const parsed = parseImageDimensionError(raw);
    expect(parsed).toEqual({
      maxDimensionPx: 2000,
      messageIndex: 84,
      contentIndex: 1,
    });
    expect(parseImageDimensionError("IMAGE DIMENSIONS EXCEED MAX ALLOWED SIZE")).toEqual({
      maxDimensionPx: undefined,
      messageIndex: undefined,
      contentIndex: undefined,
    });
    expect(parseImageDimensionError("context overflow")).toBeNull();
  });
});
