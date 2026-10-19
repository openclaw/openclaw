import { expect, it } from "vitest";
import { findOcPaths } from "../../find.js";
import { parseJsonc } from "../../jsonc/parse.js";
import { parseJsonl } from "../../jsonl/parse.js";
import { MAX_TRAVERSAL_DEPTH, OcPathError, formatOcPath, parseOcPath } from "../../oc-path.js";
import { resolveOcPath, setOcPath } from "../../universal.js";

const PATH_LENGTH_LIMIT = 4096;
const LONG_TAIL = `😀${"b".repeat(PATH_LENGTH_LIMIT)}`;
const PARSE_PREFIX = `oc://${"a".repeat(74)}`;
const COERCION_ERROR = expect.objectContaining({ reason: "parse-error" });

function rejectPath(input: string, error: RegExp | typeof OcPathError = OcPathError): void {
  expect(() => parseOcPath(input)).toThrow(error);
}

function expectUtf16SafeLimitError(run: () => unknown, expectedInput: string): void {
  try {
    run();
    expect.fail("expected an OC_PATH_TOO_LONG error");
  } catch (err) {
    expect(err).toBeInstanceOf(OcPathError);
    expect(err).toMatchObject({ code: "OC_PATH_TOO_LONG", input: expectedInput });
  }
}

it.each<[string, string[]]>([
  ["whitespace inside identifier-shaped segments", ["oc://X/foo /bar", "oc://X/foo\tbar"]],
  ["leading-backslash UNC path", ['oc://"\\\\srv\\\\share\\\\foo"/section']],
  ["mismatched brackets and braces", ["oc://X/[unclosed", "oc://X/closed]", "oc://X/{a,b"]],
  ["unescaped `&` and `%` in segments", ["oc://X.md/a&b", "oc://X.md/a%b"]],
])("rejects %s", (_name, inputs) => {
  for (const input of inputs) {
    rejectPath(input);
  }
});

it("strips leading UTF-8 BOM from path string", () => {
  expect(parseOcPath("﻿oc://X/Y").file).toBe("X");
});

it("rejects control characters and NUL bytes anywhere in the path", () => {
  rejectPath("oc://X/\x00", /Control character/);
  rejectPath("oc://X/foo\x01bar", /Control character/);
  rejectPath("oc://X/foo\x7Fbar", /Control character/);
  rejectPath("oc://X.md/items/[k=a\x00b]");
});
it("rejects absolute POSIX file slot", () => {
  rejectPath("oc:///etc/passwd", /Empty segment/);
  rejectPath('oc://"/etc/passwd"/section', /Absolute file slot/);
});

it("rejects Windows drive-letter file slot", () => {
  rejectPath('oc://"C:/Windows/System32/foo"/section', /Absolute file slot/);
  rejectPath('oc://"C:\\\\Windows\\\\System32"/section', /Absolute file slot/);
});

it("negative numeric key on object resolves as literal key (openclaw#59934)", () => {
  // Telegram supergroup IDs are negative numbers used as map keys.
  const ast = parseJsonc(
    '{"channels":{"telegram":{"groups":{"-5028303500":{"requireMention":false}}}}}',
  ).ast;
  const m = resolveOcPath(
    ast,
    parseOcPath("oc://config/channels.telegram.groups.-5028303500.requireMention"),
  );
  expect(m?.kind).toBe("leaf");
});

it("rejects parent-directory escapes", () => {
  rejectPath('oc://"../foo"/section', /Parent-directory/);
  rejectPath('oc://"foo/../bar"/section', /Parent-directory/);
});

it("formatOcPath rejects absolute and parent-directory file slots", () => {
  expect(() => formatOcPath({ file: "/etc/passwd" })).toThrow(/Absolute file slot/);
  expect(() => formatOcPath({ file: "C:/Windows" })).toThrow(/Absolute file slot/);
  expect(() => formatOcPath({ file: ".." })).toThrow(/Parent-directory/);
  expect(() => formatOcPath({ file: "foo/../bar" })).toThrow(/Parent-directory/);
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

it("keeps overlong parse input UTF-16 safe", () => {
  expectUtf16SafeLimitError(() => parseOcPath(PARSE_PREFIX + LONG_TAIL), `${PARSE_PREFIX}…`);
});

it("keeps post-NFC overlong parse input UTF-16 safe", () => {
  const prefixBytes = Buffer.byteLength(PARSE_PREFIX, "utf8");
  // U+0344 grows from two to four UTF-8 bytes under NFC; the emoji takes four.
  const markCount = Math.floor((PATH_LENGTH_LIMIT - prefixBytes - 4) / 2);
  const input = `${PARSE_PREFIX}😀${"\u0344".repeat(markCount)}`;
  expect(Buffer.byteLength(input, "utf8")).toBeLessThanOrEqual(PATH_LENGTH_LIMIT);
  expect(Buffer.byteLength(input.normalize("NFC"), "utf8")).toBeGreaterThan(PATH_LENGTH_LIMIT);
  expectUtf16SafeLimitError(() => parseOcPath(input), `${PARSE_PREFIX}…`);
});

it("keeps overlong formatted paths UTF-16 safe", () => {
  const prefix = "a".repeat(72);
  expectUtf16SafeLimitError(
    () => formatOcPath({ file: "X", section: prefix + LONG_TAIL }),
    `oc://X/${prefix}…`,
  );
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

it("jsonl per-line parser flags malformed deeply-nested values", () => {
  const depth = MAX_TRAVERSAL_DEPTH + 50;
  const nested = '{"a":'.repeat(depth) + '"x"' + "}".repeat(depth);
  const { diagnostics } = parseJsonl(nested + "\n");
  expect(diagnostics.some((d) => d.code === "OC_JSONL_LINE_MALFORMED")).toBe(true);
});
it("formatOcPath rejects a struct carrying the redaction sentinel", () => {
  expect(() => formatOcPath({ file: "AGENTS.md", section: "__OPENCLAW_REDACTED__" })).toThrow(
    /sentinel literal/,
  );
});
it("`$last` literal key on an object is shadowed by the positional sentinel", () => {
  const ast = parseJsonc('{"$last":"literal-value","foo":"bar"}').ast;
  const m = resolveOcPath(ast, parseOcPath("oc://X/$last"));
  expect(m?.kind === "leaf" && m.valueText).toBe("bar");
});
it("number coercion accepts `1.5`, refuses `1,5`", () => {
  const ast = parseJsonc('{"x":1.0}').ast;
  expect(JSON.parse(setOcPath(ast, parseOcPath("oc://X/x"), "1.5").raw)).toEqual({ x: 1.5 });
  expect(() => setOcPath(ast, parseOcPath("oc://X/x"), "1,5")).toThrow(COERCION_ERROR);
});

it("boolean coercion accepts `true` / `false` only", () => {
  const ast = parseJsonc('{"x":true}').ast;
  expect(JSON.parse(setOcPath(ast, parseOcPath("oc://X/x"), "false").raw)).toEqual({ x: false });
  for (const value of ["False", "TRUE", "yes"]) {
    expect(() => setOcPath(ast, parseOcPath("oc://X/x"), value)).toThrow(COERCION_ERROR);
  }
});
it("regex metacharacters in predicate value match literally, not as regex", () => {
  const ast = parseJsonc('{"items":[{"name":"a.*"},{"name":"abc"}]}').ast;
  const matches = findOcPaths(ast, parseOcPath("oc://X.jsonc/items/[name=a.*]"));
  expect(matches).toHaveLength(1);
});

it("rejects empty predicate body and empty key/value", () => {
  rejectPath("oc://X.jsonc/items/[]");
  rejectPath("oc://X/[=foo]", /Malformed predicate/);
  rejectPath("oc://X/[id=]", /Malformed predicate/);
});

it("predicate value containing `/` round-trips and matches literally", () => {
  const p = parseOcPath("oc://X/[id=foo/bar]/cmd");
  expect(p.section).toBe("[id=foo/bar]");
  const ast = parseJsonc('{"steps":[{"id":"foo/bar","cmd":"x"},{"id":"baz","cmd":"y"}]}').ast;
  const matches = findOcPaths(ast, parseOcPath("oc://wf/steps/[id=foo/bar]/cmd"));
  expect(matches).toHaveLength(1);
});
it("rejects empty union and empty alternative", () => {
  rejectPath("oc://X/{}", /Empty union/);
  rejectPath("oc://X/{a,,b}", /Empty alternative/);
});

it("rejects empty dotted sub-segment in formatOcPath output", () => {
  expect(() => formatOcPath({ file: "a.md", section: "foo." })).toThrow(/Empty dotted/);
  expect(() => formatOcPath({ file: "a.md", section: ".foo" })).toThrow(/Empty dotted/);
  expect(() => formatOcPath({ file: "a.md", section: "foo..bar" })).toThrow(/Empty dotted/);
});
