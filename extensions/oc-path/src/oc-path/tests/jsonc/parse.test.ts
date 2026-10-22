import { describe, expect, it } from "vitest";
import { parseJsonc } from "../../jsonc/parse.js";

const JSONC_INPUT_LIMIT_BYTES = 16 * 1024 * 1024;

describe.each(["\n", "\r\n"])("parseJsonc line positions with %j line endings", (newline) => {
  it.each(["", "\uFEFF"])("locates column-one tokens with prefix %j", (prefix) => {
    const raw = prefix + ["", "{", '"items":[', "42", "]", "}"].join(newline);
    const ast = parseJsonc(raw);
    expect(ast.raw).toBe(raw);
    expect(ast.root).toEqual({
      kind: "object",
      line: 2,
      entries: [
        {
          key: "items",
          line: 3,
          value: {
            kind: "array",
            line: 3,
            items: [{ kind: "number", value: 42, line: 4 }],
          },
        },
      ],
    });
  });

  it.each(["", "\uFEFF"])("rejects column-one invalid symbols with prefix %j", (prefix) => {
    const raw = prefix + ["{", "?", "}"].join(newline);
    const ast = parseJsonc(raw);
    expect(ast.raw).toBe(raw);
    expect(ast.root).toBeNull();
  });
});

describe("parseJsonc — basic shapes", () => {
  it("parses scalars", () => {
    expect(parseJsonc("42").root).toEqual({ kind: "number", value: 42, line: 1 });
    expect(parseJsonc("-3.14").root).toEqual({ kind: "number", value: -3.14, line: 1 });
    expect(parseJsonc("1e3").root).toEqual({ kind: "number", value: 1000, line: 1 });
    expect(parseJsonc('"hello"').root).toEqual({ kind: "string", value: "hello", line: 1 });
    expect(parseJsonc("true").root).toEqual({ kind: "boolean", value: true, line: 1 });
    expect(parseJsonc("false").root).toEqual({ kind: "boolean", value: false, line: 1 });
    expect(parseJsonc("null").root).toEqual({ kind: "null", line: 1 });
  });
});

describe("parseJsonc — soft errors", () => {
  it("returns null root on unrecoverable input", () => {
    const ast = parseJsonc('{ "x" 1 }');
    expect(ast.root).toBeNull();
  });

  it.each(["1 garbage", "1 2"])("retains a valid value before trailing input: %s", (raw) => {
    expect(parseJsonc(raw)).toEqual({
      kind: "jsonc",
      raw,
      root: { kind: "number", value: 1, line: 1 },
    });
  });

  it("measures the input cap in UTF-8 bytes", () => {
    const oversized = `"${"\u754c".repeat(Math.floor(JSONC_INPUT_LIMIT_BYTES / 3) + 1)}"`;
    expect(oversized.length).toBeLessThan(JSONC_INPUT_LIMIT_BYTES);

    const ast = parseJsonc(oversized);
    expect(ast.raw).toBe(oversized);
    expect(ast.root).toBeNull();
  });
});
