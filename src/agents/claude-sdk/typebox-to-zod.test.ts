import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  convertTypeBoxObjectToZodShape,
  convertTypeBoxSchemaToZod,
} from "./typebox-to-zod.js";

// Helper: round-trip a TypeBox object schema through the converter,
// build a z.object() from the resulting shape, and parse a sample.
function roundTripObject<T>(
  schema: Parameters<typeof convertTypeBoxObjectToZodShape>[0],
  sample: T,
) {
  const { shape, unsupportedKinds } = convertTypeBoxObjectToZodShape(schema);
  const parsed = z.object(shape).parse(sample);
  return { parsed, unsupportedKinds };
}

describe("convertTypeBoxSchemaToZod — primitive kinds", () => {
  it("converts Type.String", () => {
    const { zod } = convertTypeBoxSchemaToZod(Type.String());
    expect(zod.parse("hello")).toBe("hello");
    expect(() => zod.parse(42)).toThrow();
  });

  it("converts Type.Number", () => {
    const { zod } = convertTypeBoxSchemaToZod(Type.Number());
    expect(zod.parse(3.14)).toBe(3.14);
  });

  it("converts Type.Integer with integer enforcement", () => {
    const { zod } = convertTypeBoxSchemaToZod(Type.Integer());
    expect(zod.parse(5)).toBe(5);
    expect(() => zod.parse(3.14)).toThrow();
  });

  it("converts Type.Boolean", () => {
    const { zod } = convertTypeBoxSchemaToZod(Type.Boolean());
    expect(zod.parse(true)).toBe(true);
  });

  it("converts Type.Null", () => {
    const { zod } = convertTypeBoxSchemaToZod(Type.Null());
    expect(zod.parse(null)).toBeNull();
    expect(() => zod.parse("x")).toThrow();
  });

  it("converts Type.Any / Type.Unknown to z.unknown (accepts anything)", () => {
    const anyResult = convertTypeBoxSchemaToZod(Type.Any());
    const unkResult = convertTypeBoxSchemaToZod(Type.Unknown());
    expect(() => anyResult.zod.parse({ a: 1 })).not.toThrow();
    expect(() => unkResult.zod.parse(null)).not.toThrow();
  });
});

describe("convertTypeBoxSchemaToZod — composite kinds", () => {
  it("converts Type.Literal('a')", () => {
    const { zod } = convertTypeBoxSchemaToZod(Type.Literal("a"));
    expect(zod.parse("a")).toBe("a");
    expect(() => zod.parse("b")).toThrow();
  });

  it("converts Type.Array(Type.String())", () => {
    const { zod } = convertTypeBoxSchemaToZod(Type.Array(Type.String()));
    expect(zod.parse(["x", "y"])).toEqual(["x", "y"]);
    expect(() => zod.parse([1, 2])).toThrow();
  });

  it("converts Type.Union of literals", () => {
    const { zod } = convertTypeBoxSchemaToZod(
      Type.Union([Type.Literal("a"), Type.Literal("b")]),
    );
    expect(zod.parse("a")).toBe("a");
    expect(() => zod.parse("c")).toThrow();
  });

  it("converts Type.Record(Type.String(), Type.Number())", () => {
    const { zod } = convertTypeBoxSchemaToZod(Type.Record(Type.String(), Type.Number()));
    expect(zod.parse({ a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
  });
});

describe("convertTypeBoxObjectToZodShape — object roundtrips", () => {
  it("preserves required fields", () => {
    const schema = Type.Object({
      name: Type.String(),
      age: Type.Number(),
    });
    const { parsed } = roundTripObject(schema, { name: "a", age: 1 });
    expect(parsed).toEqual({ name: "a", age: 1 });
  });

  it("preserves Type.Optional semantics", () => {
    const schema = Type.Object({
      name: Type.String(),
      tag: Type.Optional(Type.String()),
    });
    const { shape } = convertTypeBoxObjectToZodShape(schema);
    expect(() => z.object(shape).parse({ name: "a" })).not.toThrow();
    expect(() => z.object(shape).parse({ name: "a", tag: "b" })).not.toThrow();
  });

  it("rejects missing required fields", () => {
    const schema = Type.Object({ name: Type.String(), age: Type.Number() });
    const { shape } = convertTypeBoxObjectToZodShape(schema);
    expect(() => z.object(shape).parse({ name: "a" })).toThrow();
  });

  it("handles nested Object/Array/Union", () => {
    const schema = Type.Object({
      user: Type.Object({
        id: Type.String(),
        roles: Type.Array(Type.Union([Type.Literal("admin"), Type.Literal("user")])),
      }),
    });
    const { parsed } = roundTripObject(schema, {
      user: { id: "u1", roles: ["admin", "user"] },
    });
    expect(parsed).toEqual({ user: { id: "u1", roles: ["admin", "user"] } });
  });

  it("throws when given a non-object top-level schema", () => {
    expect(() => convertTypeBoxObjectToZodShape(Type.String())).toThrow();
  });

  it("records unsupported kinds via onUnsupported callback + result.unsupportedKinds", () => {
    // Craft an object with an unrecognized inline shape.
    const weirdProp = { type: "weird-nonexistent-type" };
    const schema = {
      type: "object",
      [Symbol.for("TypeBox.Kind")]: "Object",
      properties: { x: weirdProp },
      required: [],
    };
    const seen: string[] = [];
    const { shape, unsupportedKinds } = convertTypeBoxObjectToZodShape(schema, {
      onUnsupported: (reason) => seen.push(reason),
    });
    expect(unsupportedKinds.length).toBeGreaterThan(0);
    expect(seen.length).toBeGreaterThan(0);
    // Still produces a valid shape that parses arbitrary data for that field.
    const parsed = z.object(shape).parse({ x: "anything-works" });
    expect(parsed).toEqual({ x: "anything-works" });
  });
});
