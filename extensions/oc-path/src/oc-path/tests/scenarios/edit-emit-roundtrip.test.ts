// OC Path tests cover edit emit roundtrip plugin behavior.
import { describe, expect, it } from "vitest";
import { setJsoncOcPath } from "../../jsonc/edit.js";
import { emitJsonc } from "../../jsonc/emit.js";
import { parseJsonc } from "../../jsonc/parse.js";
import { resolveJsoncOcPath } from "../../jsonc/resolve.js";
import { parseOcPath } from "../../oc-path.js";

describe("edit-then-emit round-trip", () => {
  it("jsonc nested edit preserves untouched siblings", () => {
    const ast = parseJsonc('{ "a": 1, "b": { "c": 2, "d": 3 }, "e": 4 }').ast;
    const r = setJsoncOcPath(ast, parseOcPath("oc://config/b.c"), {
      kind: "number",
      value: 99,
    });
    if (r.ok) {
      expect(JSON.parse(emitJsonc(r.ast))).toEqual({
        a: 1,
        b: { c: 99, d: 3 },
        e: 4,
      });
    }
  });

  it("jsonc edit composes: two sequential edits both land", () => {
    let ast = parseJsonc('{ "a": 1, "b": 2 }').ast;
    let r = setJsoncOcPath(ast, parseOcPath("oc://config/a"), {
      kind: "number",
      value: 10,
    });
    if (r.ok) {
      ast = r.ast;
    }
    r = setJsoncOcPath(ast, parseOcPath("oc://config/b"), {
      kind: "number",
      value: 20,
    });
    if (r.ok) {
      ast = r.ast;
    }
    expect(JSON.parse(emitJsonc(ast))).toEqual({ a: 10, b: 20 });
  });

  it("jsonc parser-backed edit preserves comments", () => {
    const raw = '{\n  "k": 1 // comment\n}\n';
    const ast = parseJsonc(raw).ast;
    const r = setJsoncOcPath(ast, parseOcPath("oc://config/k"), {
      kind: "number",
      value: 2,
    });
    if (r.ok) {
      expect(emitJsonc(r.ast)).toContain("// comment");
      const reparsed = resolveJsoncOcPath(r.ast, parseOcPath("oc://config/k"));
      expect(reparsed?.kind).toBe("object-entry");
      if (reparsed?.kind === "object-entry") {
        expect(reparsed.node.value.kind).toBe("number");
        if (reparsed.node.value.kind === "number") {
          expect(reparsed.node.value.value).toBe(2);
        }
      }
    }
  });
});
