// OC Path tests cover edit plugin behavior.
import { describe, expect, it } from "vitest";
import { appendJsonlOcPath, setJsonlOcPath } from "../../jsonl/edit.js";
import { parseJsonl } from "../../jsonl/parse.js";
import { resolveJsonlOcPath } from "../../jsonl/resolve.js";
import { parseOcPath } from "../../oc-path.js";
import { REDACTED_SENTINEL } from "../../sentinel.js";

describe("setJsonlOcPath — value replacement", () => {
  const log = '{"event":"start"}\n{"event":"step","n":1}\n{"event":"end"}\n';

  it("resolves $last and edits the most recent value line", () => {
    const { ast } = parseJsonl(log);
    const r = setJsonlOcPath(ast, parseOcPath("oc://session-events/$last/event"), {
      kind: "string",
      value: "final",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const lines = r.ast.raw.split("\n");
      expect(JSON.parse(lines[2] ?? "")).toEqual({ event: "final" });
    }
  });

  it("reads and edits $first while preserving blank and sentinel-bearing malformed lines", () => {
    const { ast } = parseJsonl(
      '\nbroken __OPENCLAW_REDACTED__\n{"event":"start"}\n{"event":"end"}\n',
    );
    const path = parseOcPath("oc://session-events/$first/event");
    expect(resolveJsonlOcPath(ast, path)).toMatchObject({
      kind: "object-entry",
      line: 3,
      node: { value: { kind: "string", value: "start" } },
    });
    const r = setJsonlOcPath(ast, path, { kind: "string", value: "replaced" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ast.raw).toBe(
        '\nbroken __OPENCLAW_REDACTED__\n{"event":"replaced"}\n{"event":"end"}\n',
      );
    }
  });

  it("reports unresolved for unknown line addresses", () => {
    const { ast } = parseJsonl(log);
    const r = setJsonlOcPath(ast, parseOcPath("oc://session-events/L99/x"), {
      kind: "number",
      value: 1,
    });
    expect(r).toEqual({ ok: false, reason: "unresolved" });
  });

  it.each([{ kind: "malformed", raw: "broken" }])(
    "reports not-a-value-line when targeting a $kind line",
    ({ kind, raw }) => {
      const { ast } = parseJsonl(`{"a":1}\n${raw}\n{"b":2}\n`);
      const path = parseOcPath("oc://session-events/L2");
      expect(resolveJsonlOcPath(ast, path)).toMatchObject({
        kind: "line",
        node: { kind, line: 2, raw },
      });
      const r = setJsonlOcPath(ast, path, {
        kind: "number",
        value: 1,
      });
      expect(r).toEqual({ ok: false, reason: "not-a-value-line" });
    },
  );
});

describe("appendJsonlOcPath — session checkpointing primitive", () => {
  it("appends to an empty file", () => {
    const { ast } = parseJsonl("");
    const next = appendJsonlOcPath(ast, {
      kind: "object",
      entries: [{ key: "event", line: 0, value: { kind: "string", value: "start" } }],
    });
    expect(next.raw).toBe('{"event":"start"}');
  });

  it("preserves CRLF line endings when appending", () => {
    const { ast } = parseJsonl('{"a":1}\r\n');
    const next = appendJsonlOcPath(ast, {
      kind: "object",
      entries: [{ key: "b", line: 0, value: { kind: "number", value: 2 } }],
    });
    expect(next.raw).toBe('{"a":1}\r\n{"b":2}\r\n');
  });
});

describe("setJsonlOcPath — $last positional field tokens", () => {
  const log = '{"items":[10,20,30],"events":{"a":1,"b":2}}\n';

  it("edits the last array item on a line via $last", () => {
    const { ast } = parseJsonl(log);
    const r = setJsonlOcPath(ast, parseOcPath("oc://session-events/L1/items/$last"), {
      kind: "number",
      value: 99,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const firstLine = r.ast.raw.split("\n").find((l) => l.length > 0) ?? "";
      expect(JSON.parse(firstLine)).toEqual({
        items: [10, 20, 99],
        events: { a: 1, b: 2 },
      });
    }
  });
});

describe("setJsonlOcPath — quoted field segments", () => {
  it("edits a field key containing a slash via quoted segment", () => {
    const raw = `{"event":"start","detail":{"github/repo":"old"}}\n`;
    const { ast } = parseJsonl(raw);
    const r = setJsonlOcPath(ast, parseOcPath('oc://x.jsonl/L1/detail/"github/repo"'), {
      kind: "string",
      value: "new",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const lines = r.ast.raw.split("\n").filter((l) => l.length > 0);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? "")).toEqual({
        event: "start",
        detail: { "github/repo": "new" },
      });
    }
  });
});

describe("JSONL source edits", () => {
  it("keeps offsets current through repeated edits of a BOM-prefixed unterminated record", () => {
    const original = '\uFEFF{ "$first":"literal", "items":[10,20], "id":9007199254740993 } // note';
    const first = setJsonlOcPath(
      parseJsonl(original).ast,
      parseOcPath('oc://x.jsonl/L1/"$first"'),
      {
        kind: "string",
        value: "longer literal",
      },
    );
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    expect(first.ast.raw).toBe(original.replace('"literal"', '"longer literal"'));
    const second = setJsonlOcPath(first.ast, parseOcPath("oc://x.jsonl/L1/items/$last"), {
      kind: "array",
      items: [{ kind: "string", value: "line\nbreak" }],
    });
    expect(second.ok && second.ast.raw).toBe(
      '\uFEFF{ "$first":"longer literal", "items":[10,["line\\nbreak"]], "id":9007199254740993 } // note',
    );
  });

  it.each([
    ["\n", "\n42\n"],
    ["\r\n", "\r\n42\r\n"],
    ['{ "id":9007199254740993 }', '{ "id":9007199254740993 }\n42'],
  ])("preserves prior bytes when appending after %j", (raw, expected) => {
    const next = appendJsonlOcPath(parseJsonl(raw).ast, { kind: "number", value: 42 });
    expect(next.raw).toBe(expected);
    expect(resolveJsonlOcPath(next, parseOcPath("oc://x.jsonl/$last"))).toMatchObject({
      kind: "line",
      node: { value: { kind: "number", value: 42 } },
    });
  });

  it("rejects new sentinel values without changing the source", () => {
    const original = '{"event":"old"}\n';
    const ast = parseJsonl(original).ast;
    const value = { kind: "string" as const, value: REDACTED_SENTINEL };
    expect(() => setJsonlOcPath(ast, parseOcPath("oc://x.jsonl/L1/event"), value)).toThrow(
      expect.objectContaining({ code: "OC_EMIT_SENTINEL", path: "oc://x.jsonl/L1/event" }),
    );
    expect(() => appendJsonlOcPath(ast, value)).toThrow();
    expect(ast.raw).toBe(original);
  });
});
