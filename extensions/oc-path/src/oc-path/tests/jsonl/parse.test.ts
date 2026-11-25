// OC Path tests cover parse plugin behavior.
import { describe, expect, it } from "vitest";
import { parseJsonl } from "../../jsonl/parse.js";

describe("parseJsonl", () => {
  it.each([
    ["", []],
    ["\n", ["blank"]],
    ["\r\n", ["blank"]],
  ])("parses %j as %j", (raw, kinds) => {
    expect(parseJsonl(raw).lines.map((l) => l.kind)).toEqual(kinds);
  });

  it("parses each line as a JSON value", () => {
    const raw = `{"event":"start"}
{"event":"step","n":1}
{"event":"end"}
`;
    const ast = parseJsonl(raw);
    expect(ast.lines).toHaveLength(3);
    expect(ast.lines[0]?.kind).toBe("value");
    expect(ast.lines[2]?.kind).toBe("value");
  });

  it("preserves blank lines as blank entries", () => {
    const raw = '{"a":1}\n\n{"b":2}\n';
    const ast = parseJsonl(raw);
    expect(ast.lines.map((l) => l.kind)).toEqual(["value", "blank", "value"]);
  });

  it("retains malformed lines without aborting", () => {
    const raw = '{"a":1}\nthis is not json\n{"b":2}\n';
    const ast = parseJsonl(raw);
    expect(ast.lines.map((l) => l.kind)).toEqual(["value", "malformed", "value"]);
    expect(ast.lines[1]).toEqual({ kind: "malformed", line: 2, raw: "this is not json" });
  });
});
