// LLM Core tests cover validation behavior.
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { Tool } from "./types.js";
import { validateToolArguments } from "./validation.js";

const decimalTool = {
  name: "decimal-tool",
  description: "test tool",
  parameters: {
    type: "object",
    properties: {
      amount: { type: "number" },
      count: { type: "integer" },
    },
    required: ["amount", "count"],
    additionalProperties: false,
  },
} as Tool;

const decimalTools = [
  { label: "JSON Schema", tool: decimalTool },
  {
    label: "TypeBox",
    tool: {
      ...decimalTool,
      parameters: Type.Object({ amount: Type.Number(), count: Type.Integer() }),
    },
  },
];

describe("validateToolArguments", () => {
  it.each(["anyOf", "oneOf", "TypeBox", "type-array integer/null", "type-array null/integer"])(
    "keeps invalid non-null values out of a nullable integer %s",
    (union) => {
      const tool: Tool = {
        name: "nullable-limit",
        description: "Search with an optional result limit",
        parameters:
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
      };
      const validate = (limit: unknown) =>
        validateToolArguments(tool, {
          type: "toolCall",
          id: "nullable-limit-call",
          name: tool.name,
          arguments: { limit },
        });
      expect(validate(null)).toEqual({ limit: null });
      expect(validate(1)).toEqual({ limit: 1 });
      expect(validate("2")).toEqual({ limit: 2 });
      for (const limit of [0, false, "", -1, "invalid"]) {
        expect(() => validate(limit)).toThrow(/Validation failed for tool "nullable-limit"/);
      }
      // TypeBox's existing integer recovery truncates numbers; plain JSON-schema
      // coercion does not. Neither behavior should be replaced by null fallback.
      if (union === "TypeBox") {
        expect(validate(1.5)).toEqual({ limit: 1 });
      } else {
        expect(() => validate(1.5)).toThrow(/Validation failed for tool "nullable-limit"/);
      }
    },
  );

  it.each([
    { name: "object/null", types: ["object", "null"] },
    { name: "null/object", types: ["null", "object"] },
  ])("keeps invalid non-null values out of a $name type array", ({ types }) => {
    const tool: Tool = {
      name: "nullable-parent",
      description: "Accept an object or null without replacing rejected scalar input",
      parameters: {
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
      },
    };
    const validate = (parent: unknown) =>
      validateToolArguments(tool, {
        type: "toolCall",
        id: "nullable-parent-call",
        name: tool.name,
        arguments: { parent },
      });

    expect(validate(null)).toEqual({ parent: null });
    const parent = { kind: "page", count: "2" };
    for (const input of [parent, JSON.stringify(parent)]) {
      expect(validate(input)).toEqual({ parent: { kind: "page", count: 2 } });
    }
    for (const input of [false, 0, "", [], { kind: "wrong", count: 2 }]) {
      expect(() => validate(input)).toThrow(/Validation failed for tool "nullable-parent"/);
    }
  });

  const numericConversions = [
    { input: "2.5", output: 2.5 },
    { input: false, output: 0 },
    { input: 0, output: 0 },
  ];
  const stringConversions = [
    { input: false, output: "false" },
    { input: 0, output: "0" },
    { input: "", output: "" },
    { input: "existing", output: "existing" },
  ];

  it.each([
    { name: "number/null", types: ["number", "null"], conversions: numericConversions },
    { name: "null/number", types: ["null", "number"], conversions: numericConversions },
    { name: "string/null", types: ["string", "null"], conversions: stringConversions },
    { name: "null/string", types: ["null", "string"], conversions: stringConversions },
  ])("retains valid non-null coercions in a $name type array", ({ types, conversions }) => {
    const tool: Tool = {
      name: "nullable-value",
      description: "Keep conversions into a supported non-null alternative",
      parameters: {
        type: "object",
        properties: { value: { type: types } },
        required: ["value"],
      },
    };
    const validate = (value: unknown) =>
      validateToolArguments(tool, {
        type: "toolCall",
        id: "nullable-value-call",
        name: tool.name,
        arguments: { value },
      });

    expect(validate(null)).toEqual({ value: null });
    for (const { input, output } of conversions) {
      expect(validate(input)).toEqual({ value: output });
    }
  });

  it.each([
    { name: "a null type", type: "null" },
    { name: "a single-member null type array", type: ["null"] },
  ])("preserves existing coercion for $name", ({ type }) => {
    const tool: Tool = {
      name: "null-only",
      description: "Retain the existing null-only conversion contract",
      parameters: {
        type: "object",
        properties: { value: { type } },
        required: ["value"],
      },
    };

    for (const value of [null, false, 0, ""]) {
      expect(
        validateToolArguments(tool, {
          type: "toolCall",
          id: "null-only-call",
          name: tool.name,
          arguments: { value },
        }),
      ).toEqual({ value: null });
    }
  });

  it.each(decimalTools)("coerces strict decimal numeric strings for $label", ({ tool }) => {
    expect(
      validateToolArguments(tool, {
        type: "toolCall",
        id: "call-1",
        name: "decimal-tool",
        arguments: { amount: "1e3", count: "+3" },
      }),
    ).toEqual({ amount: 1000, count: 3 });
  });

  it("rejects non-decimal numeric strings for plain JSON schemas", () => {
    for (const input of [
      { amount: "0x10", count: 3 },
      { amount: 16, count: "0b10" },
    ]) {
      expect(() =>
        validateToolArguments(decimalTool, {
          type: "toolCall",
          id: "call-1",
          name: "decimal-tool",
          arguments: input,
        }),
      ).toThrow(/Validation failed for tool "decimal-tool"/);
    }
  });

  it("coerces additional properties without changing declared string fields", () => {
    const tool: Tool = {
      name: "additional-integers",
      description: "Keep declared fields separate from additional properties",
      parameters: {
        type: "object",
        properties: {
          label: { type: "string" },
          count: { type: "integer" },
        },
        required: ["label", "count"],
        additionalProperties: { type: "integer" },
      },
    };
    const input = { label: "1e2", count: "1", extra: "2" };

    expect(
      validateToolArguments(tool, {
        type: "toolCall",
        id: "additional-integers-call",
        name: tool.name,
        arguments: input,
      }),
    ).toEqual({ label: "1e2", count: 1, extra: 2 });
    expect(input).toEqual({ label: "1e2", count: "1", extra: "2" });
  });

  it("retains TypeBox-specific record and numeric enum coercion", () => {
    const tool: Tool = {
      name: "typed-record",
      description: "Typed record and enum tool",
      parameters: Type.Object({
        counts: Type.Record(Type.String(), Type.Integer()),
        choice: Type.Enum([1, 2]),
        limit: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
      }),
    };
    expect(
      validateToolArguments(tool, {
        type: "toolCall",
        id: "typed-record-call",
        name: tool.name,
        arguments: { counts: { first: "1" }, choice: "2", limit: null },
      }),
    ).toEqual({ counts: { first: 1 }, choice: 2, limit: null });
    expect(() =>
      validateToolArguments(tool, {
        type: "toolCall",
        id: "typed-record-invalid-call",
        name: tool.name,
        arguments: { counts: { first: "1" }, choice: "2", limit: 0 },
      }),
    ).toThrow(/Validation failed for tool "typed-record"/);
  });

  it("preserves null in anyOf [{type: string}, {type: null}] without coercing to empty string (#96716)", () => {
    const tool = {
      name: "nullable-tool",
      description: "test tool",
      parameters: {
        type: "object",
        properties: {
          insight_id: { anyOf: [{ type: "string" }, { type: "null" }] },
          cluster_name: { type: "string" },
        },
        required: ["cluster_name"],
        additionalProperties: false,
      },
    } as Tool;

    expect(
      validateToolArguments(tool, {
        type: "toolCall",
        id: "call-1",
        name: "nullable-tool",
        arguments: { insight_id: null, cluster_name: "testenv" },
      }),
    ).toEqual({ insight_id: null, cluster_name: "testenv" });
  });
});

const arrayTool = {
  name: "array-tool",
  description: "test tool with array param",
  parameters: {
    type: "object",
    properties: {
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["tags"],
    additionalProperties: false,
  },
} as Tool;

const objectTool = {
  name: "object-tool",
  description: "test tool with object param",
  parameters: {
    type: "object",
    properties: {
      config: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          retries: { type: "number" },
        },
      },
    },
    required: ["config"],
    additionalProperties: false,
  },
} as Tool;

describe("validateToolArguments — stringified JSON coercion", () => {
  it.each([
    { label: "serialized", input: '["test","debug"]', expected: ["test", "debug"] },
    { label: "native", input: ["already", "array"], expected: ["already", "array"] },
  ])("validates $label array arguments for plain JSON schemas", ({ input, expected }) => {
    expect(
      validateToolArguments(arrayTool, {
        type: "toolCall",
        id: "call-2",
        name: "array-tool",
        arguments: { tags: input },
      }),
    ).toEqual({ tags: expected });
  });

  it.each([
    {
      label: "serialized",
      input: '{"enabled":true,"retries":3}',
      expected: { enabled: true, retries: 3 },
    },
    {
      label: "native",
      input: { enabled: false, retries: 1 },
      expected: { enabled: false, retries: 1 },
    },
  ])("validates $label object arguments for plain JSON schemas", ({ input, expected }) => {
    expect(
      validateToolArguments(objectTool, {
        type: "toolCall",
        id: "call-3",
        name: "object-tool",
        arguments: { config: input },
      }),
    ).toEqual({ config: expected });
  });

  it("rejects invalid JSON string for array param", () => {
    expect(() =>
      validateToolArguments(arrayTool, {
        type: "toolCall",
        id: "call-6",
        name: "array-tool",
        arguments: { tags: "not-json" },
      }),
    ).toThrow(/Validation failed for tool "array-tool"/);
  });

  it("rejects JSON string that is wrong type for array param", () => {
    expect(() =>
      validateToolArguments(arrayTool, {
        type: "toolCall",
        id: "call-7",
        name: "array-tool",
        arguments: { tags: '{"not":"array"}' },
      }),
    ).toThrow(/Validation failed for tool "array-tool"/);
  });

  it("skips JSON coercion for oversized array string", () => {
    const hugeArray = JSON.stringify(Array.from({ length: 100_000 }, (_, i) => i));
    expect(hugeArray.length).toBeGreaterThan(64 * 1024);
    expect(() =>
      validateToolArguments(arrayTool, {
        type: "toolCall",
        id: "call-8",
        name: "array-tool",
        arguments: { tags: hugeArray },
      }),
    ).toThrow(/Validation failed for tool "array-tool"/);
  });

  it("skips JSON coercion for oversized object string", () => {
    const hugeObj = JSON.stringify({ data: "x".repeat(70_000) });
    expect(hugeObj.length).toBeGreaterThan(64 * 1024);
    expect(() =>
      validateToolArguments(objectTool, {
        type: "toolCall",
        id: "call-9",
        name: "object-tool",
        arguments: { config: hugeObj },
      }),
    ).toThrow(/Validation failed for tool "object-tool"/);
  });
});

describe("validateToolArguments — root references", () => {
  function validate(parameters: Tool["parameters"], value: unknown) {
    return validateToolArguments(
      { name: "refs", description: "", parameters },
      {
        type: "toolCall",
        id: "refs-call",
        name: "refs",
        arguments: { value },
      },
    );
  }

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
        " ".repeat(64 * 1024) + (definition.type === "array" ? "[1]" : '{"count":1}'),
      ]) {
        expect(() => validate(parameters, invalid)).toThrow(/Validation failed/);
      }
    }
  });
});
