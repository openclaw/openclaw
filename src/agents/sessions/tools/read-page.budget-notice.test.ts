// The read tool reports the budget that actually cut the page. A model-context
// truncation must not claim the byte cap did it.
import { describe, expect, it } from "vitest";
import { createBoundedReadTextPage } from "./read-page.js";

describe("read page truncation notice", () => {
  it("names the model context budget when that is what truncated the page", () => {
    const page = createBoundedReadTextPage({
      content: "中".repeat(30_000),
      startLine: 1,
      endLine: 1,
      maxBytes: 200_000,
      modelBudget: { maxChars: 4_000, maxContextChars: 4_000 },
      adaptive: true,
    });

    expect(page.details.kind).toBe("truncated");
    expect(page.text).toMatch(/capped at \d+ chars for this call/);
    expect(page.text).not.toContain("KB");
  });

  it("keeps the byte budget wording when the byte cap is binding", () => {
    const page = createBoundedReadTextPage({
      content: "a".repeat(80_000),
      startLine: 1,
      endLine: 1,
      maxBytes: 8_000,
      adaptive: true,
    });

    expect(page.details.kind).toBe("truncated");
    expect(page.text).toMatch(/capped at [\d.]+KB/);
  });
});
