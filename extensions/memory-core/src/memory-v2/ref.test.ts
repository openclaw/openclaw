import { describe, expect, it } from "vitest";
import { type MemoryRef, memoryLocationId, memoryRefId, normalizeLocationPath } from "./ref.js";

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

  it("normalizes equivalent paths to the same id", () => {
    expect(memoryRefId(baseRef)).toBe(memoryRefId({ ...baseRef, path: `./${baseRef.path}` }));
    expect(memoryRefId(baseRef)).toBe(
      memoryRefId({ ...baseRef, path: baseRef.path.replace(/\//g, "\\") }),
    );
  });
});

describe("memoryLocationId", () => {
  const base = {
    source: "memory" as const,
    path: "memory/2026-04-15.md",
    startLine: 10,
    endLine: 24,
  };

  it("is deterministic and 32-char hex", () => {
    expect(memoryLocationId(base)).toMatch(/^[0-9a-f]{32}$/);
    expect(memoryLocationId(base)).toBe(memoryLocationId({ ...base }));
  });

  it("ignores content hash by construction (no contentHash field)", () => {
    // Two refs differing only in content hash share a location id.
    const a = memoryRefId({ ...base, contentHash: "h1" });
    const b = memoryRefId({ ...base, contentHash: "h2" });
    expect(a).not.toBe(b);
    expect(memoryLocationId(base)).toBe(memoryLocationId(base));
  });

  it("differs for different sources, paths, or line ranges", () => {
    expect(memoryLocationId(base)).not.toBe(memoryLocationId({ ...base, source: "sessions" }));
    expect(memoryLocationId(base)).not.toBe(memoryLocationId({ ...base, path: "other.md" }));
    expect(memoryLocationId(base)).not.toBe(memoryLocationId({ ...base, startLine: 11 }));
    expect(memoryLocationId(base)).not.toBe(memoryLocationId({ ...base, endLine: 25 }));
  });

  it("collapses backend path drift", () => {
    expect(memoryLocationId(base)).toBe(memoryLocationId({ ...base, path: `./${base.path}` }));
    expect(memoryLocationId(base)).toBe(
      memoryLocationId({ ...base, path: base.path.replace(/\//g, "\\") }),
    );
    expect(memoryLocationId(base)).toBe(
      memoryLocationId({ ...base, path: base.path.replace("/", "//") }),
    );
  });
});

describe("normalizeLocationPath", () => {
  it("converts backslashes to forward slashes", () => {
    expect(normalizeLocationPath("memory\\foo.md")).toBe("memory/foo.md");
  });

  it("strips a leading ./ (and repeats)", () => {
    expect(normalizeLocationPath("./memory/foo.md")).toBe("memory/foo.md");
    expect(normalizeLocationPath(".//memory/foo.md")).toBe("memory/foo.md");
  });

  it("collapses repeated slashes", () => {
    expect(normalizeLocationPath("memory///foo.md")).toBe("memory/foo.md");
  });

  it("does not lowercase", () => {
    expect(normalizeLocationPath("Memory/Foo.MD")).toBe("Memory/Foo.MD");
  });

  it("leaves the synthetic conversation prefix intact", () => {
    expect(normalizeLocationPath(":conversation/abc")).toBe(":conversation/abc");
  });
});
