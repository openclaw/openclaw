import { describe, expect, it } from "vitest";
import { type MemoryRef, memoryRefId } from "./ref.js";

const baseRef: MemoryRef = {
  source: "memory",
  path: "memory/2026-04-15.md",
  startLine: 10,
  endLine: 24,
  contentHash: "abc123",
};

describe("memoryRefId", () => {
  it("is deterministic for equivalent refs", () => {
    expect(memoryRefId(baseRef)).toBe(memoryRefId({ ...baseRef }));
  });

  it("is sensitive to source", () => {
    expect(memoryRefId(baseRef)).not.toBe(memoryRefId({ ...baseRef, source: "sessions" }));
  });

  it("is sensitive to path", () => {
    expect(memoryRefId(baseRef)).not.toBe(
      memoryRefId({ ...baseRef, path: "memory/2026-04-16.md" }),
    );
  });

  it("is sensitive to startLine and endLine", () => {
    expect(memoryRefId(baseRef)).not.toBe(memoryRefId({ ...baseRef, startLine: 11 }));
    expect(memoryRefId(baseRef)).not.toBe(memoryRefId({ ...baseRef, endLine: 25 }));
  });

  it("is sensitive to contentHash (so re-edited chunks get a fresh id)", () => {
    expect(memoryRefId(baseRef)).not.toBe(memoryRefId({ ...baseRef, contentHash: "def456" }));
  });

  it("does not collide on path/line boundary ambiguity", () => {
    // "a" + "bc" lines 1..3 must not collide with "ab" + "c" lines 1..3
    // by virtue of the field separator inside the canonical form.
    const left = memoryRefId({
      source: "memory",
      path: "a",
      startLine: 1,
      endLine: 23,
      contentHash: "h",
    });
    const right = memoryRefId({
      source: "memory",
      path: "a",
      startLine: 12,
      endLine: 3,
      contentHash: "h",
    });
    expect(left).not.toBe(right);
  });

  it("returns a 32-char lowercase hex id", () => {
    const id = memoryRefId(baseRef);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });
});
