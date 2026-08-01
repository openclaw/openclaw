import { describe, expect, it } from "vitest";
import { prepareDailyMemoryFlushAppend } from "./memory-flush-append.js";

describe("prepareDailyMemoryFlushAppend", () => {
  it("accepts content at the exact structural limits by default", () => {
    const content = `${"x".repeat(500)}\n${"y".repeat(299)}`;
    expect(prepareDailyMemoryFlushAppend({ content, existingContent: "seed" })).toEqual({
      status: "accepted",
      content,
      appendedLines: 2,
      appendChars: 800,
      skippedDuplicateLines: 0,
    });
  });

  it.each([
    { name: "empty payload", content: " \n\t", error: /at least one non-empty line/ },
    { name: "line length", content: "x".repeat(501), error: /line too long/ },
    {
      name: "line count",
      content: "- one\n- two\n- three\n- four",
      error: /too many lines/,
    },
    {
      name: "bare carriage-return line count",
      content: "- one\r- two\r- three\r- four",
      error: /too many lines/,
    },
    {
      name: "payload length",
      content: `${"x".repeat(400)}\n${"y".repeat(400)}`,
      error: /content too large/,
    },
  ])("rejects $name regardless of semantic policy", ({ content, error }) => {
    expect(() =>
      prepareDailyMemoryFlushAppend({
        content,
        existingContent: "seed",
        semanticPolicy: { deduplicateLines: false, rejectHeadings: false },
      }),
    ).toThrow(error);
  });

  it("allows headings and exact duplicate lines by default", () => {
    const content = "# Memory - 2026-08-01\n- existing durable note";
    expect(
      prepareDailyMemoryFlushAppend({ content, existingContent: "- existing durable note" }),
    ).toMatchObject({ status: "accepted", content, skippedDuplicateLines: 0 });
  });

  it.each([
    "# Memory - 2026-08-01\n- compact note",
    "Memory - 2026-08-01\n===================",
    "Memory - 2026-08-01\n-------------------",
  ])("rejects heading-shaped content only when configured: %s", (content) => {
    expect(() =>
      prepareDailyMemoryFlushAppend({
        content,
        existingContent: "seed",
        semanticPolicy: { rejectHeadings: true },
      }),
    ).toThrow(/disabled by policy/);
  });

  it("deduplicates existing and repeated lines only when configured", () => {
    expect(
      prepareDailyMemoryFlushAppend({
        content: "- existing durable note\n- new compact note\n  - new   compact note  ",
        existingContent: "- existing durable note",
        semanticPolicy: { deduplicateLines: true },
      }),
    ).toEqual({
      status: "accepted",
      content: "- new compact note",
      appendedLines: 1,
      appendChars: 18,
      skippedDuplicateLines: 2,
    });
  });

  it("does not let deduplication bypass structural input bounds", () => {
    expect(() =>
      prepareDailyMemoryFlushAppend({
        content: "- same\n- same\n- same\n- same",
        existingContent: "- same",
        semanticPolicy: { deduplicateLines: true },
      }),
    ).toThrow(/too many lines/);
  });

  it("returns a duplicate-only skip when deduplication is configured", () => {
    expect(
      prepareDailyMemoryFlushAppend({
        content: "  - existing   durable note  ",
        existingContent: "- existing durable note",
        semanticPolicy: { deduplicateLines: true },
      }),
    ).toEqual({
      status: "skipped_duplicate",
      content: "",
      skippedDuplicateLines: 1,
    });
  });
});
