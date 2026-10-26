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
    expect(resolve(ast, "oc://X.md/tools/install-dependencies-note-first-second")).toMatchObject({
      kind: "node",
      descriptor: "md-item",
    });
  });

  it.each([
    [
      parseJsonc('{"n":null}'),
      "oc://config/n",
      { kind: "leaf", leafType: "null", valueText: "null" },
    ],
    [parseJsonc('{"arr":[1]}'), "oc://config/arr", { kind: "node", descriptor: "jsonc-array" }],
    [parseJsonl('{"event":"start"}\n'), "oc://log/L1", { kind: "node", descriptor: "jsonl-line" }],
  ])("resolves the value at %s %s", (ast, uri, expected) => {
    expect(resolve(ast, uri)).toMatchObject(expected);
  });

  it.each([
    [parseMd("## Tools\n"), "oc://X.md/tools/+", "md-section"],
    [parseMd("## Tools\n"), "oc://X.md/+", "md-file"],
    [parseMd("---\nname: x\n---\n"), "oc://X.md/[frontmatter]/+description", "md-frontmatter"],
    [parseJsonl(""), "oc://log/+", "jsonl-file"],
  ])("resolves insertion target %s %s", (ast, uri, container) => {
    expect(resolve(ast, uri)).toMatchObject({ kind: "insertion-point", container });
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
  it.each([
    ['{"k":true}', "k", "false", '{"k":false}', false],
    [
      '{"a":{"b":{"c":{"d":{"e":{"k":"deny"}}}}}}',
      "a/b/c/d/e/k",
      "allowlist",
      '{"a":{"b":{"c":{"d":{"e":{"k":"allowlist"}}}}}}',
      false,
    ],
    [
      '{"token":"old"}',
      "token",
      '{"source":"file","id":"/test"}',
      '{"token":{"source":"file","id":"/test"}}',
      true,
    ],
    [
      '{"plugins":{}}',
      "plugins/+gitlab",
      '{"token":"xyz","enabled":true}',
      '{"plugins":{"gitlab":{"token":"xyz","enabled":true}}}',
      false,
    ],
    ['{"items":[1,2]}', "items/+", "3", '{"items":[1,2,3]}', false],
    ['{"items":[1,3]}', "items/+1", "2", '{"items":[1,2,3]}', false],
  ])("edits JSONC %s at %s", (raw, path, value, expected, valueJson) => {
    const result = edit(parseJsonc(raw), "oc://openclaw.json/" + path, value, { valueJson });
    expect(JSON.parse(result.raw)).toEqual(JSON.parse(expected));
  });

  it.each([
    [parseJsonc('{"k":1}'), "oc://config/k", "not-a-number", "parse-error"],
    [parseJsonc('{"k":true}'), "oc://config/k", "maybe", "parse-error"],
    [parseJsonl('{"event":"start"}\n'), "oc://log/L1", "not json", "parse-error"],
    [parseMd("---\nname: x\n---\n"), "oc://X.md/[frontmatter]/+name", "y", "type-mismatch"],
    [parseJsonc('{"plugins":{"github":"x"}}'), "oc://config/plugins/+github", '"y"', "unresolved"],
    [parseJsonc('{"items":[1,2]}'), "oc://config/items/+abc", "3", "type-mismatch"],
    [parseJsonl(""), "oc://log/+", "not json", "parse-error"],
    [parseJsonl('{"a":1}\n'), "oc://log/L1/+", "{}", "not-writable"],
    [parseJsonc("{}"), "oc://config/missing", "v", "unresolved"],
  ])("rejects invalid edit at %s %s with %s (%s)", expectEditError);

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

  it.each([
    [parseMd("---\nname: x\n---\n"), "oc://X.md/[frontmatter]/name", "new"],
    [parseJsonc('{"k":1}'), "oc://config/k", "99"],
    [parseJsonl('{"a":1}\n'), "oc://log/L1/a", "99"],
  ])("does not mutate %s when editing %s", (ast, uri, value) => {
    const before = JSON.stringify(ast);
    edit(ast, uri, value);
    expect(JSON.stringify(ast)).toBe(before);
  });
});
