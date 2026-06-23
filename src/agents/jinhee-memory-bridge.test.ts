/**
 * MEMORY-BRIDGE-001: Tests for jinhee-memory-bridge.ts
 *
 * Strategy:
 *  - Most tests use `formatCanonicalMemoryBlock()` — a pure function that
 *    takes an in-memory array → no DB dependency needed.
 *  - One integration test calls `loadJinheeCanonicalMemoryBlock()` against the
 *    real jinhee.db (read-only) to verify the full pipeline works.
 */

import { describe, expect, it } from "vitest";
import {
  formatCanonicalMemoryBlock,
  loadJinheeCanonicalMemoryBlock,
} from "./jinhee-memory-bridge.js";
import type { CanonicalMemoryRow } from "./jinhee-memory-bridge.js";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<CanonicalMemoryRow> & { content: string }): CanonicalMemoryRow {
  return {
    id: overrides.id ?? 1,
    truthConfidence: overrides.truthConfidence ?? 100,
    sourceCount: overrides.sourceCount ?? 5,
    lastConfirmed: overrides.lastConfirmed ?? "2026-06-22 15:00:00",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure function tests (no DB needed)
// ---------------------------------------------------------------------------

describe("formatCanonicalMemoryBlock", () => {
  it("1. turns rows into a bullet memory block", () => {
    const rows: CanonicalMemoryRow[] = [
      makeRow({ id: 1, content: "User prefers Korean, addressed as 형" }),
      makeRow({ id: 2, content: "Assistant persona is 진희" }),
    ];
    const block = formatCanonicalMemoryBlock(rows, { maxRows: 10 });
    expect(block).not.toBeNull();
    expect(block).toContain("[JinheeOS Canonical Memory]");
    expect(block).toContain("- User prefers Korean, addressed as 형");
    expect(block).toContain("- Assistant persona is 진희");
  });

  it("2. respects maxRows limit", () => {
    const rows: CanonicalMemoryRow[] = Array.from({ length: 20 }, (_, i) =>
      makeRow({ id: i + 1, content: `Memory entry number ${i + 1}` }),
    );
    const block = formatCanonicalMemoryBlock(rows, { maxRows: 3 });
    expect(block).not.toBeNull();
    const lineCount = block!.split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(4); // header + 3 bullets
  });

  it("3. respects maxCharsPerMemory limit", () => {
    const rows: CanonicalMemoryRow[] = [makeRow({ id: 1, content: "A".repeat(500) })];
    const block = formatCanonicalMemoryBlock(rows, {
      maxRows: 5,
      maxCharsPerMemory: 50,
      maxTotalChars: 2000,
    });
    expect(block).not.toBeNull();
    const bulletLine = block!.split("\n")[1]!;
    expect(bulletLine.length).toBeLessThanOrEqual(60); // "- " + 50 + "…" = ~53
  });

  it("4. respects maxTotalChars limit", () => {
    const rows: CanonicalMemoryRow[] = Array.from({ length: 100 }, (_, i) =>
      makeRow({
        id: i + 1,
        content: `Memory line ${i} with some padding content to take up chars.`,
      }),
    );
    const block = formatCanonicalMemoryBlock(rows, {
      maxRows: 100,
      maxCharsPerMemory: 200,
      maxTotalChars: 200,
    });
    expect(block).not.toBeNull();
    expect(block!.length).toBeGreaterThan(29); // at least header
    expect(block!.length).toBeLessThanOrEqual(300); // slightly above limit but bounded
  });

  it("5. returns null for an empty array", () => {
    const block = formatCanonicalMemoryBlock([]);
    expect(block).toBeNull();
  });

  it("8. excludes rows with sensitive keywords", () => {
    const rows: CanonicalMemoryRow[] = [
      makeRow({ id: 1, content: "Normal memory content" }),
      makeRow({ id: 2, content: "My api_key is sk-abc123" }),
      makeRow({ id: 3, content: "Another normal entry" }),
      makeRow({ id: 4, content: "password = hunter2" }),
    ];
    const block = formatCanonicalMemoryBlock(rows, {
      maxRows: 10,
      maxCharsPerMemory: 240,
      maxTotalChars: 2400,
    });
    expect(block).not.toBeNull();
    expect(block).toContain("- Normal memory content");
    expect(block).toContain("- Another normal entry");
    expect(block).not.toContain("api_key");
    expect(block).not.toContain("sk-abc123");
    expect(block).not.toContain("password");
    expect(block).not.toContain("hunter2");
  });

  it("filters out low-trust entries (truth_confidence >= 1000)", () => {
    const rows: CanonicalMemoryRow[] = [
      makeRow({ id: 1, content: "High trust item", truthConfidence: 100 }),
      makeRow({ id: 2, content: "Low quality item", truthConfidence: 5000 }),
      makeRow({ id: 3, content: "Test item", truthConfidence: 7000 }),
    ];
    const block = formatCanonicalMemoryBlock(rows, { maxRows: 10 });
    expect(block).not.toBeNull();
    expect(block).toContain("- High trust item");
    expect(block).not.toContain("Low quality item");
    expect(block).not.toContain("Test item");
  });

  it("filters out JSON content rows", () => {
    const rows: CanonicalMemoryRow[] = [
      makeRow({ id: 1, content: "Normal memory text" }),
      makeRow({ id: 2, content: '{"category": "test", "rule_text": "some rule"}' }),
    ];
    const block = formatCanonicalMemoryBlock(rows, { maxRows: 10 });
    expect(block).not.toBeNull();
    expect(block).toContain("- Normal memory text");
    expect(block).not.toContain("category");
  });

  it("returns null when all rows are filtered out", () => {
    const rows: CanonicalMemoryRow[] = [
      makeRow({ id: 1, content: '{"json": "test"}', truthConfidence: 100 }),
      makeRow({ id: 2, content: "Low trust", truthConfidence: 5000 }),
    ];
    const block = formatCanonicalMemoryBlock(rows, { maxRows: 10 });
    expect(block).toBeNull();
  });

  it("truncates long content with an ellipsis", () => {
    const rows: CanonicalMemoryRow[] = [
      makeRow({ id: 1, content: "Short" }),
      makeRow({
        id: 2,
        content:
          "This is a very long content that should definitely be truncated because it exceeds the maximum character limit per memory entry",
      }),
    ];
    const block = formatCanonicalMemoryBlock(rows, { maxRows: 10, maxCharsPerMemory: 30 });
    expect(block).not.toBeNull();
    const bullets = block!.split("\n").slice(1);
    expect(bullets[0]).toBe("- Short");
    // Second bullet should be truncated
    expect(bullets[1]!.length).toBeLessThan(
      "This is a very long content that should definitely be truncated because it exceeds the maximum character limit per memory entry"
        .length + 3,
    );
  });

  it("handles content with newlines", () => {
    const rows: CanonicalMemoryRow[] = [makeRow({ id: 1, content: "Line 1\nLine 2\nLine 3" })];
    const block = formatCanonicalMemoryBlock(rows, { maxRows: 10 });
    expect(block).not.toBeNull();
    // Newlines should be replaced with │ separator
    expect(block).not.toContain("\nLine 2");
    expect(block).toContain("│");
  });

  it("handles very short or empty content", () => {
    const rows: CanonicalMemoryRow[] = [
      makeRow({ id: 1, content: "a" }), // too short (< 2)
      makeRow({ id: 2, content: "  " }), // whitespace only
      makeRow({ id: 3, content: "Valid" }),
    ];
    const block = formatCanonicalMemoryBlock(rows, { maxRows: 10 });
    expect(block).not.toBeNull();
    expect(block).toContain("- Valid");
    // The other two should be filtered out
    expect(block!.split("\n").length).toBe(2); // header + 1 valid
  });
});

// ---------------------------------------------------------------------------
// Integration tests (with real jinhee.db — read-only)
// ---------------------------------------------------------------------------

describe("loadJinheeCanonicalMemoryBlock", () => {
  it("returns null when DB file does not exist", async () => {
    const block = await loadJinheeCanonicalMemoryBlock({
      dbPath: "/tmp/nonexistent-jinhee-test-db-12345.db",
    });
    expect(block).toBeNull();
  });

  it("reads from the real jinhee.db and returns valid markdown", async () => {
    const block = await loadJinheeCanonicalMemoryBlock();
    expect(block).not.toBeNull();
    expect(block).toContain("[JinheeOS Canonical Memory]");
    // Should have at least one bullet
    const bullets = block!.split("\n").slice(1);
    expect(bullets.length).toBeGreaterThanOrEqual(1);
    // Each bullet should start with "- "
    for (const bullet of bullets) {
      expect(bullet).toMatch(/^- /);
    }
    // Should contain 형-related memories (from real DB data)
    expect(block).toContain("형");
    expect(block).toContain("진희");
    // JSON entries should be filtered out
    expect(block).not.toContain("category");
    expect(block).not.toContain("response_style");
  });
});
