import { describe, expect, it } from "vitest";
import { createBoundedReadTextPage } from "./read-page.js";

const MAX_BYTES = 50 * 1024;

describe("createBoundedReadTextPage", () => {
  it("reports the model budget when it cuts the page before the byte cap", () => {
    // 16k CJK characters are ~48KB but weigh 64k toward the context budget.
    const content = "你".repeat(16_000);
    const page = createBoundedReadTextPage({
      content,
      startLine: 1,
      endLine: 1,
      totalLines: 1,
      maxBytes: MAX_BYTES,
      modelBudget: { maxChars: 32_000, maxContextChars: 128_000 },
    });

    expect(page.details.kind).toBe("truncated");
    expect(page.text).toContain("model context budget");
    expect(page.text).not.toContain("50KB");
    expect(page.text).toContain("offset=1");
  });

  it("names the line ceiling when it ends the page after model slicing", () => {
    const content = "你你你\n".repeat(3_000);
    const page = createBoundedReadTextPage({
      content,
      startLine: 1,
      endLine: 3_000,
      totalLines: 3_000,
      limit: 3_000,
      maxBytes: MAX_BYTES,
      modelBudget: { maxChars: 32_000, maxContextChars: 128_000 },
    });

    expect(page.details.kind).toBe("truncated");
    expect(page.text).toContain("line limit");
    expect(page.text).not.toContain("model context budget");
  });

  it("keeps the byte cap when the model budget is not the binding limit", () => {
    const content = `${"a".repeat(MAX_BYTES)}\n`;
    const page = createBoundedReadTextPage({
      content,
      startLine: 1,
      endLine: 1,
      totalLines: 1,
      maxBytes: MAX_BYTES,
      modelBudget: { maxChars: 1_000_000, maxContextChars: 1_000_000 },
    });

    expect(page.details.kind).toBe("truncated");
    expect(page.text).toContain("50KB");
    expect(page.text).not.toContain("model context budget");
  });
});
