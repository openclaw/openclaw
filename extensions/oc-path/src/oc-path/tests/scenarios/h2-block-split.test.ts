// OC Path tests cover h2 block split plugin behavior.
import { describe, expect, it } from "vitest";
import { parseMd } from "../../parse.js";

describe("h2-block-split", () => {
  it("heading-shaped text inside multi-line bullet body — does split", () => {
    const raw = "## Section\n- item starts\n  continues\n## Next\n";
    const ast = parseMd(raw);
    expect(ast.blocks.map((b) => b.heading)).toEqual(["Section", "Next"]);
  });
});
