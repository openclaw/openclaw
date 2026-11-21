import { describe, expect, it } from "vitest";
import { truncateHead } from "./truncate.js";

describe("session tool truncation facade", () => {
  it("handles empty content with a negative byte limit", () => {
    expect(truncateHead("", -1)).toMatchObject({
      content: "",
      truncated: true,
      truncatedBy: "bytes",
      totalLines: 0,
      totalBytes: 0,
      outputLines: 0,
      outputBytes: 0,
      firstLineExceedsLimit: false,
    });
  });
});
