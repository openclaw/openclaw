import { describe, expect, it } from "vitest";
import type { JsoncValue } from "../../jsonc/ast.js";
import { appendJsonlOcPath, setJsonlOcPath } from "../../jsonl/edit.js";
import { parseJsonl } from "../../jsonl/parse.js";
import { resolveJsonlOcPath } from "../../jsonl/resolve.js";
import { parseOcPath } from "../../oc-path.js";
import { REDACTED_SENTINEL } from "../../sentinel.js";

function edit(raw: string, path: string, value: JsoncValue) {
  return setJsonlOcPath(parseJsonl(raw), parseOcPath(path), value);
}

describe("JSONL edits", () => {
  const log = '{"event":"start"}\n{"event":"step","n":1}\n{"event":0,"event":"end"}\n';

  it("resolves $last and edits the effective key on the most recent line", () => {
    const r = edit(log, "oc://log/$last/event", { kind: "string", value: "final" });
    expect(r.raw).toBe(log.replace('"end"', '"final"'));
  });

  it("reads and edits $first while preserving blank and sentinel-bearing malformed lines", () => {
    const ast = parseJsonl('\nbroken __OPENCLAW_REDACTED__\n{"event":"start"}\n{"event":"end"}\n');
    const path = parseOcPath("oc://session-events/$first/event");
    expect(resolveJsonlOcPath(ast, path)).toMatchObject({
      kind: "object-entry",
      line: 3,
      node: { value: { kind: "string", value: "start" } },
    });
    const r = setJsonlOcPath(ast, path, { kind: "string", value: "replaced" });
    expect(r.raw).toBe('\nbroken __OPENCLAW_REDACTED__\n{"event":"replaced"}\n{"event":"end"}\n');
  });

  it("reports unresolved for unknown line addresses", () => {
    expect(() => edit(log, "oc://session-events/L99/x", { kind: "number", value: 1 })).toThrow(
      expect.objectContaining({ reason: "unresolved" }),
    );
  });

  it("reports not-a-value-line when targeting a malformed line", () => {
    const ast = parseJsonl('{"a":1}\nbroken\n{"b":2}\n');
    const path = parseOcPath("oc://session-events/L2");
    expect(resolveJsonlOcPath(ast, path)).toMatchObject({
      kind: "line",
      node: { kind: "malformed", line: 2, raw: "broken" },
    });
    expect(() => setJsonlOcPath(ast, path, { kind: "number", value: 1 })).toThrow(
      expect.objectContaining({ reason: "not-a-value-line" }),
    );
  });

  it("appends to an empty file", () => {
    const next = appendJsonlOcPath(parseJsonl(""), {
      kind: "object",
      entries: [{ key: "event", line: 0, value: { kind: "string", value: "start" } }],
    });
    expect(next.raw).toBe('{"event":"start"}');
  });

  it("preserves CRLF line endings when appending", () => {
    const next = appendJsonlOcPath(parseJsonl('{"a":1}\r\n'), {
      kind: "object",
      entries: [{ key: "b", line: 0, value: { kind: "number", value: 2 } }],
    });
    expect(next.raw).toBe('{"a":1}\r\n{"b":2}\r\n');
  });

  it("edits the last array item on a line via $last", () => {
    const r = edit(
      '{"items":[10,20,30],"events":{"a":1,"b":2}}\n',
      "oc://session-events/L1/items/$last",
      { kind: "number", value: 99 },
    );
    expect(r.raw).toBe('{"items":[10,20,99],"events":{"a":1,"b":2}}\n');
  });

  it("edits a field key containing a slash via quoted segment", () => {
    const r = edit(
      '{"event":"start","detail":{"github/repo":"old"}}\n',
      'oc://x.jsonl/L1/detail/"github/repo"',
      { kind: "string", value: "new" },
    );
    expect(r.raw).toBe('{"event":"start","detail":{"github/repo":"new"}}\n');
  });

  it("keeps offsets current through repeated edits of a BOM-prefixed unterminated record", () => {
    const original = '\uFEFF{ "$first":"literal", "items":[10,20], "id":9007199254740993 } // note';
    const first = edit(original, 'oc://x.jsonl/L1/"$first"', {
      kind: "string",
      value: "longer literal",
    });
    expect(first.raw).toBe(original.replace('"literal"', '"longer literal"'));
    const second = setJsonlOcPath(first, parseOcPath("oc://x.jsonl/L1/items/$last"), {
      kind: "array",
      items: [{ kind: "string", value: "line\nbreak" }],
    });
    expect(second.raw).toBe(
      '\uFEFF{ "$first":"longer literal", "items":[10,["line\\nbreak"]], "id":9007199254740993 } // note',
    );
  });

  it.each([
    ["\n", "\n42\n"],
    ["\r\n", "\r\n42\r\n"],
    ['{ "id":9007199254740993 }', '{ "id":9007199254740993 }\n42'],
  ])("preserves prior bytes when appending after %j", (raw, expected) => {
    const next = appendJsonlOcPath(parseJsonl(raw), { kind: "number", value: 42 });
    expect(next.raw).toBe(expected);
    expect(resolveJsonlOcPath(next, parseOcPath("oc://x.jsonl/$last"))).toMatchObject({
      kind: "line",
      node: { value: { kind: "number", value: 42 } },
    });
  });

  it("rejects new sentinel values without changing the source", () => {
    const original = '{"event":"old"}\n';
    const ast = parseJsonl(original);
    const value = { kind: "string" as const, value: REDACTED_SENTINEL };
    expect(() => setJsonlOcPath(ast, parseOcPath("oc://x.jsonl/L1/event"), value)).toThrow(
      `emit refused to write "${REDACTED_SENTINEL}" sentinel literal at oc://x.jsonl/L1/event`,
    );
    expect(() => appendJsonlOcPath(ast, value)).toThrow();
    expect(ast.raw).toBe(original);
  });
});
