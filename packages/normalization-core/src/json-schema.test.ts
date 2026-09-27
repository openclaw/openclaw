import { Compile } from "typebox/schema";
import { describe, expect, it } from "vitest";
import { normalizeJsonSchemaForTypeBox, normalizeTypeBoxValidationErrors } from "./json-schema.js";

describe("normalizeJsonSchemaForTypeBox", () => {
  it("removes only schema format keywords when annotations are requested", () => {
    const formatted = { type: "string", format: "uri" };
    const schema = {
      $defs: { format: formatted },
      definitions: { format: formatted },
      properties: { format: formatted },
      patternProperties: { format: formatted },
      dependentSchemas: { format: { properties: { value: formatted } } },
      dependencies: { format: ["format"], value: { properties: { format: formatted } } },
      allOf: [{ properties: { nested: formatted } }],
      anyOf: [formatted],
      oneOf: [formatted],
      prefixItems: [formatted],
      items: formatted,
      additionalItems: formatted,
      contains: formatted,
      additionalProperties: formatted,
      propertyNames: formatted,
      unevaluatedProperties: formatted,
      unevaluatedItems: formatted,
      if: formatted,
      // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema conditional keyword, not a Promise method.
      then: formatted,
      else: formatted,
      not: formatted,
      const: { format: "literal" },
      enum: [{ format: "literal" }],
      default: { format: "literal" },
      examples: [{ format: "literal" }],
    };
    const original = structuredClone(schema);
    const stripped = { type: "string" };
    expect(normalizeJsonSchemaForTypeBox(schema)).toEqual(original);
    expect(normalizeJsonSchemaForTypeBox(schema, { format: "annotation" })).toEqual({
      $defs: { format: stripped },
      definitions: { format: stripped },
      properties: { format: stripped },
      patternProperties: { format: stripped },
      dependentSchemas: { format: { properties: { value: stripped } } },
      dependencies: { format: ["format"], value: { properties: { format: stripped } } },
      allOf: [{ properties: { nested: stripped } }],
      anyOf: [stripped],
      oneOf: [stripped],
      prefixItems: [stripped],
      items: stripped,
      additionalItems: stripped,
      contains: stripped,
      additionalProperties: stripped,
      propertyNames: stripped,
      unevaluatedProperties: stripped,
      unevaluatedItems: stripped,
      if: stripped,
      // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema conditional keyword, not a Promise method.
      then: stripped,
      else: stripped,
      not: stripped,
      const: { format: "literal" },
      enum: [{ format: "literal" }],
      default: { format: "literal" },
      examples: [{ format: "literal" }],
    });
    expect(schema).toEqual(original);
  });
});

describe("normalizeTypeBoxValidationErrors", () => {
  it("keeps actionable nested property errors and unrelated false schemas", () => {
    const validator = Compile({
      type: "object",
      properties: {
        nested: {
          type: "object",
          properties: { forbidden: false },
          additionalProperties: false,
        },
      },
    });
    const [, errors] = validator.Errors({ nested: { forbidden: true, "slash/tilde~": true } });
    const original = [...errors];

    const normalized = normalizeTypeBoxValidationErrors(errors);

    expect(normalized).toHaveLength(2);
    expect(normalized).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyword: "boolean", instancePath: "/nested/forbidden" }),
        expect.objectContaining({
          keyword: "additionalProperties",
          instancePath: "/nested",
          params: { additionalProperties: ["slash/tilde~"] },
        }),
      ]),
    );
    const sourceIndexes = normalized.map((error) => errors.indexOf(error));
    expect(sourceIndexes).toEqual(sourceIndexes.toSorted((left, right) => left - right));
    expect(errors).toEqual(original);
    expect(normalized.every((error) => errors.includes(error))).toBe(true);
  });

  it("preserves false property-name constraints at the same data path", () => {
    const validator = Compile({
      type: "object",
      propertyNames: false,
      additionalProperties: false,
    });
    const [, errors] = validator.Errors({ unexpected: true });

    const normalized = normalizeTypeBoxValidationErrors(errors);
    expect(normalized).toHaveLength(3);
    expect(normalized).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyword: "boolean", schemaPath: "#/propertyNames" }),
        expect.objectContaining({ keyword: "additionalProperties", instancePath: "" }),
        expect.objectContaining({ keyword: "propertyNames", instancePath: "" }),
      ]),
    );
  });

  it("preserves child errors when a bounded error list omits the aggregate", () => {
    const validator = Compile({ type: "object", additionalProperties: false });
    const [, errors] = validator.Errors({ unexpected: true });
    const children = errors.filter((error) => error.keyword === "boolean");
    expect(children.length).toBeGreaterThan(0);

    expect(normalizeTypeBoxValidationErrors(children)).toEqual(children);
  });

  it("keeps genuine failures when literal property names collide with nested raw paths", () => {
    const validator = Compile({
      type: "object",
      properties: {
        "a/additionalProperties": false,
        a: { type: "object", additionalProperties: false },
      },
    });
    const [, errors] = validator.Errors({
      "a/additionalProperties": true,
      a: { additionalProperties: true },
    });

    const normalized = normalizeTypeBoxValidationErrors(errors);
    expect(normalized).toHaveLength(2);
    expect(normalized[0]).toBe(errors[0]);
    expect(normalized[1]).toBe(errors.at(-1));
  });

  it.each([false, true])(
    "keeps colliding genuine errors beside typed properties (nested=%s)",
    (nested) => {
      const validator = Compile({
        type: "object",
        properties: {
          "a/additionalProperties": false,
          a: {
            type: "object",
            properties: {},
            additionalProperties: nested ? { allOf: [{ type: "string" }] } : { type: "string" },
          },
        },
      });
      const [, errors] = validator.Errors({
        "a/additionalProperties": true,
        a: { additionalProperties: 47 },
      });

      expect(normalizeTypeBoxValidationErrors(errors)).toEqual(errors);
    },
  );
});
