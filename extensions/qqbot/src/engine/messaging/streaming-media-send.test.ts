import { describe, expect, it, vi } from "vitest";
import { findFirstClosedMediaTag } from "./streaming-media-send.js";

describe("findFirstClosedMediaTag", () => {
  it("skips file URI media tags from streaming model output", () => {
    const log = { error: vi.fn(), debug: vi.fn() };

    expect(findFirstClosedMediaTag("<qqfile>file:///etc/passwd</qqfile>", log)).toBeNull();
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
