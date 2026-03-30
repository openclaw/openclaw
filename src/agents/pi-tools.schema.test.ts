import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";
import { normalizeToolParameters, mergePropertySchemas } from "./pi-tools.schema.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

describe("normalizeToolParameters", () => {
  it("strips compat-declared unsupported schema keywords without provider-specific branching", () => {
    const tool: AnyAgentTool = {
      name: "demo",
      label: "demo",
      description: "demo",
      parameters: Type.Object({
        count: Type.Integer({ minimum: 1, maximum: 5 }),
        query: Type.Optional(Type.String({ minLength: 2 })),
      }),
      execute: vi.fn(),
    };

    const normalized = normalizeToolParameters(tool, {
      modelCompat: {
        unsupportedToolSchemaKeywords: ["minimum", "maximum", "minLength"],
      },
    });

    const parameters = normalized.parameters as {
      required?: string[];
      properties?: Record<string, Record<string, unknown>>;
    };

    expect(parameters.required).toEqual(["count"]);
    expect(parameters.properties?.count.minimum).toBeUndefined();
    expect(parameters.properties?.count.maximum).toBeUndefined();
    expect(parameters.properties?.count.type).toBe("integer");
    expect(parameters.properties?.query.minLength).toBeUndefined();
    expect(parameters.properties?.query.type).toBe("string");
  });
});

describe("mergePropertySchemas", () => {
  describe("non-enum path", () => {
    it("preserves type and other constraints when merging non-enum schemas", () => {
      const existing = { type: "string", optional: true, minLength: 1 };
      const incoming = { type: "string", optional: false };

      const merged = mergePropertySchemas(existing, incoming) as Record<string, unknown>;

      expect(merged.type).toBe("string");
      expect(merged.optional).toBe(true);
      expect(merged.minLength).toBe(1);
    });

    it("merges properties from both schemas", () => {
      const existing = { type: "string", title: "Message ID" };
      const incoming = { description: "Unique identifier", optional: true };

      const merged = mergePropertySchemas(existing, incoming) as Record<string, unknown>;

      expect(merged.type).toBe("string");
      expect(merged.title).toBe("Message ID");
      expect(merged.description).toBe("Unique identifier");
      expect(merged.optional).toBe(true);
    });

    it("prefers existing type when there's a conflict", () => {
      const existing = { type: "string" };
      const incoming = { type: "number" };

      const merged = mergePropertySchemas(existing, incoming) as Record<string, unknown>;

      expect(merged.type).toBe("string");
    });

    it("uses incoming type when existing has no type", () => {
      const existing = { title: "Test" };
      const incoming = { type: "string" };

      const merged = mergePropertySchemas(existing, incoming) as Record<string, unknown>;

      expect(merged.type).toBe("string");
      expect(merged.title).toBe("Test");
    });

    it("preserves optional when either schema has it", () => {
      const existing = { type: "string", optional: true };
      const incoming = { type: "string" };

      const merged1 = mergePropertySchemas(existing, incoming) as Record<string, unknown>;
      expect(merged1.optional).toBe(true);

      const existing2 = { type: "string" };
      const incoming2 = { type: "string", optional: true };

      const merged2 = mergePropertySchemas(existing2, incoming2) as Record<string, unknown>;
      expect(merged2.optional).toBe(true);
    });
  });

  describe("enum path", () => {
    it("preserves optional: true in enum path", () => {
      const existing = { enum: ["a", "b"], optional: true };
      const incoming = { enum: ["c"] };

      const merged = mergePropertySchemas(existing, incoming) as Record<string, unknown>;

      expect(merged.optional).toBe(true);
      expect(merged.enum).toEqual(["a", "b", "c"]);
    });

    it("preserves optional when both schemas have it in enum path", () => {
      const existing = { enum: ["x"], optional: true };
      const incoming = { enum: ["y"], optional: true };

      const merged = mergePropertySchemas(existing, incoming) as Record<string, unknown>;

      expect(merged.optional).toBe(true);
      expect(merged.enum).toEqual(["x", "y"]);
    });

    it("does not set optional when neither schema has it in enum path", () => {
      const existing = { enum: ["a"], title: "Test" };
      const incoming = { enum: ["b"], description: "Desc" };

      const merged = mergePropertySchemas(existing, incoming) as Record<string, unknown>;

      expect(merged.optional).toBeUndefined();
      expect(merged.title).toBe("Test");
      expect(merged.description).toBe("Desc");
      expect(merged.enum).toEqual(["a", "b"]);
    });

    it("preserves title, description, default in enum path", () => {
      const existing = { enum: ["a"], title: "Existing", default: "a" };
      const incoming = { enum: ["b"], description: "Incoming", default: "b" };

      const merged = mergePropertySchemas(existing, incoming) as Record<string, unknown>;

      expect(merged.title).toBe("Existing");
      expect(merged.description).toBe("Incoming");
      expect(merged.default).toBe("a"); // existing wins (first in loop)
      expect(merged.enum).toEqual(["a", "b"]);
    });

    it("handles const values in enum path with optional", () => {
      const existing = { const: "fixed", optional: true };
      const incoming = { const: "fixed" };

      const merged = mergePropertySchemas(existing, incoming) as Record<string, unknown>;

      expect(merged.optional).toBe(true);
      expect(merged.enum).toEqual(["fixed"]);
    });

    it("merges enum values from both schemas", () => {
      const existing = { enum: ["a", "b"], type: "string" };
      const incoming = { enum: ["c", "d"], type: "string" };

      const merged = mergePropertySchemas(existing, incoming) as Record<string, unknown>;

      expect(merged.enum).toEqual(["a", "b", "c", "d"]);
      expect(merged.type).toBe("string");
    });

    it("deduplicates enum values", () => {
      const existing = { enum: ["a", "b"] };
      const incoming = { enum: ["b", "c"] };

      const merged = mergePropertySchemas(existing, incoming) as Record<string, unknown>;

      expect(merged.enum).toEqual(["a", "b", "c"]);
    });
  });

  describe("edge cases", () => {
    it("returns incoming when existing is null", () => {
      const existing = null;
      const incoming = { type: "string" };

      const merged = mergePropertySchemas(existing, incoming);

      expect(merged).toEqual({ type: "string" });
    });

    it("returns existing when incoming is null", () => {
      const existing = { type: "string" };
      const incoming = null;

      const merged = mergePropertySchemas(existing, incoming);

      expect(merged).toEqual({ type: "string" });
    });

    it("handles non-object schemas gracefully", () => {
      const existing = "string";
      const incoming = 42;

      const merged = mergePropertySchemas(existing, incoming);

      expect(merged).toBe("string");
    });
  });
});
