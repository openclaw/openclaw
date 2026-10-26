import type { JsonSchemaType, JsonSchemaValidator } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpJsonSchemaValidator } from "./mcp-json-schema-validator.js";

type Schema = JsonSchemaType & { nullable?: boolean; enumIncludesNull?: boolean };
const profile = vi.hoisted(() => ({ value: "dynamic-execution" }));
vi.mock("../../standalone-runtime-profile.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../standalone-runtime-profile.mjs")>()),
  getRuntimeExecutionProfile: () => profile.value,
}));
afterEach(() => vi.restoreAllMocks());

function expectValidation(
  validate: JsonSchemaValidator<unknown>,
  valid: unknown,
  invalid: unknown,
) {
  expect([validate(valid).valid, validate(invalid).valid]).toEqual([true, false]);
}

describe.each(["dynamic-execution", "embedded-aot"])("MCP validation on %s", (runtimeProfile) => {
  let provider: ReturnType<typeof createMcpJsonSchemaValidator>;
  beforeEach(() => {
    profile.value = runtimeProfile;
    provider = createMcpJsonSchemaValidator();
  });
  it("retains registered root and nested resource identities across schema acquisition", () => {
    const root = {
      $id: "https://example.test/schemas/",
      definitions: {
        text: { $id: "text", type: "string" },
        alias: { $id: "alias", $ref: "text" },
      },
    };
    provider.getValidator(root);
    const validate = provider.getValidator({
      $ref: "https://example.test/schemas/alias",
    });
    expectValidation(validate, "valid", 1);
    const existing = provider.getValidator({
      $id: "https://example.test/schemas/alias",
      type: "number",
    });
    expectValidation(existing, "valid", 1);
    const sameRoot = provider.getValidator({ ...root, type: "number" });
    expect(sameRoot("still unconstrained").valid).toBe(true);
  });

  it("preserves RFC reference resolution under an opaque URI scope", () => {
    provider.getValidator({
      $id: "urn:example:root",
      definitions: { value: { $id: "text", type: "string" } },
    });
    const validate = provider.getValidator({ $ref: "urn:text" });
    expectValidation(validate, "value", 1);
  });

  it("keeps legacy anchors and rejects ambiguous IDs within a document", () => {
    for (const anchor of ["$anchor", "$dynamicAnchor"]) {
      const validate = provider.getValidator({
        definitions: { value: { [anchor]: "value", type: "string" } },
        $ref: "#value",
      });
      expectValidation(validate, "valid", 1);
    }
    for (const type of ["string", "number"]) {
      expect(() =>
        provider.getValidator({
          $id: "https://example.test/ambiguous",
          definitions: {
            a: { $id: "value", type: "string" },
            b: { $id: "value", type },
          },
          $ref: "value",
        }),
      ).toThrow(/more than one schema/);
    }
  });

  it("keeps acquired checks stable while replacing an unacquired resource alias", () => {
    const first = provider.getValidator({
      $id: "https://example.test/first",
      definitions: { value: { $id: "value", type: "string" } },
      $ref: "value",
    });
    const second = provider.getValidator({
      $id: "https://example.test/second",
      definitions: { value: { $id: "value", type: "number" } },
      $ref: "value",
    });
    expectValidation(first, "valid", 1);
    expectValidation(second, 1, "valid");
  });

  it("resolves relative root IDs, sibling resources, and encoded pointers", () => {
    provider.getValidator({
      $id: "schemas/",
      definitions: {
        "text/value": { $id: "text", type: "string" },
        alias: { $id: "alias", $ref: "text" },
      },
    });
    const references = ["schemas/alias"];
    // Ajv cannot acquire encoded pointers through a relative external root ID.
    if (runtimeProfile === "embedded-aot") {
      references.push("schemas/#%2Fdefinitions%2Ftext~1value");
    }
    for (const $ref of references) {
      const validate = provider.getValidator({ $ref });
      expectValidation(validate, "valid", 1);
    }
  });

  it("supports canonical draft-07 metaschema references and their historical alias", () => {
    for (const $ref of [
      "http://json-schema.org/draft-07/schema#",
      "http://json-schema.org/schema",
    ]) {
      const validate = provider.getValidator({ $ref });
      expect(validate({ definitions: { item: { type: "integer" } } }).valid).toBe(true);
      expect(validate({ definitions: { item: { type: 1 } } }).valid).toBe(false);
    }
  });

  it("preserves draft-07 fragment IDs alongside the containing resource", () => {
    const validate = provider.getValidator({
      $id: "https://example.test/anchored",
      definitions: {
        text: { $id: "#text", $ref: "#/definitions/value" },
        value: { type: "string" },
      },
      type: "object",
      properties: { value: { $ref: "#text" } },
      required: ["value"],
    });
    expectValidation(validate, { value: "valid" }, { value: 1 });
    expect(
      provider.getValidator({ $ref: "https://example.test/anchored#text" })("valid").valid,
    ).toBe(true);
  });

  it("keeps independently acquired modern schemas with the same ID independent", () => {
    const identity = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://example.test/reused",
    };
    const text = provider.getValidator({ ...identity, type: "string" });
    const number = provider.getValidator({ ...identity, type: "number" });
    expectValidation(text, "value", 1);
    expectValidation(number, 1, "value");
  });

  const contains = { type: "array", contains: { type: "number" }, minContains: 2 };
  const literal = { dependentRequired: { trigger: ["value"] }, format: "literal" };
  it.each<[Schema, unknown[], boolean[]]>([
    [
      {
        $id: "https://example.test/config",
        type: "object",
        definitions: { text: { type: "string" } },
        properties: { type: { type: "string" }, value: {} },
        dependencies: {
          type: { properties: { value: { $ref: "#/definitions/text" } }, required: ["value"] },
        },
      },
      [{ type: "trigger", value: "valid" }, { type: "trigger", value: 42 }, { type: "trigger" }],
      [true, false, false],
    ],
    [
      {
        $id: "https://example.test/sibling/base/",
        definitions: {
          sibling: { $id: "https://example.test/sibling/value.json", type: "string" },
          enclosing: { $id: "value.json", type: "number" },
        },
        allOf: [{ $id: "https://example.test/sibling/", $ref: "value.json" }],
      },
      ["legacy sibling", 1],
      [true, false],
    ],
    [contains, [[1]], [true]],
    [{ $schema: "https://json-schema.org/draft/2020-12/schema", ...contains }, [[1]], [false]],
    [{ const: literal }, [literal], [true]],
    [{ type: "string", format: "email" }, ["not an email"], [false]],
    [{ type: "integer", format: "int32" }, [2 ** 32], [false]],
    [{ type: "number", format: "int32" }, [1], [true]],
    [{ type: "string", format: "custom-format" }, ["value"], [true]],
    [{ type: "string", nullable: true }, [null], [true]],
    [{ type: "string", enum: ["value"], nullable: true, enumIncludesNull: true }, [null], [false]],
  ])("validates schema policy %j", (schema, inputs, expected) => {
    const validate = provider.getValidator(schema);
    expect(inputs.map((input) => validate(input).valid)).toEqual(expected);
  });
});

it("validates fetched schemas when string code generation is unavailable", () => {
  profile.value = "embedded-aot";
  const codegen = vi.spyOn(globalThis, "Function").mockImplementation(() => {
    throw new Error("string code generation is disabled");
  });
  const validator = createMcpJsonSchemaValidator().getValidator({
    type: "object",
    properties: { name: { type: "string", format: "email" } },
    required: ["name"],
    additionalProperties: false,
  });
  const results = [
    validator({ name: "test@example.com" }).valid,
    validator({ name: "invalid" }).valid,
  ];
  expect(codegen).not.toHaveBeenCalled();
  codegen.mockRestore();
  expect(results).toEqual([true, false]);
});
