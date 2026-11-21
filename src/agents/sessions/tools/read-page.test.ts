import { describe, expect, it } from "vitest";
import { resolveToolResultBudget } from "../../tool-result-limits.js";
import { createBoundedReadTextPage } from "./read-page.js";

const DEFAULT_MAX_BYTES = 50 * 1024;

const page = (params: {
  content: string;
  totalLines?: number;
  modelBudget?: ReturnType<typeof resolveToolResultBudget>;
}) =>
  createBoundedReadTextPage({
    content: params.content,
    startLine: 1,
    endLine: 1,
    ...(params.totalLines === undefined ? {} : { totalLines: params.totalLines }),
    maxBytes: DEFAULT_MAX_BYTES,
    ...(params.modelBudget === undefined ? {} : { modelBudget: params.modelBudget }),
  });

describe("read page truncation cause", () => {
  it("names the model budget when the byte cap was never reached", () => {
    // 16,000 CJK characters are 48,000 UTF-8 bytes: below the 50KB byte cap, but their
    // weighted estimate (64,000) exceeds the 32,000-unit budget of a 128k context.
    const cjk = "你".repeat(16_000);
    const result = page({
      content: cjk,
      totalLines: 1,
      modelBudget: resolveToolResultBudget(128_000),
    });

    expect(result.details.kind).toBe("truncated");
    if (result.details.kind !== "truncated") {
      return;
    }
    expect(result.details.truncation.truncatedBy).toBe("budget");
    expect(result.text).toContain("model budget");
    expect(result.text).not.toContain("50KB");
    // The continuation still points at the first character that did not fit.
    expect(result.details.continuation).toEqual({ kind: "cursor", offset: 1, cursor: 7977 });
  });

  it("keeps the byte cap notice when the byte cap is what truncated", () => {
    const result = page({ content: "a".repeat(60_000), totalLines: 1 });

    expect(result.details.kind).toBe("truncated");
    if (result.details.kind !== "truncated") {
      return;
    }
    expect(result.details.truncation.truncatedBy).toBe("bytes");
    expect(result.text).toContain("50.0KB limit");
    expect(result.text).not.toContain("model budget");
  });

  it("keeps the line notice when the line count truncated", () => {
    const result = createBoundedReadTextPage({
      content: "x\n".repeat(3_000),
      startLine: 1,
      endLine: 3_000,
      totalLines: 3_000,
      maxBytes: DEFAULT_MAX_BYTES,
    });

    expect(result.details.kind).toBe("truncated");
    if (result.details.kind !== "truncated") {
      return;
    }
    expect(result.details.truncation.truncatedBy).toBe("lines");
  });

  it("reports the budget on the range-free notice variant", () => {
    const notice = createBoundedReadTextPage({
      content: "你".repeat(16_000),
      startLine: 1,
      endLine: 1,
      maxBytes: DEFAULT_MAX_BYTES,
      modelBudget: resolveToolResultBudget(128_000),
    });

    expect(notice.text).toContain("[Read output capped by the model budget.");
  });
});
