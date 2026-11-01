import { describe, expect, it } from "vitest";
import { cleanSchemaForGemini } from "./clean-for-gemini.js";

const object = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: "object",
  properties,
  ...extra,
});
const string = { type: "string" };

describe("cleanSchemaForGemini", () => {
  it.each([
    [
      "unmatched required",
      object({ action: string }, { required: ["missing"] }),
      object({ action: string }),
    ],
    ["required without properties", { type: "object", required: ["a"] }, { type: "object" }],
    [
      "null properties and valid siblings",
      object({ bad: { type: "object", properties: null }, good: string }),
      object({ bad: object({}), good: string }),
    ],
    ["nullable", { type: ["string", "null"], description: "x" }, { ...string, description: "x" }],
    ["first type", { type: ["null", "string", "number"], default: "" }, { ...string, default: "" }],
    ["null-only", { type: ["null"], description: "x" }, { description: "x" }],
    ["empty type", { type: [], title: "Empty" }, { title: "Empty" }],
    ["integer const", { const: 42, type: "integer" }, { enum: ["42"], type: "integer" }],
    [
      "empty enum after coercion",
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
          { ...string, const: "a" },
          { ...string, const: "b" },
        ],
        expected: { ...string, enum: ["a", "b"] },
      },
      { variants: [{ type: "null" }, { ...string, description: "inner" }], expected: string },
      { variants: [string, { type: "integer" }], expected: string },
    ]) {
      expect(
        cleanSchemaForGemini({ [keyword]: variants, description: "outer", title: "Choice" }),
      ).toStrictEqual({ ...expected, description: "outer", title: "Choice" });
    }
  });

  it("strips empty required arrays in nested schemas", () => {
    const nested = object({ optional: string });
    expect(
      cleanSchemaForGemini(
        object({ nested: { ...nested, required: [] } }, { required: ["nested"] }),
      ),
    ).toStrictEqual(object({ nested }, { required: ["nested"] }));
  });

  it("stringifies nested numeric enums while preserving their number type", () => {
    const cleaned = cleanSchemaForGemini(
      object({
        outer: { type: "array", items: object({ score: { type: "number", enum: [1, 2] } }) },
      }),
    );
    expect(cleaned).toHaveProperty("properties.outer.items.properties.score", {
      type: "number",
      enum: ["1", "2"],
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
      cleanSchemaForGemini(
        object(
          {
            modern: { $ref: "#/$defs/Value" },
            legacy: { $ref: "#/definitions/Value" },
          },
          { $defs: { Value: string }, definitions: { Value: { type: "integer" } } },
        ),
      ),
    ).toStrictEqual(object({ modern: string, legacy: { type: "integer" } }));
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
