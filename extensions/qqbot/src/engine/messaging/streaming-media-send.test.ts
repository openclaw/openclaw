import { describe, expect, it, vi } from "vitest";
import { findFirstClosedMediaTag } from "./streaming-media-send.js";

describe("findFirstClosedMediaTag", () => {
  it("returns a consumable empty media item for file URI tags", () => {
    const log = { error: vi.fn(), debug: vi.fn() };

    const found = findFirstClosedMediaTag("<qqfile>file:///etc/passwd</qqfile>", log);

    expect(found?.itemType).toBe("file");
    expect(found?.mediaPath).toBe("");
    expect(found?.tagEndIndex).toBe("<qqfile>file:///etc/passwd</qqfile>".length);
    expect(log.error).toHaveBeenCalledWith(
      "findFirstClosedMediaTag: blocked file URI in <qqfile> media tag",
    );
  });

  it("still accepts absolute local media paths", () => {
    const found = findFirstClosedMediaTag("<qqfile>/tmp/openclaw-media/report.txt</qqfile>");

    expect(found?.itemType).toBe("file");
    expect(found?.mediaPath).toBe("/tmp/openclaw-media/report.txt");
  });
});
