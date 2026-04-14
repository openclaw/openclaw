import { describe, expect, it, vi } from "vitest";
import { parseFaceTags } from "./text-parsing.js";

describe("parseFaceTags", () => {
  it("handles undefined input gracefully", () => {
    expect(parseFaceTags(undefined as unknown as string)).toBe("");
  });

  it("handles null input gracefully", () => {
    expect(parseFaceTags(null as unknown as string)).toBe("");
  });

  it("skips oversized base64 ext payloads before decoding", () => {
    const oversizedBase64 = "A".repeat(100_000);
    const tag = `<faceType=1,faceId="1",ext="${oversizedBase64}">`;
    const bufferFromSpy = vi.spyOn(Buffer, "from");

    try {
      expect(parseFaceTags(tag)).toBe("[Emoji: unknown emoji]");
      expect(bufferFromSpy).not.toHaveBeenCalledWith(oversizedBase64, "base64");
    } finally {
      bufferFromSpy.mockRestore();
    }
  });
});
