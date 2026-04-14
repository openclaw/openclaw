import { describe, expect, it, vi } from "vitest";
import { parseFaceTags } from "./text-parsing.js";

describe("parseFaceTags", () => {
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

  it("returns empty string when input is undefined (null guard)", () => {
    // @ts-ignore — intentionally passing undefined at runtime to test boundary
    expect(parseFaceTags(undefined)).toBe("");
  });

  it("returns empty string when input is null", () => {
    // @ts-ignore — intentionally passing null at runtime to test boundary
    expect(parseFaceTags(null)).toBe("");
  });

  it("returns empty string when input is empty string", () => {
    expect(parseFaceTags("")).toBe("");
  });

  it("still parses normal face tags correctly", () => {
    const tag = `<faceType=1,faceId="1",ext="${Buffer.from(JSON.stringify({text:"Smile"})).toString("base64")}">`;
    expect(parseFaceTags(tag)).toBe("[Emoji: Smile]");
  });
});
