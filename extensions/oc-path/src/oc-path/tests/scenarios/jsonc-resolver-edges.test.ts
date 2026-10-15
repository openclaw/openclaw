// OC Path tests cover jsonc resolver edges plugin behavior.
import { describe, expect, it } from "vitest";
import { parseJsonc } from "../../jsonc/parse.js";
import { resolveJsoncOcPath } from "../../jsonc/resolve.js";
import { parseOcPath } from "../../oc-path.js";

function rs(raw: string, ocPath: string) {
  return resolveJsoncOcPath(parseJsonc(raw).ast, parseOcPath(ocPath));
}

describe("jsonc resolver edges", () => {
  it("non-integer index returns null (no NaN coercion)", () => {
    expect(rs('{"x":[1,2]}', "oc://config/x.foo")).toBeNull();
  });

  it("empty segment in dotted path throws OcPathError", () => {
    // v1 invariant: malformed paths fail loud at parse time, not silently null.
    expect(() => rs('{"x":1}', "oc://config/x..y")).toThrow(/Empty dotted sub-segment/);
  });

  it("keys with special characters resolve", () => {
    const m = rs('{"a-b_c":{"x":1}}', "oc://config/a-b_c.x");
    expect(m?.kind).toBe("object-entry");
  });

  it("unicode keys resolve", () => {
    const m = rs('{"héllo":1}', "oc://config/héllo");
    expect(m?.kind).toBe("object-entry");
  });
});
