import { describe, expect, it } from "vitest";
import { extractToolCallContent, extractToolCallLocations } from "./event-mapper.js";

describe("extractToolCallContent", () => {
  it("extracts text blocks from tool results", () => {
    const result = extractToolCallContent({
      content: [{ type: "text", text: "hello" }],
    });
    expect(result).toEqual([{ type: "content", content: { type: "text", text: "hello" } }]);
  });

  it("extracts image blocks from tool results", () => {
    const result = extractToolCallContent({
      content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
    });
    expect(result).toEqual([
      {
        type: "content",
        content: { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      },
    ]);
  });

  it("extracts mixed text and image blocks", () => {
    const result = extractToolCallContent({
      content: [
        { type: "text", text: "Chart output:" },
        { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      ],
    });
    expect(result).toHaveLength(2);
    expect(result![0]).toEqual({
      type: "content",
      content: { type: "text", text: "Chart output:" },
    });
    expect(result![1]).toEqual({
      type: "content",
      content: { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
    });
  });

  it("skips image blocks with missing data or mimeType", () => {
    const result = extractToolCallContent({
      content: [
        { type: "image", mimeType: "image/png" },
        { type: "image", data: "iVBORw0KGgo=" },
        { type: "text", text: "fallback" },
      ],
    });
    expect(result).toEqual([{ type: "content", content: { type: "text", text: "fallback" } }]);
  });

  it("returns undefined for empty content", () => {
    expect(extractToolCallContent({})).toBeUndefined();
    expect(extractToolCallContent({ content: [] })).toBeUndefined();
  });

  it("returns text from string input", () => {
    const result = extractToolCallContent("plain text");
    expect(result).toEqual([{ type: "content", content: { type: "text", text: "plain text" } }]);
  });
});

describe("extractToolCallLocations", () => {
  it("enforces the global node visit cap across nested structures", () => {
    const nested = Array.from({ length: 20 }, (_, outer) =>
      Array.from({ length: 20 }, (_, inner) =>
        inner === 19 ? { path: `/tmp/file-${outer}.txt` } : { note: `${outer}-${inner}` },
      ),
    );

    const locations = extractToolCallLocations(nested);

    expect(locations).toBeDefined();
    expect(locations?.length).toBeLessThan(20);
    expect(locations).not.toContainEqual({ path: "/tmp/file-19.txt" });
  });
});
