import { describe, expect, test } from "vitest";
import { cleanSchemaForGemini } from "./clean-for-gemini.js";

describe("cleanSchemaForGemini", () => {
  describe("tryFlattenLiteralAnyOf with single-element type arrays", () => {
    test("flattens anyOf with type as string", () => {
      const schema = {
        anyOf: [
          { type: "string", const: "foo" },
          { type: "string", const: "bar" },
        ],
      };

      const result = cleanSchemaForGemini(schema);

      expect(result).toEqual({
        type: "string",
        enum: ["foo", "bar"],
      });
    });

    test("flattens anyOf with type as single-element array", () => {
      const schema = {
        anyOf: [
          { type: ["string"], const: "foo" },
          { type: ["string"], const: "bar" },
        ],
      };

      const result = cleanSchemaForGemini(schema);

      expect(result).toEqual({
        type: "string",
        enum: ["foo", "bar"],
      });
    });

    test("flattens mixed string and single-element array types", () => {
      const schema = {
        anyOf: [
          { type: "string", const: "foo" },
          { type: ["string"], const: "bar" },
          { type: "string", const: "baz" },
        ],
      };

      const result = cleanSchemaForGemini(schema);

      expect(result).toEqual({
        type: "string",
        enum: ["foo", "bar", "baz"],
      });
    });

    test("does not flatten when types differ", () => {
      const schema = {
        anyOf: [
          { type: ["string"], const: "foo" },
          { type: ["number"], const: 42 },
        ],
      };

      const result = cleanSchemaForGemini(schema);

      // Should not flatten mismatched types
      expect(result).toHaveProperty("anyOf");
      expect(result).not.toHaveProperty("enum");
    });

    test("handles multi-element type arrays with null stripping", () => {
      const schema = {
        anyOf: [
          { type: ["string", "null"], const: "foo" },
          { type: ["string", "null"], const: "bar" },
        ],
      };

      const result = cleanSchemaForGemini(schema);

      // cleanSchemaForGemini strips null variants and normalizes ["string", "null"] to "string"
      // So this should successfully flatten
      expect(result).toEqual({
        type: "string",
        enum: ["foo", "bar"],
      });
    });
  });
});
