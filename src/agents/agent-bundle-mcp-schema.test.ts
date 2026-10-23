import { expect, it } from "vitest";
import { createBundleMcpJsonSchemaValidator } from "./agent-bundle-mcp-runtime.js";

type Schema = Parameters<ReturnType<typeof createBundleMcpJsonSchemaValidator>["getValidator"]>[0];
const compile = (schema: Schema) => createBundleMcpJsonSchemaValidator().getValidator(schema);
const compileDraft = (schema: Schema) =>
  compile({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...schema,
  });

it("accepts draft-2020-12 tool output schemas from external MCP catalogs", () => {
  const validator = compileDraft({
    type: "object",
    properties: {
      format: { type: "string", enum: ["png"] },
      metadata: { const: { format: "png" } },
      nullable: {
        type: ["object", "null"],
        properties: { x: { type: "string" } },
        additionalProperties: false,
      },
      url: { type: "string", format: "uri" },
    },
    required: ["format", "metadata", "nullable", "url"],
    additionalProperties: false,
  });

  const input = { format: "png", metadata: { format: "png" }, nullable: null, url: "not a uri" };
  expect(validator(input)).toEqual({ valid: true, data: input, errorMessage: undefined });
  expect(validator({ url: 42 }).valid).toBe(false);

  const dependencyValidator = compileDraft({
    type: "object",
    dependencies: {
      url: {
        properties: {
          url: { type: "string", format: "uri" },
        },
        required: ["url"],
      },
    },
  });
  expect(dependencyValidator({ url: "not a uri" }).valid).toBe(true);

  const mapValidator = compileDraft({
    type: "object",
    additionalProperties: { type: "string" },
  });
  expect(mapValidator({ foo: "bar" }).valid).toBe(true);
  expect(mapValidator({ foo: 42 }).valid).toBe(false);
});

it("preserves draft-07 format and non-mutating validation semantics", () => {
  const schema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
      url: { type: "string", format: "uri" },
      count: { type: "integer", default: 7 },
    },
    required: ["url"],
    additionalProperties: false,
  };
  const originalSchema = structuredClone(schema);
  const validator = compile(schema);
  expect(validator({ url: "not a uri" }).valid).toBe(false);
  const validInput = { url: "https://example.test" };
  expect(validator(validInput).data).toBe(validInput);
  expect(validInput).toEqual({ url: "https://example.test" });
  expect(validator({ url: "https://example.test", count: "7" }).valid).toBe(false);
  expect(schema).toEqual(originalSchema);
});

it.each<{ name: string; properties: Schema["properties"]; message: string }>([
  {
    name: "malformed annotation at its original path",
    properties: {
      node: {
        type: ["object", "null"],
        // Deliberately malformed external schema must reach runtime shape validation.
        $defs: { Leaf: { type: "string", format: 42 as never } },
      },
    },
    message: "<schema>.properties.node.$defs.Leaf.format",
  },
  {
    name: "compiler failure attributed to the MCP schema",
    properties: { value: { type: "string", pattern: "[" } },
    message: "Invalid MCP draft-2020-12 JSON Schema: Invalid regular expression",
  },
])("reports $name", ({ properties, message }) => {
  expect(() => compileDraft({ type: "object", properties })).toThrow(
    expect.objectContaining({
      message: expect.stringContaining(message),
      cause: expect.any(Error),
    }),
  );
});

it("accepts draft-2020-12 local refs, boolean schemas, and dynamic anchors", () => {
  const neverValidator = compileDraft({
    $defs: { Never: false },
    $ref: "#/$defs/Never",
  });
  expect(neverValidator("anything").valid).toBe(false);

  for (const [anchor, ref] of [
    ["$anchor", "$ref"],
    ["$dynamicAnchor", "$dynamicRef"],
  ] as const) {
    const validator = compileDraft({
      $defs: { Value: { [anchor]: "value", type: "string" } },
      [ref]: "#value",
    });
    expect(validator("ok").valid).toBe(true);
    expect(validator(1).valid).toBe(false);
  }
});

it("compiles draft-2020-12 patterns with redundant unicode-invalid escapes", () => {
  const validator = compileDraft({
    type: "object",
    properties: {
      url: { type: "string", pattern: "^https\\:\\/\\/" },
    },
    required: ["url"],
    additionalProperties: false,
  });

  expect(validator({ url: "https://example.com/path" }).valid).toBe(true);
  expect(validator({ url: "http://example.com" }).valid).toBe(false);
});
