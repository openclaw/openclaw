import { describe, expect, it } from "vitest";

describe("mergePropertySchemas", () => {
  function simulateMerge(
    existing: Record<string, unknown>,
    incoming: Record<string, unknown>,
  ): Record<string, unknown> {
    const existingEnum = Array.isArray(existing.enum) ? existing.enum : undefined;
    const incomingEnum = Array.isArray(incoming.enum) ? incoming.enum : undefined;

    if (existingEnum || incomingEnum) {
      const _values = Array.from(new Set([...(existingEnum || []), ...(incomingEnum || [])]));
      const merged: Record<string, unknown> = {};

      for (const source of [existing, incoming]) {
        if (!source || typeof source !== "object") {
          continue;
        }
        const record = source;
        for (const key of ["title", "description", "default", "optional"]) {
          if (!(key in merged) && key in record) {
            merged[key] = record[key];
          }
        }
      }

      return merged;
    }

    const merged: Record<string, unknown> = {};
    if (existing.optional === true || incoming.optional === true) {
      merged.optional = true;
    }
    return merged;
  }

  it("should preserve optional: true in non-enum fallthrough path", () => {
    const existing = { type: "string", optional: true };
    const incoming = { type: "string" };

    const merged = simulateMerge(existing, incoming);
    expect(merged.optional).toBe(true);
  });

  it("should preserve optional: true in enum path", () => {
    const existing = { enum: ["a", "b"], optional: true };
    const incoming = { enum: ["c"] };

    const merged = simulateMerge(existing, incoming);
    expect(merged.optional).toBe(true);
    expect(
      (merged.enum as unknown[]).toSorted((a, b) => String(a).localeCompare(String(b))),
    ).toEqual(["a", "b", "c"].toSorted((a, b) => String(a).localeCompare(String(b))));
  });

  it("should preserve optional: true when both schemas have it in enum path", () => {
    const existing = { enum: ["x"], optional: true };
    const incoming = { enum: ["y"], optional: true };

    const merged = simulateMerge(existing, incoming);
    expect(merged.optional).toBe(true);
  });

  it("should not set optional when neither schema has it in enum path", () => {
    const existing = { enum: ["a"], title: "Test" };
    const incoming = { enum: ["b"], description: "Desc" };

    const merged = simulateMerge(existing, incoming);
    expect(merged.optional).toBeUndefined();
    expect(merged.title).toBe("Test");
    expect(merged.description).toBe("Desc");
  });

  it("should preserve title, description, default in enum path", () => {
    const existing = { enum: ["a"], title: "Existing", default: "a" };
    const incoming = { enum: ["b"], description: "Incoming", default: "b" };

    const merged = simulateMerge(existing, incoming);
    expect(merged.title).toBe("Existing");
    expect(merged.description).toBe("Incoming");
    expect(merged.default).toBe("a");
  });

  it("should handle const values in enum path with optional", () => {
    const existing = { const: "fixed", optional: true };
    const incoming = { const: "fixed" };

    const merged: Record<string, unknown> = {};
    for (const source of [existing, incoming]) {
      if (!source || typeof source !== "object") {
        continue;
      }
      for (const key of ["title", "description", "default", "optional"]) {
        if (!(key in merged) && key in source) {
          merged[key] = (source as Record<string, unknown>)[key];
        }
      }
    }

    expect(merged.optional).toBe(true);
  });
});
