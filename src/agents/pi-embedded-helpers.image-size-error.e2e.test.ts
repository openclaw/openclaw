import { describe, expect, it } from "vitest";
import { parseImageSizeError } from "./pi-embedded-helpers.js";

describe("parseImageSizeError", () => {
  it("parses max MB values from error text", () => {
    expect(parseImageSizeError("image exceeds 5 MB maximum")?.maxMb).toBe(5);
    expect(parseImageSizeError("Image exceeds 5.5 MB limit")?.maxMb).toBe(5.5);
  });

  it("returns null for unrelated errors", () => {
    expect(parseImageSizeError("context overflow")).toBeNull();
  });

  it("extracts message and content indices from API error path", () => {
    const raw =
      "messages.189.content.1.image.source.base64: image exceeds 5 MB maximum: 5641712 bytes > 5242880 bytes";
    const parsed = parseImageSizeError(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.maxMb).toBe(5);
    expect(parsed?.messageIndex).toBe(189);
    expect(parsed?.contentIndex).toBe(1);
  });

  it("returns undefined indices when error has no path prefix", () => {
    const parsed = parseImageSizeError("image exceeds 5 MB maximum");
    expect(parsed).not.toBeNull();
    expect(parsed?.messageIndex).toBeUndefined();
    expect(parsed?.contentIndex).toBeUndefined();
  });
});
