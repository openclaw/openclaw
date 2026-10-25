import { Type, type TSchema } from "typebox";
import { Settings } from "typebox/system";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeExecutionProfile } from "../../../standalone-runtime-profile.mjs";
import type { Tool } from "./types.js";

let validateToolArguments: (typeof import("./validation.js"))["validateToolArguments"];

const runtimeProfile = vi.hoisted((): { value: RuntimeExecutionProfile } => ({
  value: "dynamic-execution",
}));
vi.mock("../../../standalone-runtime-profile.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../standalone-runtime-profile.mjs")>()),
  getRuntimeExecutionProfile: () => runtimeProfile.value,
}));

function validator(parameters: Tool["parameters"], name = "refs") {
  const tool: Tool = { name, description: "", parameters };
  return (args: Record<string, unknown>) =>
    validateToolArguments(tool, { type: "toolCall", id: "call", name, arguments: args });
}

function objectSchema(properties: Record<string, TSchema>, options: TSchema = {}): TSchema {
  return { type: "object", properties, ...options };
}

function objectValidator(properties: Record<string, TSchema>, options: TSchema = {}) {
  return validator(objectSchema(properties, options));
}

function closedObject(properties: Record<string, TSchema>) {
  return objectSchema(properties, {
    required: Object.keys(properties),
    additionalProperties: false,
  });
}

function valueValidator(value: TSchema, options: TSchema = {}) {
  return validator(objectSchema({ value }, options));
}

function rootValidator(value: TSchema, $defs: Record<string, TSchema>) {
  return valueValidator(value, { $defs });
}

function expectValue(validate: ReturnType<typeof validator>, value: unknown, expected: unknown) {
  expect(validate({ value })).toEqual({ value: expected });
}

const number = { type: "number" };
const integer = { type: "integer" };
const string = { type: "string" };
const boolean = { type: "boolean" };
const nil = { type: "null" };
const positiveInteger = { ...integer, minimum: 1 };
const optionalLimit = Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]));
const requiredCount = objectSchema({ count: integer }, { required: ["count"] });

const profiles = ["dynamic-execution", "embedded-aot"] as const;
describe.each(profiles)("validateToolArguments (%s)", (profile) => {
  const settings = Settings.Get();
  beforeEach(async () => {
    runtimeProfile.value = profile;
    Settings.Set({ useAcceleration: profile === "dynamic-execution" });
    vi.resetModules();
    ({ validateToolArguments } = await import("./validation.js"));
  });
  afterEach(() => Settings.Set(settings));

  it("does not retain evaluated properties between tool calls", () => {
    const validate = validator({
      anyOf: [
        { type: "object", properties: { a: number } },
        { type: "object", properties: { b: number } },
      ],
      unevaluatedProperties: false,
    });
    expect(validate({ a: 1 })).toEqual({ a: 1 });
    expect(() => validate({ a: "invalid" })).toThrow(/Validation failed/);
    expect(validate({ b: 2 })).toEqual({ b: 2 });
    expect(() => validate({ b: "invalid" })).toThrow(/Validation failed/);
  });
  it.each([
    { label: "a missing required field", value: {} },
    { label: "an invalid field type", value: { leaf: "invalid" } },
  ])("formats escaped container names for $label", ({ value }) => {
    const validate = validator(Type.Object({ "room/~1%2F": Type.Object({ leaf: Type.Number() }) }));
    expect(() => validate({ "room/~1%2F": value })).toThrow("  - room.~1%2F.leaf:");
  });

  it.each(["anyOf", "oneOf"])("preserves accepted %s values during sibling coercion", (form) => {
    const cases: [TSchema[], unknown][] = [
      [[Type.Number(), Type.String()], "00123"],
      [[Type.String(), Type.Number()], 42],
      [[Type.String(), Type.Boolean()], false],
      [[Type.Array(Type.Integer()), Type.String()], '["2"]'],
      [[Type.Object({ id: Type.Integer() }), Type.Object({ id: Type.String() })], { id: "00123" }],
    ];
    for (const [branches, value] of cases) {
      for (const alternatives of [branches, branches.toReversed()]) {
        const validate = objectValidator(
          { value: { [form]: alternatives }, count: integer },
          { required: ["value", "count"] },
        );
        const input = { value: structuredClone(value), count: "2" };
        expect(validate(input)).toEqual({ value, count: 2 });
        expect(input).toEqual({ value, count: "2" });
      }
    }
  });

  it.each(["anyOf", "oneOf"])("recovers %s branches and preserves nested values", (keyword) => {
    const item = objectSchema(
      { id: { [keyword]: [number, string] }, count: integer },
      { required: ["id", "count"] },
    );
    const validate = valueValidator({ [keyword]: [{ type: "array", items: item }, boolean] });
    expectValue(validate, [{ id: "00123", count: "2" }], [{ id: "00123", count: 2 }]);
    expectValue(validate, "true", true);
    expect(() => validate({ value: [{ id: "00123", count: "invalid" }] })).toThrow(
      /Validation failed/,
    );
  });

  it("keeps invalid non-null values out of nullable integer schemas", () => {
    const typebox = Type.Object({ limit: optionalLimit });
    for (const schema of [
      objectSchema({ limit: { anyOf: [positiveInteger, nil] } }),
      objectSchema({ limit: { oneOf: [positiveInteger, nil] } }),
      typebox,
      objectSchema({ limit: { type: ["integer", "null"], minimum: 1 } }),
      objectSchema({ limit: { type: ["null", "integer"], minimum: 1 } }),
    ]) {
      const validateArgs = validator(schema, "nullable-limit");
      const validate = (limit: unknown) => validateArgs({ limit });
      expect(validate(null)).toEqual({ limit: null });
      expect(validate(1)).toEqual({ limit: 1 });
      expect(validate("2")).toEqual({ limit: 2 });
      for (const limit of [0, false, "", -1, "invalid"]) {
        expect(() => validate(limit)).toThrow(/Validation failed for tool "nullable-limit"/);
      }
      // TypeBox recovers fractional integers by truncating; JSON Schema rejects them.
      if (schema === typebox) {
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
    const parentSchema = {
      ...closedObject({ kind: { ...string, enum: ["page"] }, count: positiveInteger }),
      type: types,
    };
    const validateArgs = validator(closedObject({ parent: parentSchema }), "nullable-parent");
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
    const nulls = [false, 0, ""].map((input) => [input, null] as const);
    const cases: [Tool["parameters"], readonly (readonly [unknown, unknown])[]][] = [
      [{ type: ["number", "null"] }, numbers],
      [{ type: ["null", "number"] }, numbers],
      [{ type: ["string", "null"] }, strings],
      [{ type: ["null", "string"] }, strings],
      [{ type: "null" }, nulls],
      [{ type: ["null"] }, nulls],
    ];
    for (const [schema, conversions] of cases) {
      const validate = valueValidator(schema, { required: ["value"] });
      expectValue(validate, null, null);
      for (const [input, output] of conversions) {
        expectValue(validate, input, output);
      }
    }
  });

  it("coerces strict decimal strings and rejects non-decimal JSON-schema numbers", () => {
    const validateDecimal = validator(
      closedObject({ amount: number, count: integer }),
      "decimal-tool",
    );
    for (const validate of [
      validateDecimal,
      validator(Type.Object({ amount: Type.Number(), count: Type.Integer() }), "decimal-tool"),
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
    const validate = objectValidator(
      { label: string, count: integer },
      { required: ["label", "count"], additionalProperties: integer },
    );
    const input = { label: "1e2", count: "1", extra: "2" };
    expect(validate(input)).toEqual({ label: "1e2", count: 1, extra: 2 });
    expect(input).toEqual({ label: "1e2", count: "1", extra: "2" });
  });

  it("retains TypeBox-specific record and numeric enum coercion", () => {
    const validate = validator(
      Type.Object({
        counts: Type.Record(Type.String(), Type.Integer()),
        choice: Type.Enum([1, 2]),
        value: Type.Union([Type.Number(), Type.String()]),
        limit: optionalLimit,
      }),
      "typed-record",
    );
    const input = { counts: { first: "1" }, choice: "2", value: "00123", limit: null };
    expect(validate(input)).toEqual({
      counts: { first: 1 },
      choice: 2,
      value: "00123",
      limit: null,
    });
    const invalid = { ...input, limit: 0 };
    expect(() => validate(invalid)).toThrow(/Validation failed for tool "typed-record"/);
  });

  it("still rejects values accepted by multiple oneOf branches", () => {
    const validate = valueValidator({ oneOf: [number, integer] });
    expect(() => validate({ value: 1 })).toThrow(/Validation failed/);
  });

  it("preserves null in anyOf [{type: string}, {type: null}] without coercing to empty string (#96716)", () => {
    const validate = objectValidator(
      { insight_id: { anyOf: [string, nil] }, cluster_name: string },
      { required: ["cluster_name"], additionalProperties: false },
    );
    expect(validate({ insight_id: null, cluster_name: "testenv" })).toEqual({
      insight_id: null,
      cluster_name: "testenv",
    });
  });
  it.each(["anyOf", "oneOf"])("preserves values accepted by a referenced %s branch", (keyword) => {
    const validate = rootValidator(
      { [keyword]: [{ $ref: "#/$defs/number" }, { $ref: "#/$defs/text" }] },
      { number, text: string },
    );
    expectValue(validate, "00123", "00123");
  });
  it.each(["anyOf", "oneOf"])("checks %s alternatives in their root context", (keyword) => {
    const validate = rootValidator(
      { [keyword]: [{ $ref: "#/$defs/positive" }, { $ref: "#/$defs/absent" }] },
      {
        positive: { $ref: "#/$defs/limit~1value~0" },
        "limit/value~": positiveInteger,
        absent: nil,
      },
    );
    expectValue(validate, null, null);
    expectValue(validate, "2", 2);
    for (const invalid of [0, false, "", -1, "invalid"]) {
      expect(() => validate({ value: invalid })).toThrow(/Validation failed/);
    }
  });

  it("preserves TypeBox refinements when choosing a coercion alternative", () => {
    const refined = Type.Refine(Type.Number(), (candidate) => candidate >= 10);
    const value = Type.Union([refined, Type.String()]);
    for (const options of [{}, { $defs: { unused: { type: "string" } } }]) {
      const validate = validator(Type.Object({ value }, options));
      expectValue(validate, "02", "02");
      const recoverable = validator(
        Type.Object({ value: Type.Union([refined, Type.Boolean()]) }, options),
      );
      expect(() => recoverable({ value: "02" })).toThrow(/Validation failed/);
      expectValue(recoverable, "12", 12);
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
      const definitions = { [name]: objectSchema({ limit: number }) };
      const validate = valueValidator({ $ref: ref }, { definitions });
      expect(validate({ value: { limit: "5" } }), ref).toEqual({ value: { limit: 5 } });
      expect(() => validate({ value: { limit: "invalid" } })).toThrow(/Validation failed/);
    }
  });

  it("keeps union branch validators bound to each tool's root", () => {
    const branch = { anyOf: [{ $ref: "#/$defs/value" }, nil] };
    for (const type of ["array", "object", "array"]) {
      const definition =
        type === "array" ? { type, items: integer } : objectSchema({ count: integer });
      const validate = rootValidator(branch, { value: definition });
      expectValue(
        validate,
        type === "array" ? '["2"]' : '{"count":"2"}',
        type === "array" ? [2] : { count: 2 },
      );
    }
  });

  it("coerces recursive definitions at distinct data locations and preserves siblings", () => {
    const node = { $ref: "#/$defs/node" };
    const definition = objectSchema(
      {
        count: integer,
        next: node,
        children: { type: "array", items: node },
        named: { type: "object", additionalProperties: node },
      },
      { required: ["count"], additionalProperties: false },
    );
    const validate = rootValidator({ ...node, maxProperties: 2 }, { node: definition });
    const input = {
      count: "1",
      children: [
        '{"count":"2","next":{"count":"3"}}',
        { count: "4", named: { last: '{"count":"5"}' } },
      ],
    };
    expectValue(validate, JSON.stringify(input), {
      count: 1,
      children: [
        { count: 2, next: { count: 3 } },
        { count: 4, named: { last: { count: 5 } } },
      ],
    });
    const invalid = { value: { count: "1", next: { count: "2" }, children: [] } };
    expect(() => validate(invalid)).toThrow(/must not have more than/i);
  });

  it("applies reference siblings without dropping their coercion or validation", () => {
    const validate = rootValidator(
      {
        $ref: "#/$defs/base",
        properties: { enabled: boolean },
        required: ["enabled"],
      },
      { base: requiredCount },
    );
    expectValue(validate, '{"enabled":"true","count":"2"}', { enabled: true, count: 2 });
    expect(() => validate({ value: '{"count":"2"}' })).toThrow(/enabled/);
  });

  it("does not resolve scoped references against an outer definition table", () => {
    const validate = rootValidator(
      {
        $id: "https://example.invalid/scoped",
        type: "object",
        properties: { text: { $ref: "#/$defs/item" }, free: true },
        $defs: { item: string },
      },
      { item: { type: "array", items: integer } },
    );
    expectValue(validate, { text: "[1]", free: "[2]" }, { text: "[1]", free: "[2]" });
  });

  it("coerces references inside tuple and allOf schemas", () => {
    const validate = rootValidator(
      { allOf: [{ $ref: "#/$defs/tuple" }] },
      {
        tuple: { type: "array", items: [{ $ref: "#/$defs/count" }, { $ref: "#/$defs/tags" }] },
        count: integer,
        tags: { type: "array", items: string },
      },
    );
    expectValue(validate, ["2", '["a","b"]'], [2, ["a", "b"]]);
  });

  it("keeps invalid and oversized strings out of referenced containers", () => {
    for (const [definition, kind] of [
      [{ type: "array", items: integer }, "array"],
      [requiredCount, "object"],
    ] as const) {
      const validate = rootValidator({ $ref: "#/$defs/value" }, { value: definition });
      for (const invalid of [
        "not-json",
        "false",
        "null",
        kind === "array" ? '{"not":"array"}' : "[]",
        " ".repeat(64 * 1024) + (kind === "array" ? "[1]" : '{"count":1}'),
      ]) {
        expect(() => validate({ value: invalid })).toThrow(/Validation failed/);
      }
    }
  });
});
