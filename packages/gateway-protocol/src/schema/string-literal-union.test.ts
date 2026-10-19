import { Type, type Static, type TLiteral, type TUnion } from "typebox";
import { describe, expect, expectTypeOf, it } from "vitest";
import { stringLiteralUnion } from "./string-literal-union.js";

describe("string literal protocol unions", () => {
  it("preserves ordered anyOf branches and optional schema metadata", () => {
    const schema = stringLiteralUnion(["streaming", "completed", "error"], {
      description: "Run status",
      deprecated: true,
    });
    expect(JSON.stringify(schema)).toBe(
      JSON.stringify({
        anyOf: [
          { type: "string", const: "streaming" },
          { type: "string", const: "completed" },
          { type: "string", const: "error" },
        ],
        description: "Run status",
        deprecated: true,
      }),
    );
    expectTypeOf(schema).toEqualTypeOf<
      TUnion<[TLiteral<"streaming">, TLiteral<"completed">, TLiteral<"error">]>
    >();
    expectTypeOf<Static<typeof schema>>().toEqualTypeOf<"streaming" | "completed" | "error">();
  });

  it("keeps empty, singleton, and duplicate lists as unions", () => {
    const empty = stringLiteralUnion([]);
    const single = stringLiteralUnion(["only"]);
    const duplicate = stringLiteralUnion(["same", "same"]);
    expect(JSON.stringify(empty)).toBe(JSON.stringify({ anyOf: [] }));
    expect(JSON.stringify(single)).toBe(
      JSON.stringify({
        anyOf: [{ type: "string", const: "only" }],
      }),
    );
    expect(JSON.stringify(duplicate)).toBe(
      JSON.stringify({
        anyOf: [
          { type: "string", const: "same" },
          { type: "string", const: "same" },
        ],
      }),
    );
    expectTypeOf<Static<typeof empty>>().toEqualTypeOf<never>();
    expectTypeOf<Static<typeof single>>().toEqualTypeOf<"only">();
  });

  it("retains literal inference through optional object properties", () => {
    const choices = ["local", "cloud"] as const;
    const schema = Type.Object({ location: Type.Optional(stringLiteralUnion(choices)) });
    expectTypeOf<Static<typeof schema>>().toEqualTypeOf<{ location?: "local" | "cloud" }>();
  });
});
