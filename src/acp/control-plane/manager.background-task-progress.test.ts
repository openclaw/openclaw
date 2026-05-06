import { describe, expect, it } from "vitest";
import { appendBackgroundTaskProgressSummary } from "./manager.core.js";

describe("appendBackgroundTaskProgressSummary", () => {
  it("preserves CJK characters across one-char-per-chunk streaming", () => {
    // Codex frequently emits one Hangul syllable per chunk; trimming each
    // chunk and forcing a join space would produce "디 렉 토 리".
    const chunks = ["디", "렉", "토", "리"];
    let summary = "";
    for (const chunk of chunks) {
      summary = appendBackgroundTaskProgressSummary(summary, chunk);
    }
    expect(summary).toBe("디렉토리");
  });

  it("preserves a path streamed in mid-segment chunks", () => {
    // Real-world Codex output: paths split between segments lose their
    // separators and gain spurious spaces when each chunk is trimmed.
    const chunks = ["/home/", "user/", "file.", "txt"];
    let summary = "";
    for (const chunk of chunks) {
      summary = appendBackgroundTaskProgressSummary(summary, chunk);
    }
    expect(summary).toBe("/home/user/file.txt");
  });

  it("preserves a CamelCase identifier streamed mid-word", () => {
    const chunks = ["unbeliev", "able"];
    let summary = "";
    for (const chunk of chunks) {
      summary = appendBackgroundTaskProgressSummary(summary, chunk);
    }
    expect(summary).toBe("unbelievable");
  });

  it("preserves a leading-space chunk as the inter-word boundary", () => {
    const chunks = ["hello", " world"];
    let summary = "";
    for (const chunk of chunks) {
      summary = appendBackgroundTaskProgressSummary(summary, chunk);
    }
    expect(summary).toBe("hello world");
  });

  it("preserves a trailing-space chunk as the inter-word boundary", () => {
    const chunks = ["hello ", "world"];
    let summary = "";
    for (const chunk of chunks) {
      summary = appendBackgroundTaskProgressSummary(summary, chunk);
    }
    expect(summary).toBe("hello world");
  });

  it("collapses newlines and tabs to a single space within a chunk", () => {
    expect(appendBackgroundTaskProgressSummary("", "line one\nline two")).toBe("line one line two");
    expect(appendBackgroundTaskProgressSummary("", "col\tA\tcol\tB")).toBe("col A col B");
  });

  it("collapses runs of whitespace inside a chunk to a single space", () => {
    expect(appendBackgroundTaskProgressSummary("", "foo    bar")).toBe("foo bar");
  });

  it("returns the current summary unchanged for empty or non-string chunks", () => {
    expect(appendBackgroundTaskProgressSummary("foo", "")).toBe("foo");
    expect(appendBackgroundTaskProgressSummary("foo", undefined as unknown as string)).toBe("foo");
    expect(appendBackgroundTaskProgressSummary("foo", null as unknown as string)).toBe("foo");
  });

  it("truncates to the cap with an ellipsis when the combined length overflows", () => {
    // Matches ACP_BACKGROUND_TASK_PROGRESS_MAX_LENGTH in manager.core.ts.
    const cap = 240;
    const long = "a".repeat(cap + 50);
    const result = appendBackgroundTaskProgressSummary("", long);
    expect(result.length).toBe(cap);
    expect(result.endsWith("…")).toBe(true);
  });

  it("does not insert spaces between successive empty-yielding chunks", () => {
    let summary = "";
    summary = appendBackgroundTaskProgressSummary(summary, "abc");
    summary = appendBackgroundTaskProgressSummary(summary, "");
    summary = appendBackgroundTaskProgressSummary(summary, "def");
    expect(summary).toBe("abcdef");
  });
});
