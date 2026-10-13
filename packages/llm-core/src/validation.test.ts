import { Type, type TSchema } from "typebox";
import { describe, expect, it } from "vitest";
import type { Tool } from "./types.js";
import { validateToolArguments } from "./validation.js";

function validator(name: string, parameters: Tool["parameters"]) {
  const tool: Tool = { name, description: "", parameters };
  return (args: Record<string, unknown>) =>
    validateToolArguments(tool, { type: "toolCall", id: "call", name, arguments: args });
}

const validateDecimal = validator("decimal-tool", {
  type: "object",
  properties: { amount: { type: "number" }, count: { type: "integer" } },
  required: ["amount", "count"],
  additionalProperties: false,
});

describe("validateToolArguments", () => {
  it.each([
    { label: "a missing required field", value: {} },
    { label: "an invalid field type", value: { leaf: "invalid" } },
  ])("formats escaped container names for $label", ({ value }) => {
    const tool: Tool = {
      name: "diagnostic-path",
      description: "test tool",
      parameters: Type.Object({
        "room/~1%2F": Type.Object({ leaf: Type.Number() }),
      }),
    };

    expect(() =>
      validateToolArguments(tool, {
        type: "toolCall",
        id: "diagnostic-path-call",
        name: tool.name,
        arguments: { "room/~1%2F": value },
      }),
    ).toThrow("  - room.~1%2F.leaf:");
  });

  it.each(["anyOf", "oneOf", "TypeBox"])(
    "preserves accepted %s values before coercing other branches or sibling fields",
    (form) => {
      const cases: { branches: TSchema[]; value: unknown }[] = [
        { branches: [Type.Number(), Type.String()], value: "00123" },
        { branches: [Type.String(), Type.Number()], value: 42 },
        { branches: [Type.String(), Type.Boolean()], value: false },
        { branches: [Type.Array(Type.Integer()), Type.String()], value: '["2"]' },
        {
          branches: [Type.Object({ id: Type.Integer() }), Type.Object({ id: Type.String() })],
          value: { id: "00123" },
        },
      ];
      for (const { branches, value } of cases) {
        for (const alternatives of [branches, branches.toReversed()]) {
          const schema = form === "TypeBox" ? Type.Union(alternatives) : { [form]: alternatives };
          const validate = validator("union-value", {
            type: "object",
            properties: { value: schema, count: { type: "integer" } },
            required: ["value", "count"],
          });
          const input = { value: structuredClone(value), count: "2" };
          expect(validate(input)).toEqual({ value, count: 2 });
          expect(input).toEqual({ value, count: "2" });
        }
      }
    },
  );

  it.each(["anyOf", "oneOf"])(
    "recovers unmatched %s branches while preserving accepted nested values",
    (keyword) => {
      const validate = validator("nested-union", {
        type: "object",
        properties: {
          value: {
            [keyword]: [
              {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { [keyword]: [{ type: "number" }, { type: "string" }] },
                    count: { type: "integer" },
                  },
                  required: ["id", "count"],
                },
              },
              { type: "boolean" },
            ],
          },
        },
      });
      expect(validate({ value: [{ id: "00123", count: "2" }] })).toEqual({
        value: [{ id: "00123", count: 2 }],
      });
      expect(validate({ value: "true" })).toEqual({ value: true });
      expect(() => validate({ value: [{ id: "00123", count: "invalid" }] })).toThrow(
        /Validation failed/,
      );
    },
  );

  it("keeps invalid non-null values out of nullable integer schemas", () => {
    for (const union of [
      "anyOf",
      "oneOf",
      "TypeBox",
      "type-array integer/null",
      "type-array null/integer",
    ]) {
      const validateArgs = validator(
        "nullable-limit",
        union === "TypeBox"
          ? Type.Object({
              limit: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
            })
          : {
              type: "object",
              properties: {
                limit:
                  union === "type-array integer/null"
                    ? { type: ["integer", "null"], minimum: 1 }
                    : union === "type-array null/integer"
                      ? { type: ["null", "integer"], minimum: 1 }
                      : { [union]: [{ type: "integer", minimum: 1 }, { type: "null" }] },
              },
            },
      );
      const validate = (limit: unknown) => validateArgs({ limit });
      expect(validate(null)).toEqual({ limit: null });
      expect(validate(1)).toEqual({ limit: 1 });
      expect(validate("2")).toEqual({ limit: 2 });
      for (const limit of [0, false, "", -1, "invalid"]) {
        expect(() => validate(limit)).toThrow(/Validation failed for tool "nullable-limit"/);
      }
      // TypeBox recovers fractional integers by truncating; JSON Schema rejects them.
      if (union === "TypeBox") {
        expect(validate(1.5)).toEqual({ limit: 1 });
      } else {
        expect(() => validate(1.5)).toThrow(/Validation failed for tool "nullable-limit"/);
      }
    }
  });

  it.each([
    { name: "object/null", types: ["object", "null"] },
    { name: "null/object", types: ["null", "object"] },
  ])("keeps invalid non-null values out of a $name type array", ({ types }) => {
    const validateArgs = validator("nullable-parent", {
      type: "object",
      properties: {
        parent: {
          type: types,
          properties: {
            kind: { type: "string", enum: ["page"] },
            count: { type: "integer", minimum: 1 },
          },
          required: ["kind", "count"],
          additionalProperties: false,
        },
      },
      required: ["parent"],
      additionalProperties: false,
    });
    const validate = (parent: unknown) => validateArgs({ parent });
    expect(validate(null)).toEqual({ parent: null });
    const parent = { kind: "page", count: "2" };
    for (const input of [parent, JSON.stringify(parent)]) {
      expect(validate(input)).toEqual({ parent: { kind: "page", count: 2 } });
    }
    for (const input of [false, 0, "", [], { kind: "wrong", count: 2 }]) {
      expect(() => validate(input)).toThrow(/Validation failed for tool "nullable-parent"/);
    }
  });

  it("preserves nullable scalar values and null-only coercions", () => {
    const numbers = [
      ["2.5", 2.5],
      [false, 0],
      [0, 0],
    ] as const;
    const strings = [
      [false, "false"],
      [0, "0"],
      ["", ""],
      ["existing", "existing"],
    ] as const;
    const nulls = [
      [false, null],
      [0, null],
      ["", null],
    ] as const;
    const cases: [Tool["parameters"], readonly (readonly [unknown, unknown])[]][] = [
      [{ type: ["number", "null"] }, numbers],
      [{ type: ["null", "number"] }, numbers],
      [{ type: ["string", "null"] }, strings],
      [{ type: ["null", "string"] }, strings],
      [{ type: "null" }, nulls],
      [{ type: ["null"] }, nulls],
    ];
    for (const [schema, conversions] of cases) {
      const validate = validator("nullable-value", {
        type: "object",
        properties: { value: schema },
        required: ["value"],
      });
      expect(validate({ value: null })).toEqual({ value: null });
      for (const [input, output] of conversions) {
        expect(validate({ value: input })).toEqual({ value: output });
      }
    }
  });

  it("coerces strict decimal strings and rejects non-decimal JSON-schema numbers", () => {
    for (const validate of [
      validateDecimal,
      validator("decimal-tool", Type.Object({ amount: Type.Number(), count: Type.Integer() })),
    ]) {
      expect(validate({ amount: "1e3", count: "+3" })).toEqual({ amount: 1000, count: 3 });
    }
    for (const input of [
      { amount: "0x10", count: 3 },
      { amount: 16, count: "0b10" },
    ]) {
      expect(() => validateDecimal(input)).toThrow(/Validation failed for tool "decimal-tool"/);
    }
  });

  it("coerces additional properties without changing declared string fields", () => {
    const validate = validator("additional-integers", {
      type: "object",
      properties: { label: { type: "string" }, count: { type: "integer" } },
      required: ["label", "count"],
      additionalProperties: { type: "integer" },
    });
    const input = { label: "1e2", count: "1", extra: "2" };
    expect(validate(input)).toEqual({ label: "1e2", count: 1, extra: 2 });
    expect(input).toEqual({ label: "1e2", count: "1", extra: "2" });
  });

  it("retains TypeBox-specific record and numeric enum coercion", () => {
    const validate = validator(
      "typed-record",
      Type.Object({
        counts: Type.Record(Type.String(), Type.Integer()),
        choice: Type.Enum([1, 2]),
        limit: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
      }),
    );
    expect(validate({ counts: { first: "1" }, choice: "2", limit: null })).toEqual({
      counts: { first: 1 },
      choice: 2,
      limit: null,
    });
    expect(() => validate({ counts: { first: "1" }, choice: "2", limit: 0 })).toThrow(
      /Validation failed for tool "typed-record"/,
    );
  });

  it("preserves an accepted union value during TypeBox record recovery", () => {
    const tool: Tool = {
      name: "union-record",
      description: "Preserve a string while recovering record values",
      parameters: Type.Object({
        value: Type.Union([Type.Number(), Type.String()]),
        counts: Type.Record(Type.String(), Type.Integer()),
      }),
    };
    expect(
      validateToolArguments(tool, {
        type: "toolCall",
        id: "union-record-call",
        name: tool.name,
        arguments: { value: "00123", counts: { first: "1" } },
      }),
    ).toEqual({ value: "00123", counts: { first: 1 } });
  });

  it("still rejects values accepted by multiple oneOf branches", () => {
    const tool: Tool = {
      name: "exclusive-union",
      description: "Require exactly one matching branch",
      parameters: {
        type: "object",
        properties: { value: { oneOf: [{ type: "number" }, { type: "integer" }] } },
      },
    };
    expect(() =>
      validateToolArguments(tool, {
        type: "toolCall",
        id: "exclusive-call",
        name: tool.name,
        arguments: { value: 1 },
      }),
    ).toThrow(/Validation failed/);
  });

  it("preserves null in anyOf [{type: string}, {type: null}] without coercing to empty string (#96716)", () => {
    const validate = validator("nullable-tool", {
      type: "object",
      properties: {
        insight_id: { anyOf: [{ type: "string" }, { type: "null" }] },
        cluster_name: { type: "string" },
      },
      required: ["cluster_name"],
      additionalProperties: false,
    });
    expect(validate({ insight_id: null, cluster_name: "testenv" })).toEqual({
      insight_id: null,
      cluster_name: "testenv",
    });
  });
});

describe("validateToolArguments — root references", () => {
  function validate(parameters: Tool["parameters"], value: unknown) {
    return validator("refs", parameters)({ value });
  }

  it.each(["anyOf", "oneOf"])("preserves values accepted by a referenced %s branch", (keyword) => {
    const parameters = {
      type: "object",
      properties: {
        value: { [keyword]: [{ $ref: "#/$defs/number" }, { $ref: "#/$defs/text" }] },
      },
      $defs: { number: { type: "number" }, text: { type: "string" } },
    };
    expect(validate(parameters, "00123")).toEqual({ value: "00123" });
  });

  it.each(["anyOf", "oneOf"])("checks %s alternatives in their root context", (keyword) => {
    const parameters = {
      type: "object",
      properties: {
        value: { [keyword]: [{ $ref: "#/$defs/positive" }, { $ref: "#/$defs/absent" }] },
      },
      $defs: {
        positive: { $ref: "#/$defs/limit~1value~0" },
        "limit/value~": { type: "integer", minimum: 1 },
        absent: { type: "null" },
      },
    };
    expect(validate(parameters, null)).toEqual({ value: null });
    expect(validate(parameters, "2")).toEqual({ value: 2 });
    for (const invalid of [0, false, "", -1, "invalid"]) {
      expect(() => validate(parameters, invalid)).toThrow(/Validation failed/);
    }
  });

  it("preserves TypeBox refinements when choosing a coercion alternative", () => {
    const value = Type.Union([Type.Refine(Type.Number(), (number) => number >= 10), Type.String()]);
    for (const options of [{}, { $defs: { unused: { type: "string" } } }]) {
      const parameters = Type.Object({ value }, options);
      expect(validate(parameters, "02")).toEqual({ value: "02" });
      const recoverable = Type.Object(
        {
          value: Type.Union([Type.Refine(Type.Number(), (number) => number >= 10), Type.Boolean()]),
        },
        options,
      );
      expect(() => validate(recoverable, "02")).toThrow(/Validation failed/);
      expect(validate(recoverable, "12")).toEqual({ value: 12 });
    }
  });

  it("coerces URI-fragment and JSON-pointer encoded definitions", () => {
    for (const [name, ref] of [
      ["Partial<Filter>", "#/definitions/Partial<Filter>"],
      ["Partial<Filter>", "#/definitions/Partial%3CFilter%3E"],
      ["Partial<Filter>", "#%2Fdefinitions%2FPartial%3CFilter%3E"],
      ["Filter/value~", "#%2Fdefinitions%2FFilter%7E1value%7E0"],
      ["Filter%2Fvalue", "#/definitions/Filter%252Fvalue"],
    ] as const) {
      const parameters = {
        type: "object",
        properties: { value: { $ref: ref } },
        definitions: {
          [name]: { type: "object", properties: { limit: { type: "number" } } },
        },
      };
      expect(validate(parameters, { limit: "5" }), ref).toEqual({ value: { limit: 5 } });
      expect(() => validate(parameters, { limit: "invalid" })).toThrow(/Validation failed/);
    }
  });

  it("keeps union branch validators bound to each tool's root", () => {
    const branch = { anyOf: [{ $ref: "#/$defs/value" }, { type: "null" }] };
    for (const type of ["array", "object", "array"]) {
      const definition =
        type === "array"
          ? { type, items: { type: "integer" } }
          : { type, properties: { count: { type: "integer" } } };
      const parameters = {
        type: "object",
        properties: { value: branch },
        $defs: { value: definition },
      };
      expect(validate(parameters, type === "array" ? '["2"]' : '{"count":"2"}')).toEqual({
        value: type === "array" ? [2] : { count: 2 },
      });
    }
  });

  it("coerces recursive definitions at distinct data locations and preserves siblings", () => {
    const node = { $ref: "#/$defs/node" };
    const parameters = {
      type: "object",
      properties: { value: { ...node, maxProperties: 2 } },
      $defs: {
        node: {
          type: "object",
          properties: {
            count: { type: "integer" },
            next: node,
            children: { type: "array", items: node },
            named: { type: "object", additionalProperties: node },
          },
          required: ["count"],
          additionalProperties: false,
        },
      },
    };
    const input = {
      count: "1",
      children: [
        '{"count":"2","next":{"count":"3"}}',
        { count: "4", named: { last: '{"count":"5"}' } },
      ],
    };
    expect(validate(parameters, JSON.stringify(input))).toEqual({
      value: {
        count: 1,
        children: [
          { count: 2, next: { count: 3 } },
          { count: 4, named: { last: { count: 5 } } },
        ],
      },
    });
    expect(() => validate(parameters, { count: "1", next: { count: "2" }, children: [] })).toThrow(
      /must NOT have more than|must not have more than/i,
    );
  });

  it("applies reference siblings without dropping their coercion or validation", () => {
    const parameters = {
      type: "object",
      properties: {
        value: {
          $ref: "#/$defs/base",
          properties: { enabled: { type: "boolean" } },
          required: ["enabled"],
        },
      },
      $defs: {
        base: { type: "object", properties: { count: { type: "integer" } }, required: ["count"] },
      },
    };
    expect(validate(parameters, '{"enabled":"true","count":"2"}')).toEqual({
      value: { enabled: true, count: 2 },
    });
    expect(() => validate(parameters, '{"count":"2"}')).toThrow(/enabled/);
  });

  it("does not resolve scoped references against an outer definition table", () => {
    const parameters = {
      type: "object",
      properties: {
        value: {
          $id: "https://example.invalid/scoped",
          type: "object",
          properties: { text: { $ref: "#/$defs/item" }, free: true },
          $defs: { item: { type: "string" } },
        },
      },
      $defs: { item: { type: "array", items: { type: "integer" } } },
    };
    expect(validate(parameters, { text: "[1]", free: "[2]" })).toEqual({
      value: { text: "[1]", free: "[2]" },
    });
  });

  it("coerces references inside tuple and allOf schemas", () => {
    const parameters = {
      type: "object",
      properties: { value: { allOf: [{ $ref: "#/$defs/tuple" }] } },
      $defs: {
        tuple: { type: "array", items: [{ $ref: "#/$defs/count" }, { $ref: "#/$defs/tags" }] },
        count: { type: "integer" },
        tags: { type: "array", items: { type: "string" } },
      },
    };
    expect(validate(parameters, ["2", '["a","b"]'])).toEqual({ value: [2, ["a", "b"]] });
  });

  it("keeps invalid and oversized strings out of referenced containers", () => {
    for (const definition of [
      { type: "array", items: { type: "integer" } },
      { type: "object", properties: { count: { type: "integer" } }, required: ["count"] },
    ]) {
      const parameters = {
        type: "object",
        properties: { value: { $ref: "#/$defs/value" } },
        $defs: { value: definition },
      };
      for (const invalid of [
        "not-json",
        "false",
        "null",
        definition.type === "array" ? '{"not":"array"}' : "[]",
        " ".repeat(64 * 1024) + (definition.type === "array" ? "[1]" : '{"count":1}'),
      ]) {
        expect(() => validate(parameters, invalid)).toThrow(/Validation failed/);
      }
    }
  });
});
