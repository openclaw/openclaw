import { Compile } from "typebox/schema";
import { expect, it } from "vitest";
import { normalizeJsonSchemaForTypeBox, normalizeTypeBoxValidationErrors } from "./json-schema.js";

it("removes only schema format keywords when annotations are requested", () => {
  const fields = (keys: string, value: unknown) =>
    Object.fromEntries(keys.split(" ").map((key) => [key, value]));
  const createSchema = (formatted: { type: string; format?: string }) => ({
    ...fields("$defs definitions properties patternProperties", { format: formatted }),
    dependentSchemas: { format: { properties: { value: formatted } } },
    dependencies: { format: ["format"], value: { properties: { format: formatted } } },
    allOf: [{ properties: { nested: formatted } }],
    ...fields("anyOf oneOf prefixItems", [formatted]),
    ...fields(
      "items additionalItems contains additionalProperties propertyNames unevaluatedProperties unevaluatedItems if then else not",
      formatted,
    ),
    ...fields("const default", { format: "literal" }),
    ...fields("enum examples", [{ format: "literal" }]),
  });
  const schema = createSchema({ type: "string", format: "uri" });
  const original = structuredClone(schema);
  expect(normalizeJsonSchemaForTypeBox(schema)).toEqual(original);
  expect(normalizeJsonSchemaForTypeBox(schema, { format: "annotation" })).toEqual(
    createSchema({ type: "string" }),
  );
  expect(schema).toEqual(original);
});

const collisionErrors = (nested: object, value: unknown) =>
  Compile({
    type: "object",
    properties: { "a/additionalProperties": false, a: nested },
  }).Errors({ "a/additionalProperties": true, a: { additionalProperties: value } })[1];
it("preserves false property-name constraints at the same data path", () => {
  const validator = Compile({
    type: "object",
    propertyNames: false,
    additionalProperties: false,
  });
  const [, errors] = validator.Errors({ "slash/tilde~": true });
  const original = [...errors];

  const normalized = normalizeTypeBoxValidationErrors(errors);
  expect(normalized).toHaveLength(3);
  expect(normalized).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ keyword: "boolean", schemaPath: "#/propertyNames" }),
      expect.objectContaining({ keyword: "additionalProperties", instancePath: "" }),
      expect.objectContaining({ keyword: "propertyNames", instancePath: "" }),
    ]),
  );
  const sourceIndexes = normalized.map((error) => errors.indexOf(error));
  expect(sourceIndexes).toEqual(sourceIndexes.toSorted((left, right) => left - right));
  expect(errors).toEqual(original);
  expect(normalized.every((error) => errors.includes(error))).toBe(true);
});

it("keeps genuine failures when literal property names collide with nested raw paths", () => {
  const errors = collisionErrors({ type: "object", additionalProperties: false }, true);

  const normalized = normalizeTypeBoxValidationErrors(errors);
  expect(normalized).toHaveLength(2);
  expect(normalized[0]).toBe(errors[0]);
  expect(normalized[1]).toBe(errors.at(-1));
});

it("keeps colliding genuine errors beside nested typed properties", () => {
  const errors = collisionErrors(
    {
      type: "object",
      properties: {},
      additionalProperties: { allOf: [{ type: "string" }] },
    },
    47,
  );

  expect(normalizeTypeBoxValidationErrors(errors)).toEqual(errors);
});
