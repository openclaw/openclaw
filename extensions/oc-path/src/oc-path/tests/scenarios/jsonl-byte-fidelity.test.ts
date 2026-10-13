// OC Path tests cover jsonl byte fidelity plugin behavior.
import { describe, expect, it } from "vitest";
import { renderJsonl } from "../../jsonl/emit.js";
import { parseJsonl } from "../../jsonl/parse.js";

function rt(raw: string): string {
  return parseJsonl(raw).ast.raw;
}

describe("jsonl byte-fidelity", () => {
  it("single line no trailing newline", () => {
    expect(rt('{"a":1}')).toBe('{"a":1}');
  });

  it("CRLF input preserves CRLF after a structural edit (render mode)", () => {
    const raw = '{"a":1}\r\n{"b":2}\r\n';
    const { ast } = parseJsonl(raw);
    const rendered = renderJsonl(ast);
    expect(rendered).toBe('{"a":1}\r\n{"b":2}');
    expect((rendered.match(/\r\n/g) ?? []).length).toBe(1);
    expect((rendered.match(/(?<!\r)\n/g) ?? []).length).toBe(0);
  });

  it("LF input preserves LF after a structural edit (render mode)", () => {
    // Symmetric: a Unix-authored log doesn't mysteriously gain CRLF.
    const raw = '{"a":1}\n{"b":2}\n';
    const { ast } = parseJsonl(raw);
    const rendered = renderJsonl(ast);
    expect(rendered).toBe('{"a":1}\n{"b":2}');
  });
});
