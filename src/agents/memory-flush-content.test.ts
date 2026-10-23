import { describe, expect, it } from "vitest";
import { assertNewMemoryFlushContent } from "./memory-flush-content.js";

describe("memory flush content", () => {
  const existing =
    "# Daily notes\n\n- Project Alder uses port 7319.\n\n## Deployment\nUse staging first.\n";

  it.each([
    existing,
    existing.replaceAll("\n", "\r\n"),
    "## Deployment\nUse staging first.\n\n- New fact\n",
    "- Project Alder uses port 7319.\n\n- New fact\n",
  ])("rejects replayed saved content", (content) => {
    expect(() => assertNewMemoryFlushContent(existing, content)).toThrow(
      "Retry with only new content",
    );
  });

  it("allows new facts under reused headings", () => {
    expect(() =>
      assertNewMemoryFlushContent(existing, "## Deployment\nUse port 8421 for Birch.\n"),
    ).not.toThrow();
  });
});
