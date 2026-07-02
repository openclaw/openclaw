import { describe, expect, it } from "vitest";
import { normalizeAnthropicSchema } from "./anthropic-schema-normalizer.js";

describe("normalizeAnthropicSchema", () => {
  it("returns the same reference when no changes are needed", () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string" } },
    };
    expect(normalizeAnthropicSchema(schema)).toBe(schema);
  });

  it("returns non-object values unchanged", () => {
    expect(normalizeAnthropicSchema(null)).toBe(null);
    expect(normalizeAnthropicSchema(false)).toBe(false);
    expect(normalizeAnthropicSchema(42)).toBe(42);
    expect(normalizeAnthropicSchema("string")).toBe("string");
  });

  it("passes through arrays of non-schema values unchanged", () => {
    const arr = [1, "two", false];
    expect(normalizeAnthropicSchema(arr)).toBe(arr);
  });

  describe("items → prefixItems conversion", () => {
    it("converts items array (tuple) to prefixItems", () => {
      const schema = {
        type: "array",
        items: [{ type: "number" }, { type: "string" }],
      };
      expect(normalizeAnthropicSchema(schema)).toEqual({
        type: "array",
        prefixItems: [{ type: "number" }, { type: "string" }],
      });
    });

    it("does not change single-schema items (object)", () => {
      const schema = {
        type: "array",
        items: { type: "number" },
      };
      expect(normalizeAnthropicSchema(schema)).toBe(schema);
    });

    it("does not change items: false", () => {
      const schema = {
        type: "array",
        items: false,
      };
      expect(normalizeAnthropicSchema(schema)).toBe(schema);
    });

    it("does not overwrite existing prefixItems", () => {
      const schema = {
        type: "array",
        items: [{ type: "string" }],
        prefixItems: [{ type: "number" }],
      };
      expect(normalizeAnthropicSchema(schema)).toEqual({
        type: "array",
        prefixItems: [{ type: "number" }],
      });
    });

    it("converts empty items array to empty prefixItems", () => {
      const schema = {
        type: "array",
        items: [] as Array<Record<string, unknown>>,
      };
      expect(normalizeAnthropicSchema(schema)).toEqual({
        type: "array",
        prefixItems: [],
      });
    });
  });

  describe("additionalItems → items conversion", () => {
    it("converts additionalItems: false to items: false", () => {
      const schema = {
        type: "array",
        additionalItems: false,
      };
      expect(normalizeAnthropicSchema(schema)).toEqual({
        type: "array",
        items: false,
      });
    });

    it("converts additionalItems schema to items", () => {
      const schema = {
        type: "array",
        additionalItems: { type: "string" },
      };
      expect(normalizeAnthropicSchema(schema)).toEqual({
        type: "array",
        items: { type: "string" },
      });
    });

    it("does not overwrite existing items when converting additionalItems", () => {
      const schema = {
        type: "array",
        items: { type: "number" },
        additionalItems: { type: "string" },
      };
      expect(normalizeAnthropicSchema(schema)).toEqual({
        type: "array",
        items: { type: "number" },
      });
    });

    it("converts both items tuple and additionalItems together", () => {
      const schema = {
        type: "array",
        items: [{ type: "number" }, { type: "number" }],
        additionalItems: false,
      };
      expect(normalizeAnthropicSchema(schema)).toEqual({
        type: "array",
        prefixItems: [{ type: "number" }, { type: "number" }],
        items: false,
      });
    });
  });

  describe("nested schema recursion", () => {
    it("normalizes tuple items deeply nested in properties", () => {
      const schema = {
        type: "object",
        properties: {
          coords: {
            type: "array",
            items: [{ type: "number" }, { type: "number" }],
            additionalItems: false,
          },
        },
      };
      expect(normalizeAnthropicSchema(schema)).toEqual({
        type: "object",
        properties: {
          coords: {
            type: "array",
            prefixItems: [{ type: "number" }, { type: "number" }],
            items: false,
          },
        },
      });
    });

    it("normalizes tuple items inside anyOf", () => {
      const schema = {
        type: "object",
        properties: {
          value: {
            anyOf: [{ type: "array", items: [{ type: "number" }] }, { type: "string" }],
          },
        },
      };
      expect(normalizeAnthropicSchema(schema)).toEqual({
        type: "object",
        properties: {
          value: {
            anyOf: [{ type: "array", prefixItems: [{ type: "number" }] }, { type: "string" }],
          },
        },
      });
    });

    it("normalizes tuple items inside oneOf and allOf", () => {
      const schema = {
        oneOf: [{ type: "array", items: [{ type: "number" }], additionalItems: false }],
        allOf: [
          { type: "object", properties: { arr: { type: "array", items: [{ type: "string" }] } } },
        ],
      };
      expect(normalizeAnthropicSchema(schema)).toEqual({
        oneOf: [{ type: "array", prefixItems: [{ type: "number" }], items: false }],
        allOf: [
          {
            type: "object",
            properties: { arr: { type: "array", prefixItems: [{ type: "string" }] } },
          },
        ],
      });
    });

    it("normalizes tuple items inside $defs", () => {
      const schema = {
        $defs: {
          point: {
            type: "array",
            items: [{ type: "number" }, { type: "number" }],
            additionalItems: false,
          },
        },
      };
      expect(normalizeAnthropicSchema(schema)).toEqual({
        $defs: {
          point: {
            type: "array",
            prefixItems: [{ type: "number" }, { type: "number" }],
            items: false,
          },
        },
      });
    });

    it("normalizes additionalItems inside properties map values", () => {
      const schema = {
        type: "object",
        properties: {
          arr: { type: "array", additionalItems: { type: "number" } },
        },
      };
      expect(normalizeAnthropicSchema(schema)).toEqual({
        type: "object",
        properties: {
          arr: { type: "array", items: { type: "number" } },
        },
      });
    });

    it("handles deep nesting through multiple schema constructs", () => {
      const schema = {
        type: "object",
        properties: {
          outer: {
            anyOf: [
              {
                properties: {
                  inner: {
                    type: "array",
                    items: [{ type: "number" }, { type: "string" }],
                  },
                },
              },
            ],
          },
        },
      };
      expect(normalizeAnthropicSchema(schema)).toEqual({
        type: "object",
        properties: {
          outer: {
            anyOf: [
              {
                properties: {
                  inner: {
                    type: "array",
                    prefixItems: [{ type: "number" }, { type: "string" }],
                  },
                },
              },
            ],
          },
        },
      });
    });
  });
});
