// OC Path tests cover jsonl byte fidelity plugin behavior.
import { describe, expect, it } from "vitest";
import { setJsonlOcPath } from "../../jsonl/edit.js";
import { parseJsonl } from "../../jsonl/parse.js";
import { parseOcPath } from "../../oc-path.js";

function rt(raw: string): string {
  return parseJsonl(raw).raw;
}

describe("jsonl byte-fidelity", () => {
  it("single line no trailing newline", () => {
    expect(rt('{"a":1}')).toBe('{"a":1}');
  });

  it("CRLF input preserves CRLF after a structural edit", () => {
    const raw = '{"a":1}\r\n{"b":2}\r\n';
    const ast = parseJsonl(raw);
    const result = setJsonlOcPath(ast, parseOcPath("oc://events/L1/a"), {
      kind: "number",
      value: 2,
    });
    const rendered = result.raw;
    expect(rendered).toBe('{"a":2}\r\n{"b":2}\r\n');
    expect((rendered.match(/\r\n/g) ?? []).length).toBe(2);
    expect((rendered.match(/(?<!\r)\n/g) ?? []).length).toBe(0);
  });

  it("LF input preserves LF after a structural edit", () => {
    // Symmetric: a Unix-authored log doesn't mysteriously gain CRLF.
    const raw = '{"a":1}\n{"b":2}\n';
    const ast = parseJsonl(raw);
    const result = setJsonlOcPath(ast, parseOcPath("oc://events/L1/a"), {
      kind: "number",
      value: 2,
    });
    expect(result.raw).toBe('{"a":2}\n{"b":2}\n');
  });
});
