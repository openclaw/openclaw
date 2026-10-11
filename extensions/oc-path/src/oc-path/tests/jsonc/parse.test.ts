// OC Path tests cover parse plugin behavior.
import { describe, expect, it } from "vitest";
import { parseJsonc } from "../../jsonc/parse.js";

const JSONC_INPUT_LIMIT_BYTES = 16 * 1024 * 1024;

describe.each(["\n", "\r\n"])("parseJsonc line positions with %j line endings", (newline) => {
  it.each(["", "\uFEFF"])("locates column-one tokens with prefix %j", (prefix) => {
    const raw = prefix + ["", "{", '"items":[', "42", "]", "}"].join(newline);
    const { ast, diagnostics } = parseJsonc(raw);
    expect(diagnostics).toEqual([]);
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

  it.each(["", "\uFEFF"])("locates column-one errors with prefix %j", (prefix) => {
    const raw = prefix + ["{", "?", "}"].join(newline);
    const { ast, diagnostics } = parseJsonc(raw);
    expect(ast.raw).toBe(raw);
    expect(ast.root).toBeNull();
    expect(diagnostics).toContainEqual({
      line: 2,
      message: "InvalidSymbol",
      severity: "error",
      code: "OC_JSONC_PARSE_FAILED",
    });
  });
});

describe("parseJsonc — basic shapes", () => {
  it("parses scalars", () => {
    expect(parseJsonc("42").ast.root).toEqual({ kind: "number", value: 42, line: 1 });
    expect(parseJsonc("-3.14").ast.root).toEqual({ kind: "number", value: -3.14, line: 1 });
    expect(parseJsonc("1e3").ast.root).toEqual({ kind: "number", value: 1000, line: 1 });
    expect(parseJsonc('"hello"').ast.root).toEqual({ kind: "string", value: "hello", line: 1 });
    expect(parseJsonc("true").ast.root).toEqual({ kind: "boolean", value: true, line: 1 });
    expect(parseJsonc("false").ast.root).toEqual({ kind: "boolean", value: false, line: 1 });
    expect(parseJsonc("null").ast.root).toEqual({ kind: "null", line: 1 });
  });
});

describe("parseJsonc — soft errors", () => {
  it("returns null root + error diagnostic on unrecoverable input", () => {
    const { ast, diagnostics } = parseJsonc('{ "x" 1 }');
    expect(ast.root).toBeNull();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.severity).toBe("error");
  });

  it("warns on trailing input after a valid value", () => {
    const { diagnostics } = parseJsonc("1 garbage");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.severity).toBe("warning");
    expect(diagnostics[0]?.code).toBe("OC_JSONC_TRAILING_INPUT");
  });

  it("measures the input cap in UTF-8 bytes", () => {
    const oversized = `"${"\u754c".repeat(Math.floor(JSONC_INPUT_LIMIT_BYTES / 3) + 1)}"`;
    expect(oversized.length).toBeLessThan(JSONC_INPUT_LIMIT_BYTES);

    const { ast, diagnostics } = parseJsonc(oversized);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.severity).toBe("error");
    expect(diagnostics[0]?.message).toContain(`got ${Buffer.byteLength(oversized, "utf8")}`);
    expect(diagnostics[0]?.code).toBe("OC_JSONC_INPUT_TOO_LARGE");
    expect(ast.root).toBeNull();
  });
});
