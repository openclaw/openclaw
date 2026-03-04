/**
 * Schema Adapter Contract Tests
 *
 * Derived from: implementation-plan.md Section 4.3.1 (TypeBox → Zod conversion, supported types list),
 * pi-runtime-baseline.md Section 4.3 (all OpenClaw tools use TypeBox schemas with standard JSON Schema types).
 *
 * These tests verify TypeBox → Zod conversion for every type used by OpenClaw tools.
 * Tests are written before implementation (contract-first).
 */

import { Type } from "@sinclair/typebox";
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { stringEnum, optionalStringEnum } from "../schema/typebox.js";
import { typeboxPropertyToZod, typeboxToZod } from "./schema-adapter.js";

enum NumericEnum {
  Zero = 0,
  One = 1,
}

describe("typeboxPropertyToZod", () => {
  it("converts Type.String() to z.string()", () => {
    const schema = Type.String();
    const zodType = typeboxPropertyToZod(schema);
    expect(zodType.parse("hello")).toBe("hello");
    expect(() => zodType.parse(42)).toThrow();
  });

  it("converts Type.Number() to z.number()", () => {
    const schema = Type.Number();
    const zodType = typeboxPropertyToZod(schema);
    expect(zodType.parse(42)).toBe(42);
    expect(() => zodType.parse("hello")).toThrow();
  });

  it("converts Type.Boolean() to z.boolean()", () => {
    const schema = Type.Boolean();
    const zodType = typeboxPropertyToZod(schema);
    expect(zodType.parse(true)).toBe(true);
    expect(() => zodType.parse("true")).toThrow();
  });

  it("converts Type.Optional(Type.String()) to z.string().optional()", () => {
    const schema = Type.Optional(Type.String());
    const zodType = typeboxPropertyToZod(schema);
    expect(zodType.parse("hello")).toBe("hello");
    expect(zodType.parse(undefined)).toBeUndefined();
    expect(() => zodType.parse(42)).toThrow();
  });

  it("converts Type.Array(Type.String()) to z.array(z.string())", () => {
    const schema = Type.Array(Type.String());
    const zodType = typeboxPropertyToZod(schema);
    expect(zodType.parse(["a", "b"])).toEqual(["a", "b"]);
    expect(() => zodType.parse([1, 2])).toThrow();
  });

  it("converts Type.Literal to z.literal()", () => {
    const schema = Type.Literal("specific_value");
    const zodType = typeboxPropertyToZod(schema);
    expect(zodType.parse("specific_value")).toBe("specific_value");
    expect(() => zodType.parse("other_value")).toThrow();
  });

  it("converts Type.Union([Type.String(), Type.Number()]) to z.union()", () => {
    const schema = Type.Union([Type.String(), Type.Number()]);
    const zodType = typeboxPropertyToZod(schema);
    expect(zodType.parse("hello")).toBe("hello");
    expect(zodType.parse(42)).toBe(42);
    expect(() => zodType.parse(true)).toThrow();
  });

  it("converts Type.Enum with numeric values to numeric literal validation", () => {
    const schema = Type.Enum(NumericEnum);
    const zodType = typeboxPropertyToZod(schema);
    expect(zodType.parse(0)).toBe(0);
    expect(zodType.parse(1)).toBe(1);
    expect(() => zodType.parse("0")).toThrow();
    expect(() => zodType.parse(2)).toThrow();
  });

  it("preserves description annotations", () => {
    const schema = Type.String({ description: "File path" });
    const zodType = typeboxPropertyToZod(schema);
    // Description should be attached — z.ZodType has a .description property
    expect(zodType.description).toBe("File path");
  });

  it("converts nested Type.Object", () => {
    const innerSchema = Type.Object({ x: Type.Number(), y: Type.Number() });
    const zodType = typeboxPropertyToZod(innerSchema);
    expect(zodType.parse({ x: 1, y: 2 })).toEqual({ x: 1, y: 2 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => zodType.parse({ x: "a", y: 2 } as any)).toThrow();
  });
});

describe("stringEnum / Type.Unsafe handling", () => {
  it("converts stringEnum to z.enum with valid constraints", () => {
    const schema = stringEnum(["send", "read", "delete"]);
    const zodType = typeboxPropertyToZod(schema);
    expect(zodType.parse("send")).toBe("send");
    expect(zodType.parse("read")).toBe("read");
    expect(() => zodType.parse("list-channels")).toThrow();
    expect(() => zodType.parse("unknown-action")).toThrow();
    expect(() => zodType.parse(42)).toThrow();
  });

  it("converts optionalStringEnum to z.enum().optional()", () => {
    const schema = optionalStringEnum(["primary", "secondary", "danger"]);
    const zodType = typeboxPropertyToZod(schema);
    expect(zodType.parse("primary")).toBe("primary");
    expect(zodType.parse(undefined)).toBeUndefined();
    expect(() => zodType.parse("invalid-style")).toThrow();
  });

  it("converts Type.Optional(stringEnum()) to z.enum().optional()", () => {
    const schema = Type.Optional(stringEnum(["channel-list", "channel-info", "channel-edit"]));
    const zodType = typeboxPropertyToZod(schema);
    expect(zodType.parse("channel-list")).toBe("channel-list");
    expect(zodType.parse(undefined)).toBeUndefined();
    expect(() => zodType.parse("list-channels")).toThrow();
  });

  it("preserves description on stringEnum", () => {
    const schema = stringEnum(["send", "read"], { description: "The action to perform" });
    const zodType = typeboxPropertyToZod(schema);
    expect(zodType.description).toBe("The action to perform");
  });

  it("preserves description on optionalStringEnum", () => {
    const schema = optionalStringEnum(["primary", "secondary"], { description: "Button style" });
    const zodType = typeboxPropertyToZod(schema);
    expect(zodType.description).toBe("Button style");
  });

  it("stringEnum in an object schema produces proper enum shape (not z.unknown)", () => {
    const schema = Type.Object({
      action: stringEnum(["send", "read", "delete"]),
      style: Type.Optional(stringEnum(["primary", "secondary"])),
    });
    const shape = typeboxToZod(schema);
    const zodObj = z.object(shape);
    expect(zodObj.parse({ action: "send" })).toMatchObject({ action: "send" });
    expect(() => zodObj.parse({ action: "list-channels" })).toThrow();
    expect(() => zodObj.parse({ action: "send", style: "bold" })).toThrow();
    expect(zodObj.parse({ action: "send", style: "primary" })).toMatchObject({
      action: "send",
      style: "primary",
    });
  });

  it("stringEnum in nested array/object schema preserves constraints", () => {
    const schema = Type.Array(
      Type.Object({
        style: Type.Optional(stringEnum(["danger", "success", "primary"])),
        text: Type.String(),
      }),
    );
    const zodType = typeboxPropertyToZod(schema);
    expect(zodType.parse([{ text: "click me", style: "danger" }])).toEqual([
      { text: "click me", style: "danger" },
    ]);
    expect(() => zodType.parse([{ text: "click me", style: "bold" }])).toThrow();
  });
});

describe("Type.Object with additionalProperties", () => {
  it("converts Type.Object with additionalProperties: true to a passthrough schema", () => {
    const schema = Type.Object({}, { additionalProperties: true });
    const zodType = typeboxPropertyToZod(schema);
    const result = zodType.parse({ anyKey: "anyValue", nested: { x: 1 } });
    expect(result).toMatchObject({ anyKey: "anyValue", nested: { x: 1 } });
  });

  it("converts Type.Optional(Type.Object with additionalProperties: true) to passthrough optional", () => {
    const schema = Type.Optional(Type.Object({}, { additionalProperties: true }));
    const zodType = typeboxPropertyToZod(schema);
    expect(zodType.parse(undefined)).toBeUndefined();
    const result = zodType.parse({ type: "AdaptiveCard", version: "1.5", body: [] });
    expect(result).toMatchObject({ type: "AdaptiveCard", version: "1.5" });
  });

  it("preserves description on object with additionalProperties", () => {
    const schema = Type.Object(
      {},
      { additionalProperties: true, description: "Adaptive Card JSON object" },
    );
    const zodType = typeboxPropertyToZod(schema);
    expect(zodType.description).toBe("Adaptive Card JSON object");
  });

  it("object with known properties AND additionalProperties: true passes through extras", () => {
    const schema = Type.Object({ name: Type.String() }, { additionalProperties: true });
    const zodType = typeboxPropertyToZod(schema);
    const result = zodType.parse({ name: "card", extra: "data", count: 42 });
    expect(result).toMatchObject({ name: "card", extra: "data", count: 42 });
    expect(() => zodType.parse({ name: 123, extra: "data" })).toThrow();
  });

  it("object without additionalProperties: true does NOT pass through extras by default", () => {
    const schema = Type.Object({ name: Type.String() });
    const zodType = typeboxPropertyToZod(schema);
    // Zod's default is to strip unknown keys, not reject — so extras are silently dropped
    const result = zodType.parse({ name: "test", extra: "dropped" });
    expect(result).toEqual({ name: "test" });
    expect((result as Record<string, unknown>).extra).toBeUndefined();
  });
});

describe("typeboxToZod", () => {
  it("converts Type.Object with multiple properties to Zod shape", () => {
    const schema = Type.Object({
      name: Type.String(),
      age: Type.Number(),
    });
    const shape = typeboxToZod(schema);
    const zodObj = z.object(shape);
    expect(zodObj.parse({ name: "Alice", age: 30 })).toEqual({ name: "Alice", age: 30 });
    expect(() => zodObj.parse({ name: 42, age: "thirty" })).toThrow();
  });

  it("converts Type.Object with required and optional fields", () => {
    const schema = Type.Object({
      path: Type.String(),
      line: Type.Optional(Type.Number()),
    });
    const shape = typeboxToZod(schema);
    const zodObj = z.object(shape);
    // Required field only
    expect(zodObj.parse({ path: "foo.ts" })).toMatchObject({ path: "foo.ts" });
    // With optional field
    expect(zodObj.parse({ path: "foo.ts", line: 42 })).toEqual({ path: "foo.ts", line: 42 });
  });

  it("preserves description annotations on properties", () => {
    const schema = Type.Object({
      path: Type.String({ description: "File path to read" }),
    });
    const shape = typeboxToZod(schema);
    expect((shape.path as { description?: string }).description).toBe("File path to read");
  });

  it("returns a valid Zod shape for empty object", () => {
    const schema = Type.Object({});
    const shape = typeboxToZod(schema);
    expect(shape).toBeDefined();
    expect(typeof shape).toBe("object");
  });

  it("falls back gracefully for non-object schemas", () => {
    // Should not throw — returns a fallback shape
    const schema = Type.String(); // Not a TObject
    const shape = typeboxToZod(schema);
    expect(shape).toBeDefined();
  });
});
