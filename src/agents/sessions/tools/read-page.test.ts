import { describe, expect, it } from "vitest";
import { createBoundedReadTextPage, formatReadContinuationNotice } from "./read-page.js";

const MAX_BYTES = 50 * 1024;

describe("formatReadContinuationNotice", () => {
  it("names the byte cap when bytes end the page", () => {
    expect(formatReadContinuationNotice({ kind: "line", offset: 2 }, MAX_BYTES)).toContain(
      "capped at 50KB",
    );
  });

  it("names the model budget instead of the byte cap when that limit binds", () => {
    const notice = formatReadContinuationNotice(
      { kind: "line", offset: 2 },
      MAX_BYTES,
      undefined,
      "model-budget",
    );
    expect(notice).toContain("model context budget");
    expect(notice).not.toContain("50KB");
  });
});

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
