import { describe, expect, it } from "vitest";
import { __testing } from "./tool-schema-compat.js";

const { cleanSchemaForMoonshot, findBooleanSchemaViolations } = __testing;

describe("cleanSchemaForMoonshot", () => {
  it("converts plain boolean type to string enum", () => {
    expect(cleanSchemaForMoonshot({ type: "boolean" })).toEqual({
      type: "string",
      enum: ["true", "false"],
    });
  });

  it("preserves description when converting boolean", () => {
    expect(cleanSchemaForMoonshot({ type: "boolean", description: "Enable feature" })).toEqual({
      type: "string",
      enum: ["true", "false"],
      description: "Enable feature",
    });
  });

  it("converts boolean variant inside anyOf (TypeBox Optional pattern)", () => {
    const schema = {
      anyOf: [{ type: "boolean" }, { type: "null" }],
    };
    expect(cleanSchemaForMoonshot(schema)).toEqual({
      anyOf: [{ type: "string", enum: ["true", "false"] }, { type: "null" }],
    });
  });

  it("converts boolean variant inside anyOf with description", () => {
    const schema = {
      anyOf: [{ type: "boolean", description: "Toggle" }, { type: "null" }],
      description: "Optional toggle",
    };
    expect(cleanSchemaForMoonshot(schema)).toEqual({
      anyOf: [{ type: "string", enum: ["true", "false"], description: "Toggle" }, { type: "null" }],
      description: "Optional toggle",
    });
  });

  it("recursively converts boolean in nested object properties", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        enabled: { type: "boolean" },
        nested: {
          type: "object",
          properties: {
            debug: { type: "boolean", description: "Debug mode" },
          },
        },
      },
    };
    const result = cleanSchemaForMoonshot(schema) as Record<string, unknown>;
    const props = result.properties as Record<string, Record<string, unknown>>;

    expect(props.name).toEqual({ type: "string" });
    expect(props.enabled).toEqual({ type: "string", enum: ["true", "false"] });

    const nestedProps = props.nested.properties as Record<string, Record<string, unknown>>;
    expect(nestedProps.debug).toEqual({
      type: "string",
      enum: ["true", "false"],
      description: "Debug mode",
    });
  });

  it("converts boolean in array items", () => {
    const schema = {
      type: "array",
      items: { type: "boolean" },
    };
    expect(cleanSchemaForMoonshot(schema)).toEqual({
      type: "array",
      items: { type: "string", enum: ["true", "false"] },
    });
  });

  it("converts boolean inside oneOf and allOf", () => {
    expect(cleanSchemaForMoonshot({ oneOf: [{ type: "boolean" }, { type: "string" }] })).toEqual({
      oneOf: [{ type: "string", enum: ["true", "false"] }, { type: "string" }],
    });
    expect(cleanSchemaForMoonshot({ allOf: [{ type: "boolean" }] })).toEqual({
      allOf: [{ type: "string", enum: ["true", "false"] }],
    });
  });

  it("converts boolean inside tuple-style items array", () => {
    const schema = {
      type: "array",
      items: [{ type: "boolean" }, { type: "string" }],
    };
    expect(cleanSchemaForMoonshot(schema)).toEqual({
      type: "array",
      items: [{ type: "string", enum: ["true", "false"] }, { type: "string" }],
    });
  });

  it("leaves non-boolean schemas unchanged", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string", description: "Name" },
        count: { type: "number", minimum: 1 },
      },
      required: ["name"],
    };
    expect(cleanSchemaForMoonshot(schema)).toEqual(schema);
  });

  it("passes through primitives and nulls", () => {
    expect(cleanSchemaForMoonshot(null)).toBeNull();
    expect(cleanSchemaForMoonshot(undefined)).toBeUndefined();
    expect(cleanSchemaForMoonshot("string")).toBe("string");
    expect(cleanSchemaForMoonshot(42)).toBe(42);
  });
});

describe("findBooleanSchemaViolations", () => {
  it("reports plain boolean type", () => {
    const violations = findBooleanSchemaViolations({ type: "boolean" }, "tool.parameters");
    expect(violations).toEqual(["tool.parameters.type=boolean"]);
  });

  it("reports boolean inside anyOf", () => {
    const violations = findBooleanSchemaViolations(
      { anyOf: [{ type: "boolean" }, { type: "null" }] },
      "tool.parameters",
    );
    expect(violations).toEqual(["tool.parameters.anyOf[0].type=boolean"]);
  });

  it("reports boolean in nested properties", () => {
    const violations = findBooleanSchemaViolations(
      {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
        },
      },
      "tool.parameters",
    );
    expect(violations).toEqual(["tool.parameters.properties.enabled.type=boolean"]);
  });

  it("returns empty for non-boolean schemas", () => {
    const violations = findBooleanSchemaViolations(
      {
        type: "object",
        properties: {
          name: { type: "string" },
        },
      },
      "tool.parameters",
    );
    expect(violations).toEqual([]);
  });
});
