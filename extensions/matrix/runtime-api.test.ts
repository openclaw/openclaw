// Matrix runtime-api tests cover chunking behavior.
import { describe, expect, it } from "vitest";
import { chunkTextForOutbound } from "./runtime-api.js";

describe("chunkTextForOutbound", () => {
  it("trims trailing whitespace from the final chunk (regression #64036)", () => {
    expect(chunkTextForOutbound("abc def  ", 6)).toEqual(["abc", "def"]);
    expect(chunkTextForOutbound("hello world   ", 8)).toEqual(["hello", "world"]);
  });

  it("handles empty text", () => {
    expect(chunkTextForOutbound("", 10)).toEqual([""]);
  });

  it("handles text within limit", () => {
    expect(chunkTextForOutbound("hello", 10)).toEqual(["hello"]);
  });

  it("handles text exceeding limit", () => {
    expect(chunkTextForOutbound("abc def ghi", 4)).toEqual(["abc", "def", "ghi"]);
  });
});
