import { describe, expect, it } from "vitest";
import { cleanSchemaForGemini } from "./clean-for-gemini.js";

const object = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: "object",
  properties,
  ...extra,
});

describe("cleanSchemaForGemini", () => {
  it.each([
    [
      "removes required when no fields match properties",
      object({ action: { type: "string" } }, { required: ["missing_a", "missing_b"] }),
      object({ action: { type: "string" } }),
    ],
    [
      "removes required when properties is absent",
      { type: "object", required: ["a", "b"] },
      { type: "object" },
    ],
    [
      "coerces nested null properties while preserving valid siblings",
      object({ bad: { type: "object", properties: null }, good: { type: "string" } }),
      object({ bad: object({}), good: { type: "string" } }),
    ],
    [
      "collapses type arrays by stripping null entries",
      { type: ["string", "null"], description: "nullable field" },
      { type: "string", description: "nullable field" },
    ],
    [
      "selects the first non-null type from a mixed type array",
      { type: ["null", "string", "number"], description: "table cell", default: "" },
      { type: "string", description: "table cell", default: "" },
    ],
    [
      "omits type when a type array contains only null",
      { type: ["null"], description: "empty choice" },
      { description: "empty choice" },
    ],
    ["omits an empty type array", { type: [], title: "Empty" }, { title: "Empty" }],
    [
      "stringifies an integer const before type without changing the schema type",
      { const: 42, type: "integer" },
      { enum: ["42"], type: "integer" },
    ],
    [
      "returns no enum key when array becomes empty after coercion",
      { type: "integer", enum: [null, undefined, {}] },
      { type: "integer" },
    ],
  ])("%s", (_name, input, expected) => {
    expect(cleanSchemaForGemini(input)).toStrictEqual(expected);
  });

  it.each(["anyOf", "oneOf"])("simplifies %s without losing outer metadata", (keyword) => {
    for (const { variants, expected } of [
      {
        variants: [
          { type: "string", const: "compact" },
          { type: "string", const: "wide" },
        ],
        expected: { type: "string", enum: ["compact", "wide"] },
      },
      {
        variants: [{ type: "null" }, { type: "string", description: "inner" }],
        expected: { type: "string", description: "outer" },
      },
      {
        variants: [{ type: "string" }, { type: "integer" }],
        expected: { type: "string" },
      },
    ]) {
      expect(
        cleanSchemaForGemini({ [keyword]: variants, description: "outer", title: "Choice" }),
      ).toStrictEqual({ ...expected, description: "outer", title: "Choice" });
    }
  });

  it("strips empty required arrays in nested schemas", () => {
    const nested = object({ optional: { type: "string" } });
    expect(
      cleanSchemaForGemini(
        object({ nested: { ...nested, required: [] } }, { required: ["nested"] }),
      ),
    ).toStrictEqual(object({ nested }, { required: ["nested"] }));
  });

  it("stringifies nested numeric enums while preserving their number type", () => {
    const cleaned = cleanSchemaForGemini(
      object({
        outer: {
          type: "array",
          items: object({ score: { type: "number", enum: [1, 2, 3, 4, 5] } }),
        },
      }),
    );
    expect(cleaned).toHaveProperty("properties.outer.items.properties.score", {
      type: "number",
      enum: ["1", "2", "3", "4", "5"],
    });
  });

  it("preserves the type behind a percent-encoded local schema reference", () => {
    const filter = object({ limit: { type: "number" } });
    expect(
      cleanSchemaForGemini(
        object(
          { filter: { $ref: "#%2F%24defs%2FFilter%7E1value%7E0" } },
          { $defs: { "Filter/value~": filter } },
        ),
      ),
    ).toStrictEqual(object({ filter }));
  });

  it("resolves same-named definitions in the namespace named by each reference", () => {
    expect(
      cleanSchemaForGemini({
        type: "object",
        $defs: { Value: { type: "string" } },
        definitions: { Value: { type: "integer" } },
        properties: {
          modern: { $ref: "#/$defs/Value" },
          legacy: { $ref: "#/definitions/Value" },
        },
      }),
    ).toStrictEqual({
      type: "object",
      properties: { modern: { type: "string" }, legacy: { type: "integer" } },
    });
  });

  it("preserves shared definitions across inline and reference traversal", () => {
    const node = object({ next: { $ref: "#/$defs/Node" } });
    expect(
      cleanSchemaForGemini(object({ head: node }, { $defs: { Node: node }, required: ["head"] })),
    ).toStrictEqual(
      object({ head: object({ next: object({ next: {} }) }) }, { required: ["head"] }),
    );
  });
});
