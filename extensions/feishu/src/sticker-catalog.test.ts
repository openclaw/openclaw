// Feishu sticker-search matches NFC keywords against NFD queries.
import { describe, expect, it } from "vitest";
import { searchFeishuStickerSet } from "./sticker-catalog.js";

// NFC "ü" is U+00FC; NFD is "u" + combining diaeresis U+0308.
const NFC_KEYWORD = "M\u00fcller wave";
const NFD_QUERY = "Mu\u0308ller";

describe("searchFeishuStickerSet NFC", () => {
  it("matches an NFD query against an NFC keyword", () => {
    const result = searchFeishuStickerSet([["file_muller", [NFC_KEYWORD]]], {
      query: NFD_QUERY,
    });
    expect(result.stickers).toEqual([{ fileId: "file_muller", keyword: NFC_KEYWORD }]);
    expect(result.truncated).toBe(false);
  });

  it("matches an NFC query against an NFD keyword", () => {
    const result = searchFeishuStickerSet([["file_nfd", [NFD_QUERY]]], {
      query: "M\u00fcller",
    });
    expect(result.stickers).toEqual([{ fileId: "file_nfd", keyword: NFD_QUERY }]);
  });
});
