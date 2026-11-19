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

const requiredObject = (properties: Record<string, TSchema>, options: TSchema = {}) =>
  objectSchema(properties, { required: Object.keys(properties), ...options });
const closedObject = (properties: Record<string, TSchema>) =>
  requiredObject(properties, { additionalProperties: false });

function valueValidator(value: TSchema, options: TSchema = {}, name = "refs") {
  const validate = validator(objectSchema({ value }, options), name);
  return {
    accepts: (input: unknown, expected: unknown) =>
      expect(validate({ value: input })).toEqual({ value: expected }),
    rejects: (input: unknown, message: string | RegExp = /Validation failed/) =>
      expect(() => validate({ value: input })).toThrow(message),
  };
}

const rootValidator = (value: TSchema, $defs: Record<string, TSchema>) =>
  valueValidator(value, { $defs });
const ref = (name: string) => ({ $ref: `#/$defs/${name}` });

const number = { type: "number" };
const integer = { type: "integer" };
const string = { type: "string" };
const boolean = { type: "boolean" };
const nil = { type: "null" };
const positiveInteger = { ...integer, minimum: 1 };
const optionalLimit = Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]));

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
      anyOf: [objectSchema({ a: number }), objectSchema({ b: number })],
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

  it.each(["anyOf", "oneOf"])("recovers %s branches and preserves nested values", (keyword) => {
    const item = requiredObject({
      id: { [keyword]: [number, string] },
      payload: { [keyword]: [requiredObject({ id: integer }), requiredObject({ id: string })] },
      count: integer,
    });
    const validate = valueValidator({ [keyword]: [{ type: "array", items: item }, boolean] });
    const input = { id: "00123", payload: { id: "00123" }, count: "2" };
    const original = structuredClone(input);
    validate.accepts([input], [{ ...input, count: 2 }]);
    expect(input).toEqual(original);
    validate.accepts("true", true);
    validate.rejects([{ ...input, count: "invalid" }]);
  });

  it.each([
    optionalLimit,
    { type: ["integer", "null"], minimum: 1 },
    { type: ["null", "integer"], minimum: 1 },
    ...["anyOf", "oneOf"].flatMap((keyword) => [
      { [keyword]: [positiveInteger, nil] },
      { [keyword]: [ref("positive"), ref("absent")] },
    ]),
  ])("validates nullable integers and root-context alternatives: %j", (schema) => {
    const $defs = {
      positive: ref("limit~1value~0"),
      "limit/value~": positiveInteger,
      absent: nil,
    };
    const validate = valueValidator(schema, { $defs }, "nullable-limit");
    validate.accepts(null, null);
    validate.accepts(1, 1);
    validate.accepts("2", 2);
    for (const limit of [0, false, "", -1, "invalid"]) {
      validate.rejects(limit, /Validation failed for tool "nullable-limit"/);
    }
    validate.rejects(1.5, /Validation failed for tool "nullable-limit"/);
  });

  it.each([
    { name: "object/null", types: ["object", "null"] },
    { name: "null/object", types: ["null", "object"] },
  ])("keeps invalid non-null values out of a $name type array", ({ types }) => {
    const parentSchema = {
      ...closedObject({ kind: { ...string, enum: ["page"] }, count: positiveInteger }),
      type: types,
    };
    const validate = valueValidator(parentSchema, {}, "nullable-parent");
    validate.accepts(null, null);
    const parent = { kind: "page", count: "2" };
    for (const input of [parent, JSON.stringify(parent)]) {
      validate.accepts(input, { kind: "page", count: 2 });
    }
    for (const input of [false, 0, "", [], { kind: "wrong", count: 2 }]) {
      validate.rejects(input, /Validation failed for tool "nullable-parent"/);
    }
  });

  it.each([
    [number, "1e3", 1000, ["0x10"], false],
    [integer, "+3", 3, ["0b10"], false],
    [Type.Number(), "1e3", 1000, [], false],
    [Type.Integer(), "+3", 3, [], false],
    [{ oneOf: [number, integer] }, 1.5, 1.5, [1], false],
    [{ type: ["number", "null"] }, false, 0, [], true],
    [{ type: ["null", "string"] }, false, "false", [], true],
    [{ type: ["string", "null"] }, 0, "0", [], true],
    [{ anyOf: [string, nil] }, "existing", "existing", [], true],
    [{ type: "null" }, false, null, [], true],
    [{ type: "null" }, 0, null, [], true],
    [{ type: ["null"] }, "", null, [], true],
  ] as const)(
    "coerces scalars and preserves nullable values (#96716): %j",
    (schema, input, output, rejected, nullable) => {
      const validate = valueValidator(schema, {}, "decimal-tool");
      validate.accepts(input, output);
      if (nullable) {
        validate.accepts(null, null);
      }
      for (const invalid of rejected) {
        validate.rejects(invalid, /Validation failed for tool "decimal-tool"/);
      }
    },
  );

  it("coerces additional properties without changing declared string fields", () => {
    const validate = validator(
      requiredObject({ label: string, count: integer }, { additionalProperties: integer }),
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
    const expected = { ...input, counts: { first: 1 }, choice: 2 };
    expect(validate(input)).toEqual(expected);
    // A TypeBox root retains its fractional integer conversion contract.
    expect(validate({ ...input, limit: 1.5 })).toEqual({ ...expected, limit: 1 });
    const invalid = { ...input, limit: 0 };
    expect(() => validate(invalid)).toThrow(/Validation failed for tool "typed-record"/);
  });

  it.each(["anyOf", "oneOf"])("preserves values accepted by a referenced %s branch", (keyword) => {
    const validate = rootValidator(
      { [keyword]: [{ $ref: "#/$defs/number" }, { $ref: "#/$defs/text" }] },
      { number, text: string },
    );
    validate.accepts("00123", "00123");
  });
  it("preserves TypeBox refinements when choosing a coercion alternative", () => {
    const refined = Type.Refine(Type.Number(), (candidate) => candidate >= 10);
    const value = Type.Union([refined, Type.String()]);
    for (const options of [{}, { $defs: { unused: { type: "string" } } }]) {
      const validate = validator(Type.Object({ value }, options));
      expect(validate({ value: "02" })).toEqual({ value: "02" });
      const recoverable = validator(
        Type.Object({ value: Type.Union([refined, Type.Boolean()]) }, options),
      );
      expect(() => recoverable({ value: "02" })).toThrow(/Validation failed/);
      expect(recoverable({ value: "12" })).toEqual({ value: 12 });
    }
  });

  it("coerces URI-fragment and JSON-pointer encoded definitions", () => {
    for (const [name, pointer] of [
      ["Partial<Filter>", "#/definitions/Partial<Filter>"],
      ["Partial<Filter>", "#/definitions/Partial%3CFilter%3E"],
      ["Partial<Filter>", "#%2Fdefinitions%2FPartial%3CFilter%3E"],
      ["Filter/value~", "#%2Fdefinitions%2FFilter%7E1value%7E0"],
      ["Filter%2Fvalue", "#/definitions/Filter%252Fvalue"],
    ] as const) {
      const definitions = { [name]: objectSchema({ limit: number }) };
      const validate = valueValidator({ $ref: pointer }, { definitions });
      validate.accepts({ limit: "5" }, { limit: 5 });
      validate.rejects({ limit: "invalid" });
    }
  });

  it("keeps union branch validators bound to each tool's root", () => {
    const branch = { anyOf: [ref("value"), nil] };
    for (const type of ["array", "object", "array"]) {
      const definition =
        type === "array" ? { type, items: integer } : objectSchema({ count: integer });
      const validate = rootValidator(branch, { value: definition });
      validate.accepts(
        type === "array" ? '["2"]' : '{"count":"2"}',
        type === "array" ? [2] : { count: 2 },
      );
    }
  });

  it("coerces recursive references, tuple compositions, and reference siblings", () => {
    const node = ref("node");
    const definition = objectSchema(
      {
        count: integer,
        next: node,
        children: { type: "array", items: node },
        named: { type: "object", additionalProperties: node },
        enabled: {},
        tuple: {},
      },
      { required: ["count"], additionalProperties: false },
    );
    const validate = rootValidator(
      {
        ...node,
        maxProperties: 4,
        properties: { enabled: boolean, tuple: { allOf: [ref("tuple")] } },
        required: ["enabled"],
      },
      {
        node: definition,
        tuple: { type: "array", items: [ref("count"), ref("tags")] },
        count: integer,
        tags: { type: "array", items: string },
      },
    );
    const input =
      '{"count":"1","children":["{\\"count\\":\\"2\\",\\"next\\":{\\"count\\":\\"3\\"}}",{"count":"4","named":{"last":"{\\"count\\":\\"5\\"}"}}],"enabled":"true","tuple":["2","[\\"a\\",\\"b\\"]"]}';
    const expected: Record<string, unknown> = JSON.parse(
      '{"count":1,"children":[{"count":2,"next":{"count":3}},{"count":4,"named":{"last":{"count":5}}}],"enabled":true,"tuple":[2,["a","b"]]}',
    );
    validate.accepts(input, expected);
    validate.rejects({ ...expected, next: { count: "2" } }, /must not have more than/i);
    validate.rejects('{"count":"2"}', /enabled/);
  });

  it("does not resolve scoped references against an outer definition table", () => {
    const validate = rootValidator(
      {
        $id: "https://example.invalid/scoped",
        type: "object",
        properties: { text: ref("item"), free: true },
        $defs: { item: string },
      },
      { item: { type: "array", items: integer } },
    );
    validate.accepts({ text: "[1]", free: "[2]" }, { text: "[1]", free: "[2]" });
  });

  it("keeps invalid and oversized strings out of referenced containers", () => {
    for (const [definition, kind] of [
      [{ type: "array", items: integer }, "array"],
      [requiredObject({ count: integer }), "object"],
    ] as const) {
      const validate = rootValidator(ref("value"), { value: definition });
      for (const invalid of [
        "not-json",
        "false",
        "null",
        kind === "array" ? '{"not":"array"}' : "[]",
        " ".repeat(64 * 1024) + (kind === "array" ? "[1]" : '{"count":1}'),
      ]) {
        validate.rejects(invalid);
      }
    }
  });
});
