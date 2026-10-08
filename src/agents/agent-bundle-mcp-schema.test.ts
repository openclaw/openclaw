/** MCP schema normalization and external catalog validation semantics. */
import { describe, expect, it } from "vitest";
import { createBundleMcpJsonSchemaValidator } from "./agent-bundle-mcp-runtime.js";

describe("session MCP runtime", () => {
  it("accepts draft-2020-12 tool output schemas from external MCP catalogs", () => {
    const validator = createBundleMcpJsonSchemaValidator().getValidator<{
      format: string;
      metadata: { format: string };
      nullable: { x?: string } | null;
      url: string;
    }>({
      $schema: "https://json-schema.org/draft/2020-12/schema",
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

    expect(
      validator({
        format: "png",
        metadata: { format: "png" },
        nullable: null,
        url: "not a uri",
      }),
    ).toEqual({
      valid: true,
      data: {
        format: "png",
        metadata: { format: "png" },
        nullable: null,
        url: "not a uri",
      },
      errorMessage: undefined,
    });
    expect(validator({ url: 42 }).valid).toBe(false);

    const dependencyValidator = createBundleMcpJsonSchemaValidator().getValidator({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      dependencies: {
        url: {
          properties: {
            url: {
              type: "string",
              format: "uri",
            },
          },
          required: ["url"],
        },
      },
    });
    expect(dependencyValidator({ url: "not a uri" }).valid).toBe(true);

    const mapValidator = createBundleMcpJsonSchemaValidator().getValidator({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: {
        type: "string",
      },
    });
    expect(mapValidator({ foo: "bar" }).valid).toBe(true);
    expect(mapValidator({ foo: 42 }).valid).toBe(false);
  });

  it.each([
    { $schema: undefined, validFormat: false },
    { $schema: "http://json-schema.org/draft-07/schema#", validFormat: false },
    { $schema: "https://json-schema.org/draft/2020-12/schema", validFormat: true },
  ])(
    "preserves format and non-mutating validation semantics for $schema",
    ({ $schema, validFormat }) => {
      const schema = {
        ...($schema ? { $schema } : {}),
        type: "object",
        properties: {
          url: { type: "string", format: "uri" },
          count: { type: "integer", default: 7 },
        },
        required: ["url"],
        additionalProperties: false,
      };
      const originalSchema = structuredClone(schema);
      const validator = createBundleMcpJsonSchemaValidator().getValidator(schema);
      const input = { url: "not a uri" };
      expect(validator(input).valid).toBe(validFormat);
      const validInput = { url: "https://example.test" };
      expect(validator(validInput).data).toBe(validInput);
      expect(validInput).toEqual({ url: "https://example.test" });
      expect(validator({ url: "https://example.test", count: "7" }).valid).toBe(false);
      expect(schema).toEqual(originalSchema);
    },
  );

  it("rejects invalid draft-2020-12 tool output schemas from external MCP catalogs", () => {
    for (const schema of [
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "sting",
      },
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        required: "url",
      },
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "string",
        minLength: "1",
      },
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: [],
      },
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        allOf: [],
      },
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        anyOf: [],
      },
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        oneOf: [],
      },
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $ref: "#/$defs/Missing",
      },
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $dynamicRef: 123,
      },
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $dynamicRef: "#/$defs/Missing",
      },
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "string",
        nullable: "yes",
      },
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        nullable: true,
      },
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $defs: {
          Other: {
            $id: "other",
            $anchor: "value",
            type: "string",
          },
        },
        $ref: "#value",
      },
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        dependencies: {
          mode: 123,
        },
      },
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        dependencies: {
          mode: [1],
        },
      },
    ] as const) {
      expect(() => createBundleMcpJsonSchemaValidator().getValidator(schema as never)).toThrow(
        "Invalid MCP draft-2020-12 JSON Schema",
      );
    }
  });

  it("reports malformed annotation formats at their original schema path", () => {
    expect(() =>
      createBundleMcpJsonSchemaValidator().getValidator({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          node: {
            type: ["object", "null"],
            // Deliberately malformed external schema must reach runtime shape validation.
            $defs: { Leaf: { type: "string", format: 42 as never } },
          },
        },
      }),
    ).toThrow(
      expect.objectContaining({
        message: expect.stringContaining("<schema>.properties.node.$defs.Leaf.format"),
        cause: expect.any(Error),
      }),
    );
  });

  it("accepts draft-2020-12 local refs to boolean schemas and anchors", () => {
    const neverValidator = createBundleMcpJsonSchemaValidator().getValidator({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: {
        Never: false,
      },
      $ref: "#/$defs/Never",
    });
    expect(neverValidator("anything").valid).toBe(false);

    const anchorValidator = createBundleMcpJsonSchemaValidator().getValidator({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: {
        Value: {
          $anchor: "value",
          type: "string",
        },
      },
      $ref: "#value",
    });
    expect(anchorValidator("ok").valid).toBe(true);
    expect(anchorValidator(1).valid).toBe(false);

    const nestedAnchorValidator = createBundleMcpJsonSchemaValidator().getValidator({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: {
        Other: {
          $id: "other",
          $defs: {
            Value: {
              $anchor: "value",
              type: "string",
            },
          },
          $ref: "#value",
        },
      },
      $ref: "#/$defs/Other",
    });
    expect(nestedAnchorValidator("ok").valid).toBe(true);
    expect(nestedAnchorValidator(1).valid).toBe(false);

    const absoluteRefValidator = createBundleMcpJsonSchemaValidator().getValidator({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://example.com/schema",
      $defs: {
        Value: {
          type: "string",
        },
      },
      $ref: "https://example.com/schema#/$defs/Value",
    });
    expect(absoluteRefValidator("ok").valid).toBe(true);
    expect(absoluteRefValidator(1).valid).toBe(false);

    const emptyIdRefValidator = createBundleMcpJsonSchemaValidator().getValidator({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "",
      $defs: {
        Value: {
          type: "string",
        },
      },
      $ref: "#/$defs/Value",
    });
    expect(emptyIdRefValidator("ok").valid).toBe(true);
    expect(emptyIdRefValidator(1).valid).toBe(false);

    const dynamicRefValidator = createBundleMcpJsonSchemaValidator().getValidator({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: {
        Value: {
          $dynamicAnchor: "value",
          type: "string",
        },
      },
      $dynamicRef: "#value",
    });
    expect(dynamicRefValidator("ok").valid).toBe(true);
    expect(dynamicRefValidator(1).valid).toBe(false);
  });

  it("attributes draft-2020-12 compiler failures to the MCP schema", () => {
    let thrown: unknown;
    try {
      createBundleMcpJsonSchemaValidator().getValidator({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          value: { type: "string", pattern: "[" },
        },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      message: expect.stringContaining(
        "Invalid MCP draft-2020-12 JSON Schema: Invalid regular expression",
      ),
      cause: expect.any(Error),
    });
  });

  it("compiles draft-2020-12 patterns with redundant unicode-invalid escapes", () => {
    const validator = createBundleMcpJsonSchemaValidator().getValidator({
      $schema: "https://json-schema.org/draft/2020-12/schema",
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

  it("accepts draft-2020-12 local refs into schema arrays", () => {
    const validator = createBundleMcpJsonSchemaValidator().getValidator({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      anyOf: [{ type: "string" }],
      $ref: "#/anyOf/0",
    });
    expect(validator("ok").valid).toBe(true);
    expect(validator(1).valid).toBe(false);
  });

  it("accepts draft-2020-12 local refs to anchors inside dependency schemas", () => {
    const validator = createBundleMcpJsonSchemaValidator().getValidator({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      dependencies: {
        a: {
          $defs: {
            Target: {
              $anchor: "target",
              type: "object",
            },
          },
        },
        b: {
          properties: {
            b: {
              $ref: "#target",
            },
          },
          required: ["b"],
        },
      },
    });
    expect(validator({ a: {}, b: {} }).valid).toBe(true);
    expect(validator({ a: {}, b: 1 }).valid).toBe(false);
  });
});
