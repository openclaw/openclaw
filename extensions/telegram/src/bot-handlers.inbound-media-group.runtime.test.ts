import { describe, expect, it } from "vitest";
import { collectMediaGroupCaptions } from "./bot-handlers.inbound-media-group.runtime.js";

describe("collectMediaGroupCaptions", () => {
  it("returns empty array when no messages have captions", () => {
    expect(
      collectMediaGroupCaptions([{ caption: undefined }, { caption: undefined }, { caption: "" }]),
    ).toEqual([]);
  });

  it("returns empty array for an empty message list", () => {
    expect(collectMediaGroupCaptions([])).toEqual([]);
  });

  it("returns a single entry when only one message has a caption", () => {
    expect(
      collectMediaGroupCaptions([{ caption: "only caption" }, { caption: undefined }]),
    ).toEqual([{ albumIndex: 1, caption: "only caption" }]);
  });

  it("preserves original album index for all captions", () => {
    expect(
      collectMediaGroupCaptions([
        { caption: "first" },
        { caption: "second" },
        { caption: "third" },
      ]),
    ).toEqual([
      { albumIndex: 1, caption: "first" },
      { albumIndex: 2, caption: "second" },
      { albumIndex: 3, caption: "third" },
    ]);
  });

  it("retains original album indexes when captions are sparse", () => {
    // Image 1 and 3 have captions; image 2 does not.
    // Album indexes must be 1 and 3, NOT 1 and 2.
    expect(
      collectMediaGroupCaptions([
        { caption: "before" },
        { caption: undefined },
        { caption: "after" },
      ]),
    ).toEqual([
      { albumIndex: 1, caption: "before" },
      { albumIndex: 3, caption: "after" },
    ]);
  });

  it("skips captions that are empty or whitespace-only", () => {
    expect(
      collectMediaGroupCaptions([
        { caption: "  keep me  " },
        { caption: "" },
        { caption: "   " },
        { caption: undefined },
        { caption: "\t\n  second  " },
      ]),
    ).toEqual([
      { albumIndex: 1, caption: "keep me" },
      { albumIndex: 5, caption: "second" },
    ]);
  });

  it("trims whitespace from captions", () => {
    expect(collectMediaGroupCaptions([{ caption: "  hello  " }, { caption: "\tworld\n" }])).toEqual(
      [
        { albumIndex: 1, caption: "hello" },
        { albumIndex: 2, caption: "world" },
      ],
    );
  });

  it("handles a large sparse media group", () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({
      caption: i % 3 === 0 ? `caption ${i}` : undefined,
    }));
    // Indexes 1, 4, 7, 10 (1-based) should have captions
    expect(collectMediaGroupCaptions(messages)).toEqual([
      { albumIndex: 1, caption: "caption 0" },
      { albumIndex: 4, caption: "caption 3" },
      { albumIndex: 7, caption: "caption 6" },
      { albumIndex: 10, caption: "caption 9" },
    ]);
  });
});
