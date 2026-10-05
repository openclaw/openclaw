import { describe, expect, it } from "vitest";
import {
  cleanSchemaForLlamacppGbnf,
  findLlamacppGbnfSchemaViolations,
} from "./clean-for-llamacpp-gbnf.js";
import { ToolSchemaDepthExceededError } from "./tool-schema-depth.js";

function deepNestedSchema(levels: number): unknown {
  let schema: unknown = { type: "object" };
  for (let index = 0; index < levels; index += 1) {
    schema = { type: "object", properties: { child: schema } };
  }
  return schema;
}

describe("cleanSchemaForLlamacppGbnf depth budget", () => {
  it("removes unsupported keywords from shallow schemas", () => {
    expect(
      cleanSchemaForLlamacppGbnf({
        type: "object",
        pattern: "^x$",
        properties: { name: { type: "string", pattern: "a+" } },
      }),
    ).toStrictEqual({ type: "object", properties: { name: { type: "string" } } });
  });

  it("rejects deeply nested external schemas with a typed error instead of a RangeError", () => {
    expect(() => cleanSchemaForLlamacppGbnf(deepNestedSchema(3000))).toThrow(
      ToolSchemaDepthExceededError,
    );
  });

  it("reports a bounded depth violation instead of overflowing the violation walker", () => {
    expect(
      findLlamacppGbnfSchemaViolations(deepNestedSchema(3000), "tool").some((violation) =>
        violation.endsWith(".depth"),
      ),
    ).toBe(true);
  });
});
