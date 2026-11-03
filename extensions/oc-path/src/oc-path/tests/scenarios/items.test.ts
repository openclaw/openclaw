// OC Path tests cover items plugin behavior.
import { describe, expect, it } from "vitest";
import { parseMd } from "../../parse.js";

describe("items", () => {
  it("items spread across blocks are scoped to their block", () => {
    const ast = parseMd("## A\n- a1\n## B\n- b1\n- b2\n");
    expect(ast.blocks[0]?.items.length).toBe(1);
    expect(ast.blocks[1]?.items.length).toBe(2);
    expect(ast.blocks[1]?.items.map((i) => i.text)).toEqual(["b1", "b2"]);
  });
});
