import { expect, it } from "vitest";
import { createMcpJsonSchemaValidator } from "./mcp-json-schema-validator.js";

type Schema = Parameters<ReturnType<typeof createMcpJsonSchemaValidator>["getValidator"]>[0];
const compile = (schema: Schema) => createMcpJsonSchemaValidator().getValidator(schema);
const compileDraft = (schema: Schema) =>
  compile({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...schema,
  });
const uri = { type: "string", format: "uri" };

it("accepts draft-2020-12 tool output schemas from external MCP catalogs", () => {
  const validator = compileDraft({
    type: "object",
    properties: {
      nullable: {
        type: ["object", "null"],
        properties: { x: { type: "string" } },
        additionalProperties: false,
      },
      url: uri,
    },
    required: ["nullable", "url"],
    additionalProperties: false,
  });

  const input = { nullable: null, url: "not a uri" };
  expect(validator(input)).toEqual({ valid: true, data: input, errorMessage: undefined });
  expect(validator({ url: 42 }).valid).toBe(false);

  const mapValidator = compileDraft({ type: "object", additionalProperties: { type: "string" } });
  expect(mapValidator({ foo: "bar" }).valid).toBe(true);
  expect(mapValidator({ foo: 42 }).valid).toBe(false);
});

it("preserves draft-07 format and non-mutating validation semantics", () => {
  const schema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
      url: uri,
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

it.each<[string, Schema["properties"]]>([
  [
    "<schema>.properties.node.$defs.Leaf.format",
    {
      node: { type: ["object", "null"], $defs: { Leaf: { type: "string", format: 42 as never } } },
    },
  ],
  [
    "Invalid MCP draft-2020-12 JSON Schema: Invalid regular expression",
    {
      value: { type: "string", pattern: "[" },
    },
  ],
])("reports %s", (message, properties) => {
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
    type: "string",
    pattern: "^https\\:\\/\\/",
  });

  expect(validator("https://example.com/path").valid).toBe(true);
  expect(validator("http://example.com").valid).toBe(false);
});
