import type { JsonSchemaType } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpJsonSchemaValidator } from "./mcp-json-schema-validator.js";

const profile = vi.hoisted(() => ({ value: "dynamic-execution" }));
vi.mock("../../standalone-runtime-profile.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../standalone-runtime-profile.mjs")>()),
  getRuntimeExecutionProfile: () => profile.value,
}));
afterEach(() => vi.restoreAllMocks());

describe.each(["dynamic-execution", "embedded-aot"])("MCP validation on %s", (runtimeProfile) => {
  beforeEach(() => {
    profile.value = runtimeProfile;
  });
  it("resolves dependency refs even when the dependency key is a schema keyword", () => {
    const validate = createMcpJsonSchemaValidator().getValidator({
      $id: "https://example.test/config",
      type: "object",
      definitions: { text: { type: "string" } },
      properties: { type: { type: "string" }, value: {} },
      dependencies: {
        type: { properties: { value: { $ref: "#/definitions/text" } }, required: ["value"] },
      },
    });
    expect(validate({ type: "trigger", value: "valid" }).valid).toBe(true);
    expect(validate({ type: "trigger", value: 42 }).valid).toBe(false);
    expect(validate({ type: "trigger" }).valid).toBe(false);
  });

  it("retains registered root and nested resource identities across schema acquisition", () => {
    const provider = createMcpJsonSchemaValidator();
    const root = {
      $id: "https://example.test/schemas/",
      definitions: {
        text: { $id: "text", type: "string" },
        alias: { $id: "alias", $ref: "text" },
      },
    };
    provider.getValidator(root);
    const validate = provider.getValidator({
      type: "object",
      properties: { value: { $ref: "https://example.test/schemas/alias" } },
      required: ["value"],
    });
    expect(validate({ value: "valid" }).valid).toBe(true);
    expect(validate({ value: 1 }).valid).toBe(false);
    const existing = provider.getValidator({
      $id: "https://example.test/schemas/alias",
      type: "number",
    });
    expect(existing("valid").valid).toBe(true);
    expect(existing(1).valid).toBe(false);
    const sameRoot = provider.getValidator({ ...root, type: "number" });
    expect(sameRoot("still unconstrained").valid).toBe(true);
  });

  it("preserves RFC reference resolution under an opaque URI scope", () => {
    const provider = createMcpJsonSchemaValidator();
    provider.getValidator({
      $id: "urn:example:root",
      definitions: { value: { $id: "text", type: "string" } },
    });
    const validate = provider.getValidator({ $ref: "urn:text" });
    expect(validate("value").valid).toBe(true);
    expect(validate(1).valid).toBe(false);
  });

  it("keeps legacy anchors and rejects ambiguous IDs within a document", () => {
    const provider = createMcpJsonSchemaValidator();
    for (const anchor of ["$anchor", "$dynamicAnchor"]) {
      const validate = provider.getValidator({
        definitions: { value: { [anchor]: "value", type: "string" } },
        $ref: "#value",
      });
      expect(validate("valid").valid).toBe(true);
      expect(validate(1).valid).toBe(false);
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
    const provider = createMcpJsonSchemaValidator();
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
    expect(first("valid").valid).toBe(true);
    expect(first(1).valid).toBe(false);
    expect(second(1).valid).toBe(true);
    expect(second("valid").valid).toBe(false);
  });

  it("resolves relative root IDs, sibling resources, and encoded pointers", () => {
    const provider = createMcpJsonSchemaValidator();
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
      expect(validate("valid").valid).toBe(true);
      expect(validate(1).valid).toBe(false);
    }
  });

  it("supports canonical draft-07 metaschema references and their historical alias", () => {
    const provider = createMcpJsonSchemaValidator();
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
    const provider = createMcpJsonSchemaValidator();
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
    expect(validate({ value: "valid" }).valid).toBe(true);
    expect(validate({ value: 1 }).valid).toBe(false);
    expect(
      provider.getValidator({ $ref: "https://example.test/anchored#text" })("valid").valid,
    ).toBe(true);
  });

  it("keeps independently acquired modern schemas with the same ID independent", () => {
    const provider = createMcpJsonSchemaValidator();
    const identity = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://example.test/reused",
    };
    const text = provider.getValidator({ ...identity, type: "string" });
    const number = provider.getValidator({ ...identity, type: "number" });
    expect(text("value").valid).toBe(true);
    expect(text(1).valid).toBe(false);
    expect(number("value").valid).toBe(false);
    expect(number(1).valid).toBe(true);
  });

  it("preserves legacy reference rebasing through a sibling ID", () => {
    const validate = createMcpJsonSchemaValidator().getValidator({
      $id: "https://example.test/sibling/base/",
      definitions: {
        sibling: { $id: "https://example.test/sibling/value.json", type: "string" },
        enclosing: { $id: "value.json", type: "number" },
      },
      allOf: [{ $id: "https://example.test/sibling/", $ref: "value.json" }],
    });
    expect(validate("legacy sibling").valid).toBe(true);
    expect(validate(1).valid).toBe(false);
  });

  it("keeps draft-07 ignored keywords separate from draft-2020-12 assertions", () => {
    const provider = createMcpJsonSchemaValidator();
    const schema = { type: "array", contains: { type: "number" }, minContains: 2 };
    expect(provider.getValidator(schema)([1]).valid).toBe(true);
    expect(
      provider.getValidator({ $schema: "https://json-schema.org/draft/2020-12/schema", ...schema })(
        [1],
      ).valid,
    ).toBe(false);
    const literal = { dependentRequired: { trigger: ["value"] }, format: "literal" };
    expect(provider.getValidator({ const: literal })(literal).valid).toBe(true);
  });

  it("asserts known string and number formats while treating unknown formats as annotations", () => {
    const provider = createMcpJsonSchemaValidator();
    expect(provider.getValidator({ type: "string", format: "email" })("not an email").valid).toBe(
      false,
    );
    expect(provider.getValidator({ type: "integer", format: "int32" })(2 ** 32).valid).toBe(false);
    expect(provider.getValidator({ type: "number", format: "int32" })(1).valid).toBe(true);
    expect(provider.getValidator({ type: "string", format: "custom-format" })("value").valid).toBe(
      true,
    );
    const nullable = { type: "string", nullable: true } satisfies JsonSchemaType & {
      nullable: boolean;
    };
    expect(provider.getValidator(nullable)(null).valid).toBe(true);
    const nullableEnum = {
      type: "string",
      enum: ["value"],
      nullable: true,
      enumIncludesNull: true,
    } satisfies JsonSchemaType & { nullable: boolean; enumIncludesNull: boolean };
    expect(provider.getValidator(nullableEnum)(null).valid).toBe(false);
  });

  it("does not retain evaluated properties between modern inputs", () => {
    const validate = createMcpJsonSchemaValidator().getValidator({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      anyOf: [{ properties: { a: { type: "number" } } }, { properties: { b: { type: "number" } } }],
      unevaluatedProperties: false,
    });
    expect(validate({ a: 1 }).valid).toBe(true);
    expect(validate({ a: "invalid" }).valid).toBe(false);
    expect(validate({ b: 2 }).valid).toBe(true);
    expect(validate({ b: "invalid" }).valid).toBe(false);
  });
});

describe("MCP without string code generation", () => {
  beforeEach(() => {
    profile.value = "embedded-aot";
  });
  it("validates fetched schemas when string code generation is unavailable", () => {
    const codegen = vi.spyOn(globalThis, "Function").mockImplementation(() => {
      throw new Error("string code generation is disabled");
    });
    let results: boolean[];
    try {
      const validator = createMcpJsonSchemaValidator().getValidator({
        type: "object",
        properties: { name: { type: "string", format: "email" } },
        required: ["name"],
        additionalProperties: false,
      });
      results = [
        validator({ name: "test@example.com" }).valid,
        validator({ name: "invalid" }).valid,
      ];
      expect(codegen).not.toHaveBeenCalled();
    } finally {
      codegen.mockRestore();
    }
    expect(results).toEqual([true, false]);
  });
});
