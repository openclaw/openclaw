import { describe, expect, it } from "vitest";
import { parseLineStickerRaw } from "./sticker-utils.js";

describe("parseLineStickerRaw", () => {
  it("parses valid packageId:stickerId", () => {
    expect(parseLineStickerRaw("11537:52002734")).toEqual({
      packageId: "11537",
      stickerId: "52002734",
    });
  });

  it("parses minimal valid ids", () => {
    expect(parseLineStickerRaw("446:1988")).toEqual({
      packageId: "446",
      stickerId: "1988",
    });
  });

  it("returns undefined for single token", () => {
    expect(parseLineStickerRaw("CAACAgIAAxkBAAI")).toBeUndefined();
  });

  it("returns undefined for non-numeric packageId", () => {
    expect(parseLineStickerRaw("abc:123")).toBeUndefined();
  });

  it("returns undefined for plain alpha token", () => {
    expect(parseLineStickerRaw("abc")).toBeUndefined();
  });

  it("returns undefined for non-numeric stickerId", () => {
    expect(parseLineStickerRaw("123:abc")).toBeUndefined();
  });

  it("returns undefined for mixed numeric/non-numeric pair", () => {
    expect(parseLineStickerRaw("446:abc")).toBeUndefined();
  });

  it("returns undefined for three tokens", () => {
    expect(parseLineStickerRaw("11537:520:extra")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(parseLineStickerRaw("")).toBeUndefined();
  });

  it("returns undefined when packageId is empty", () => {
    expect(parseLineStickerRaw(":1988")).toBeUndefined();
  });

  it("returns undefined when stickerId is empty", () => {
    expect(parseLineStickerRaw("446:")).toBeUndefined();
  });

  it("returns undefined for extra separators", () => {
    expect(parseLineStickerRaw("446:1988:extra")).toBeUndefined();
  });

  it("parses very large numeric ids", () => {
    expect(parseLineStickerRaw("99999999999999:99999999999999")).toEqual({
      packageId: "99999999999999",
      stickerId: "99999999999999",
    });
  });
});
