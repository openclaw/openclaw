import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { parseJsonc } from "../jsonc/parse.js";
import { parseJsonl } from "../jsonl/parse.js";
import { parseOcPath } from "../oc-path.js";
import { parseMd } from "../parse.js";
import { REDACTED_SENTINEL } from "../sentinel.js";
import { resolveOcPath, setOcPath, type OcAst } from "../universal.js";
import { parseYaml } from "../yaml/parse.js";

function resolve(ast: OcAst, uri: string) {
  return resolveOcPath(ast, parseOcPath(uri));
}

function edit(ast: OcAst, uri: string, value: string, options?: Parameters<typeof setOcPath>[3]) {
  return setOcPath(ast, parseOcPath(uri), value, options);
}

function expectEditError(ast: OcAst, uri: string, value: string, reason: string) {
  expect(() => edit(ast, uri, value)).toThrow(expect.objectContaining({ reason }));
}

function expectLeaf(match: ReturnType<typeof resolve>, valueText: string, leafType = "string") {
  expect(match).toMatchObject({ kind: "leaf", leafType, valueText });
}

function expectNode(match: ReturnType<typeof resolve>, descriptor: string) {
  expect(match).toMatchObject({ kind: "node", descriptor });
}

function expectInsertion(match: ReturnType<typeof resolve>, container: string) {
  expect(match).toMatchObject({ kind: "insertion-point", container });
}

describe("resolveOcPath", () => {
  it.each([
    ["Markdown", () => parseMd("---\nname: github\n---\n\n## Boundaries\n\n- enabled: true\n")],
    ["JSONC", () => parseJsonc('{ "enabled": true }')],
    ["JSONL", () => parseJsonl('{"enabled":true}\n')],
    ["YAML", () => parseYaml("enabled: true\n")],
  ])("preserves file-root identity and unresolved results for %s", (_kind, parse) => {
    const ast = parse();
    const root = resolve(ast, "oc://X");
    expect(root).toMatchObject({ kind: "root", line: 1 });
    expect(root?.kind === "root" && root.ast).toBe(ast);
    expect(resolve(ast, "oc://X/missing")).toBeNull();
  });

  it("keeps a wrapped prose item addressable when a later line contains a colon", () => {
    const ast = parseMd("## Tools\n- Install dependencies\n  Note: first\n  second\n");
    expectNode(resolve(ast, "oc://X.md/tools/install-dependencies-note-first-second"), "md-item");
  });

  it("returns leaf:null for null value", () => {
    const ast = parseJsonc('{ "k": 42, "s": "x", "b": true, "n": null, "arr": [1,2,3] }');
    expectLeaf(resolve(ast, "oc://config/n"), "null", "null");
  });

  it("returns node:jsonc-array for array value", () => {
    const ast = parseJsonc('{ "k": 42, "s": "x", "b": true, "n": null, "arr": [1,2,3] }');
    expectNode(resolve(ast, "oc://config/arr"), "jsonc-array");
  });

  it("returns node:jsonl-line for line address", () => {
    const ast = parseJsonl('{"event":"start","n":1}\n{"event":"step","n":2}\n');
    expectNode(resolve(ast, "oc://log/L1"), "jsonl-line");
  });

  it("returns insertion-point for md section append", () => {
    const md = parseMd("## Tools\n");
    expectInsertion(resolve(md, "oc://X.md/tools/+"), "md-section");
  });

  it("returns insertion-point for md file-level", () => {
    const md = parseMd("## Tools\n");
    expectInsertion(resolve(md, "oc://X.md/+"), "md-file");
  });

  it("returns insertion-point for md frontmatter +key", () => {
    const md = parseMd("---\nname: x\n---\n");
    expectInsertion(resolve(md, "oc://X.md/[frontmatter]/+description"), "md-frontmatter");
  });

  it("returns insertion-point for jsonl file-root +", () => {
    const ast = parseJsonl("");
    expectInsertion(resolve(ast, "oc://log/+"), "jsonl-file");
  });

  it("returns null when insertion target is not a container", () => {
    const ast = parseJsonc('{ "k": 42 }');
    expect(resolve(ast, "oc://config/k/+")).toBeNull();
  });
  it("preserves source line lookup for numeric map keys", () => {
    const ast = parseYaml("name: x\n1: one\n");
    const m = resolve(ast, "oc://workflow.yaml/1");
    expectLeaf(m, "one");
    expect(m?.line).toBe(2);
  });
});

describe("setOcPath", () => {
  it('coerces "true"/"false" when leaf was boolean', () => {
    const ast = parseJsonc('{ "k": true }');
    expect(JSON.parse(edit(ast, "oc://config/k", "false").raw)).toEqual({ k: false });
  });

  it("rejects non-numeric string for number leaf", () => {
    const ast = parseJsonc('{ "k": 1 }');
    expectEditError(ast, "oc://config/k", "not-a-number", "parse-error");
  });

  it("rejects non-bool string for boolean leaf", () => {
    const ast = parseJsonc('{ "k": true }');
    expectEditError(ast, "oc://config/k", "maybe", "parse-error");
  });

  it("resolves slash-deep JSONC paths", () => {
    const ast = parseJsonc(
      '{ "agents": { "entries": { "main": { "tools": { "exec": { "security": "deny" } } } } } }',
    );
    const r = edit(ast, "oc://openclaw.json/agents/entries/main/tools/exec/security", "allowlist");
    expect(JSON.parse(r.raw)).toEqual({
      agents: { entries: { main: { tools: { exec: { security: "allowlist" } } } } },
    });
  });

  it("replaces a JSONC leaf with parsed JSON when requested", () => {
    const ast = parseJsonc('{ "token": "${TOKEN}" }');
    const r = edit(
      ast,
      "oc://openclaw.json/token",
      '{"source":"file","provider":"secrets","id":"/test"}',
      { valueJson: true },
    );
    expect(JSON.parse(r.raw)).toEqual({
      token: { source: "file", provider: "secrets", id: "/test" },
    });
  });

  it("rejects non-finite parsed JSON replacement values", () => {
    const ast = parseJsonc('{ "limit": 1 }');
    expect(() => edit(ast, "oc://openclaw.json/limit", "1e999", { valueJson: true })).toThrow(
      expect.objectContaining({ reason: "parse-error" }),
    );
  });
  it("replaces whole line via JSON value", () => {
    const ast = parseJsonl('{"event":"start"}\n');
    const { raw } = edit(ast, "oc://log/L1", '{"event":"replaced"}');
    expect(JSON.parse(raw)).toEqual({ event: "replaced" });
  });

  it("rejects malformed JSON for whole-line replacement", () => {
    const ast = parseJsonl('{"event":"start"}\n');
    expectEditError(ast, "oc://log/L1", "not json", "parse-error");
  });
  it.each(["description:\n", "description:\n  "])(
    "does not expose an empty inserted value as an editable field: %j",
    (value) => {
      const ast = parseMd("## Tools\n## Other\n- keep: stable\n");
      const inserted = edit(ast, "oc://X.md/tools/+", value);
      const before = structuredClone(inserted);
      const field = "oc://X.md/tools/description/description";
      expect(resolve(inserted, field)).toBeNull();
      expectEditError(inserted, field, "updated", "no-item-kv");
      expect(inserted).toEqual(before);
      expect(inserted.raw).toContain("## Other\n- keep: stable\n");
    },
  );

  it.each(["\n", "\r\n"])("edits a wrapped field immediately after insertion with %j", (eol) => {
    const raw = "## Tools\n- keep: stable\n## Other\n- sibling: unchanged\n".replaceAll("\n", eol);
    const ast = parseMd(raw);
    const inserted = edit(ast, "oc://X.md/tools/+", "description: first line\n  second line");
    const field = "oc://X.md/tools/description/description";
    expectLeaf(resolve(inserted, field), "first line\n  second line");
    const edited = edit(inserted, field, "updated");
    const expected =
      "## Tools\n- keep: stable\n- description: updated\n## Other\n- sibling: unchanged\n";
    expect(edited.raw).toBe(expected.replaceAll("\n", eol));
    expectLeaf(resolve(parseMd(edited.raw), field), "updated");
    expect(ast.raw).toBe(raw);
  });

  it("refuses sentinel-bearing Markdown insertion values", () => {
    const uri = "oc://X.md/tools/+";
    const md = parseMd("## Tools\n- keep: stable\n");
    const before = structuredClone(md);
    for (const value of [REDACTED_SENTINEL, `before${REDACTED_SENTINEL}after`]) {
      expect(() => edit(md, uri, value)).toThrow(
        `emit refused to write "${REDACTED_SENTINEL}" sentinel literal at ${uri}`,
      );
      expect(md).toEqual(before);
    }
  });

  it("keeps the insertion-value guard separate from new frontmatter keys", () => {
    const md = parseMd("---\nname: x\n---\n");
    const result = edit(md, `oc://X.md/[frontmatter]/+${REDACTED_SENTINEL}`, "safe");
    expect(result.raw).toBe(`---\nname: x\n${REDACTED_SENTINEL}: safe\n---\n`);
  });

  it.each([
    ["section", "## Existing\n", "oc://X.md/+", "New Section", "## Existing\n\n## New Section\n"],
    [
      "frontmatter",
      "\uFEFF## Existing\r\n* keep: literal",
      "oc://X.md/[frontmatter]/+name",
      "x",
      "\uFEFF---\r\nname: x\r\n---\r\n## Existing\r\n* keep: literal",
    ],
    [
      "empty frontmatter",
      "\uFEFF---\r\n# keep\r\n---\r\n## Existing",
      "oc://X.md/[frontmatter]/+name",
      "x",
      "\uFEFF---\r\n# keep\r\nname: x\r\n---\r\n## Existing",
    ],
  ])("preserves output and input AST when inserting a %s", (_kind, raw, path, value, expected) => {
    const md = parseMd(raw);
    const before = structuredClone(md);
    const result = edit(md, path, value);
    expect(result.kind).toBe("md");
    expect(result.raw).toBe(expected);
    expect(md).toEqual(before);
  });

  it("rejects duplicate frontmatter key on insertion", () => {
    const md = parseMd("---\nname: x\n---\n");
    expectEditError(md, "oc://X.md/[frontmatter]/+name", "y", "type-mismatch");
  });
  it("appends to array with `+`", () => {
    const ast = parseJsonc('{ "items": [1, 2] }');
    expect(JSON.parse(edit(ast, "oc://config/items/+", "3").raw)).toEqual({ items: [1, 2, 3] });
  });

  it("inserts at index with `+nnn`", () => {
    const ast = parseJsonc('{ "items": [1, 3] }');
    expect(JSON.parse(edit(ast, "oc://config/items/+1", "2").raw)).toEqual({ items: [1, 2, 3] });
  });

  it("rejects duplicate object key", () => {
    const ast = parseJsonc('{ "plugins": { "github": "x" } }');
    expectEditError(ast, "oc://config/plugins/+github", '"y"', "unresolved");
  });

  it("rejects +key on array", () => {
    const ast = parseJsonc('{ "items": [1, 2] }');
    expectEditError(ast, "oc://config/items/+abc", "3", "type-mismatch");
  });

  it("inserts complex object via JSON value", () => {
    const ast = parseJsonc('{ "plugins": {} }');
    const r = edit(ast, "oc://config/plugins/+gitlab", '{"token":"xyz","enabled":true}');
    expect(JSON.parse(r.raw)).toEqual({
      plugins: { gitlab: { token: "xyz", enabled: true } },
    });
  });
  it("appends a JSON line with `+`", () => {
    const ast = parseJsonl('{"event":"start"}\n');
    const { raw } = edit(ast, "oc://log/+", '{"event":"step","n":1}');
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(expectDefined(lines[1], "appended JSONL line"))).toEqual({
      event: "step",
      n: 1,
    });
  });

  it("rejects malformed JSON value", () => {
    const ast = parseJsonl("");
    expectEditError(ast, "oc://log/+", "not json", "parse-error");
  });

  it("rejects non-root insertion target", () => {
    const ast = parseJsonl('{"a":1}\n');
    expectEditError(ast, "oc://log/L1/+", "{}", "not-writable");
  });
  it("is non-mutating across all kinds", () => {
    const md = parseMd("---\nname: x\n---\n");
    const before = JSON.stringify(md);
    edit(md, "oc://X.md/[frontmatter]/name", "new");
    expect(JSON.stringify(md)).toBe(before);

    const jsonc = parseJsonc('{ "k": 1 }');
    const before2 = JSON.stringify(jsonc);
    edit(jsonc, "oc://config/k", "99");
    expect(JSON.stringify(jsonc)).toBe(before2);

    const jsonl = parseJsonl('{"a":1}\n');
    const before3 = JSON.stringify(jsonl);
    edit(jsonl, "oc://log/L1/a", "99");
    expect(JSON.stringify(jsonl)).toBe(before3);
  });

  it("reports an unresolved edit", () => {
    const ast = parseJsonc("{}");
    expectEditError(ast, "oc://config/missing", "v", "unresolved");
  });
});
