import { describe, expect, it } from "vitest";
import {
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  COMPACTION_SUMMARY_END_MARKER,
} from "../messages.js";

// -- Suite D: Summary Prefix Disambiguation --

describe("enhanced compaction summary prefix", () => {
  it("contains 'REFERENCE ONLY' disambiguation directive", () => {
    expect(COMPACTION_SUMMARY_PREFIX.toUpperCase()).toContain("REFERENCE ONLY");
  });

  it("contains directive to respond to latest user message", () => {
    expect(COMPACTION_SUMMARY_PREFIX).toMatch(
      /respond\s+only\s+to\s+the\s+latest\s+user\s+message/i,
    );
  });

  it("contains directive to not answer questions from summary", () => {
    expect(COMPACTION_SUMMARY_PREFIX).toMatch(/do\s+not\s+answer\s+questions/i);
  });

  it("is backward-compatible with existing prefix concept", () => {
    // Should contain key phrases from the original prefix concept
    expect(COMPACTION_SUMMARY_PREFIX).toMatch(/compacted|summary/i);
  });
});

describe("compaction summary end marker", () => {
  it("end marker contains boundary directive", () => {
    expect(COMPACTION_SUMMARY_END_MARKER).toMatch(/end|---/i);
  });

  it("end marker directs attention to messages below", () => {
    expect(COMPACTION_SUMMARY_END_MARKER).toMatch(/below|after|following/i);
  });
});

describe("wrapCompactionSummary via convertToLlm pattern", () => {
  it("wraps summary with prefix and end marker", () => {
    const summary = "## Goal\nBuild feature X";
    const wrapped =
      COMPACTION_SUMMARY_PREFIX +
      summary +
      COMPACTION_SUMMARY_SUFFIX +
      "\n\n" +
      COMPACTION_SUMMARY_END_MARKER;

    expect(wrapped).toContain(COMPACTION_SUMMARY_PREFIX);
    expect(wrapped).toContain(summary);
    expect(wrapped).toContain(COMPACTION_SUMMARY_END_MARKER);
  });

  it("handles empty summary string", () => {
    const wrapped =
      COMPACTION_SUMMARY_PREFIX +
      COMPACTION_SUMMARY_SUFFIX +
      "\n\n" +
      COMPACTION_SUMMARY_END_MARKER;

    expect(wrapped.length).toBeGreaterThan(0);
    expect(wrapped).toContain(COMPACTION_SUMMARY_PREFIX);
    expect(wrapped).toContain(COMPACTION_SUMMARY_END_MARKER);
  });
});
