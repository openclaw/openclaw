import { expect, it } from "vitest";
import { findOcPaths } from "../../find.js";
import { parseJsonc } from "../../jsonc/parse.js";
import { parseJsonl } from "../../jsonl/parse.js";
import { MAX_TRAVERSAL_DEPTH, OcPathError, formatOcPath, parseOcPath } from "../../oc-path.js";
import { resolveOcPath, setOcPath } from "../../universal.js";

const PATH_LENGTH_LIMIT = 4096;
const COERCION_ERROR = expect.objectContaining({ reason: "parse-error" });

it.each<[string[], RegExp?]>([
  [["oc://X/foo /bar", "oc://X/foo\tbar"]],
  [['oc://"\\\\srv\\\\share\\\\foo"/section']],
  [["oc://X/[unclosed", "oc://X/closed]", "oc://X/{a,b"]],
  [["oc://X.md/a&b", "oc://X.md/a%b"]],
  [
    ["oc://X/\x00", "oc://X/foo\x01bar", "oc://X/foo\x7Fbar", "oc://X.md/items/[k=a\x00b]"],
    /Control character/,
  ],
  [["oc:///etc/passwd"], /Empty segment/],
  [['oc://"/etc/passwd"/section'], /Absolute file slot/],
  [['oc://"C:/Windows/System32/foo"/section'], /Absolute file slot/],
  [['oc://"C:\\\\Windows\\\\System32"/section'], /Absolute file slot/],
  [['oc://"../foo"/section', 'oc://"foo/../bar"/section'], /Parent-directory/],
  [["oc://X.jsonc/items/[]"]],
  [["oc://X/[=foo]", "oc://X/[id=]"], /Malformed predicate/],
  [["oc://X/{}"], /Empty union/],
  [["oc://X/{a,,b}"], /Empty alternative/],
])("rejects invalid paths: %j", (inputs, error) => {
  for (const input of inputs) {
    expect(() => parseOcPath(input)).toThrow(error ?? OcPathError);
  }
});

it("strips leading UTF-8 BOM from path string", () => {
  expect(parseOcPath("﻿oc://X/Y").file).toBe("X");
});

it("negative numeric key on object resolves as literal key (openclaw#59934)", () => {
  // Telegram supergroup IDs are negative numbers used as map keys.
  const ast = parseJsonc('{"groups":{"-5028303500":{"requireMention":false}}}');
  const m = resolveOcPath(ast, parseOcPath("oc://config/groups.-5028303500.requireMention"));
  expect(m?.kind).toBe("leaf");
});

it.each([
  [{ file: "/etc/passwd" }, /Absolute file slot/],
  [{ file: "C:/Windows" }, /Absolute file slot/],
  [{ file: ".." }, /Parent-directory/],
  [{ file: "foo/../bar" }, /Parent-directory/],
  [{ file: "a.md", section: "foo..bar" }, /Empty dotted/],
] as const)("formatOcPath rejects invalid slots: %j", (path, error) => {
  expect(() => formatOcPath(path)).toThrow(error);
});
it("rejects multibyte paths above MAX_PATH_LENGTH bytes", () => {
  const multibyteFile = "界".repeat(1400);
  const oversizedPath = `oc://${multibyteFile}`;
  const pathBytes = Buffer.byteLength(oversizedPath, "utf8");
  expect(oversizedPath.length).toBeLessThan(PATH_LENGTH_LIMIT);
  expect(pathBytes).toBeGreaterThan(PATH_LENGTH_LIMIT);
  expect(() => parseOcPath(oversizedPath)).toThrow(`length: ${pathBytes}`);
  expect(() => formatOcPath({ file: multibyteFile })).toThrow(`length: ${pathBytes}`);
});

it("rejects paths whose NFC normalization exceeds the byte limit", () => {
  // U+0344 grows from two to four UTF-8 bytes under NFC; the emoji takes four.
  const input = `oc://${"a".repeat(74)}😀${"\u0344".repeat(2006)}`;
  expect(Buffer.byteLength(input, "utf8")).toBeLessThanOrEqual(PATH_LENGTH_LIMIT);
  expect(Buffer.byteLength(input.normalize("NFC"), "utf8")).toBeGreaterThan(PATH_LENGTH_LIMIT);
  expect(() => parseOcPath(input)).toThrow(expect.objectContaining({ code: "OC_PATH_TOO_LONG" }));
});

it("walker depth cap fires on synthetic deeply-nested AST", () => {
  // Bypasses parser depth cap so the walker defense fires in isolation.
  type V = import("../../jsonc/ast.js").JsoncValue;
  let leaf: V = { kind: "string", value: "x", line: 1 };
  for (let i = 0; i < MAX_TRAVERSAL_DEPTH + 50; i++) {
    leaf = { kind: "object", entries: [{ key: "a", value: leaf, line: 1 }], line: 1 };
  }
  const ast = { kind: "jsonc" as const, raw: "", root: leaf };
  expect(() => findOcPaths(ast, parseOcPath("oc://X/**"))).toThrow(/MAX_TRAVERSAL_DEPTH/);
});

it.each(["{{a,,b},c}", "{a,{b,,c}}", "{{{a,,b},c},d}", "{a,{}}"])(
  "rejects malformed nested union %s before traversal",
  (pattern) => {
    expect(() => parseOcPath("oc://X/" + pattern)).toThrow(
      expect.objectContaining({ code: "OC_PATH_MALFORMED_UNION" }),
    );
  },
);

it("jsonl per-line parser flags malformed deeply-nested values", () => {
  const depth = MAX_TRAVERSAL_DEPTH + 50;
  const nested = '{"a":'.repeat(depth) + '"x"' + "}".repeat(depth);
  expect(parseJsonl(nested + "\n").lines).toEqual([{ kind: "malformed", line: 1, raw: nested }]);
});
it("formatOcPath rejects a struct carrying the redaction sentinel", () => {
  expect(() => formatOcPath({ file: "AGENTS.md", section: "__OPENCLAW_REDACTED__" })).toThrow(
    /sentinel literal/,
  );
});
it("`$last` literal key on an object is shadowed by the positional sentinel", () => {
  const ast = parseJsonc('{"$last":"literal-value","foo":"bar"}');
  const m = resolveOcPath(ast, parseOcPath("oc://X/$last"));
  expect(m?.kind === "leaf" && m.valueText).toBe("bar");
});
it.each([
  ['{"x":1.0}', "1.5", 1.5, ["1,5"]],
  ['{"x":true}', "false", false, ["False", "TRUE", "yes"]],
] as const)("coerces %j only from valid literals", (original, valid, expected, invalid) => {
  const ast = parseJsonc(original);
  const path = parseOcPath("oc://X/x");
  expect(JSON.parse(setOcPath(ast, path, valid).raw)).toEqual({ x: expected });
  for (const value of invalid) {
    expect(() => setOcPath(ast, path, value)).toThrow(COERCION_ERROR);
  }
});
it("regex metacharacters in predicate value match literally, not as regex", () => {
  const ast = parseJsonc('{"items":[{"name":"a.*"},{"name":"abc"}]}');
  const matches = findOcPaths(ast, parseOcPath("oc://X.jsonc/items/[name=a.*]"));
  expect(matches).toHaveLength(1);
});

it("predicate value containing `/` round-trips and matches literally", () => {
  const p = parseOcPath("oc://X/[id=foo/bar]/cmd");
  expect(p.section).toBe("[id=foo/bar]");
  const ast = parseJsonc('{"steps":[{"id":"foo/bar","cmd":"x"},{"id":"baz","cmd":"y"}]}');
  const matches = findOcPaths(ast, parseOcPath("oc://wf/steps/[id=foo/bar]/cmd"));
  expect(matches).toHaveLength(1);
});
