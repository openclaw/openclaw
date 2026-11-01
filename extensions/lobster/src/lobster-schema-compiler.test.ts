import { describe, expect, it } from "vitest";
import { compileLobsterSchema } from "./lobster-schema-compiler.js";

describe("Lobster schema compiler", () => {
  it("keeps registered references with their native compiler and respects non-retaining mode", () => {
    const compile = compileLobsterSchema;
    const first = { scope: {}, allErrors: true, addUsedSchema: true };
    const second = { scope: {}, allErrors: true, addUsedSchema: true };
    const id = "https://example.test/value";
    compile({ $id: id, type: "string" }, first);
    compile({ $id: id, type: "number" }, second);
    const fromFirst = compile({ $ref: id }, first);
    const fromSecond = compile({ $ref: id }, second);
    expect(fromFirst("value")).toBe(true);
    expect(fromFirst(1)).toBe(false);
    expect(fromSecond(1)).toBe(true);
    expect(fromSecond("value")).toBe(false);

    const transient = { scope: {}, allErrors: false, addUsedSchema: false };
    expect(compile({ $id: id, type: "string" }, transient)("value")).toBe(true);
    expect(compile({ $id: id, type: "number" }, transient)(1)).toBe(true);
    expect(() => compile({ $ref: id }, transient)).toThrow();
  });

  it("returns the requested error count and clears prior failures after success", () => {
    const compile = compileLobsterSchema;
    const schema = {
      type: "object",
      properties: {
        count: { type: "integer", minimum: 1 },
        label: { type: "string", minLength: 2 },
      },
      additionalProperties: false,
    };
    const invalid = { count: 0, label: "", extra: true };
    const first = compile(schema, { scope: {}, allErrors: false, addUsedSchema: false });
    const all = compile(schema, { scope: {}, allErrors: true, addUsedSchema: true });
    expect(first(invalid)).toBe(false);
    expect(first.errors).toHaveLength(1);
    expect(all(invalid)).toBe(false);
    expect(all.errors).toHaveLength(3);
    expect(all.errors?.map((error) => error.instancePath)).toEqual(
      expect.arrayContaining(["", "/count", "/label"]),
    );
    expect(all({ count: 1, label: "ok" })).toBe(true);
    expect(all.errors).toBeNull();
  });
});
