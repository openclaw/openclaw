import { describe, expect, it } from "vitest";
import { insertJsoncOcPath, setJsoncOcPath } from "../../jsonc/edit.js";
import { parseJsonc } from "../../jsonc/parse.js";
import { appendJsonlOcPath, setJsonlOcPath } from "../../jsonl/edit.js";
import { parseJsonl } from "../../jsonl/parse.js";
import { parseOcPath } from "../../oc-path.js";
import { OcEmitSentinelError, REDACTED_SENTINEL } from "../../sentinel.js";

describe("sentinel guard cross-kind", () => {
  it.each([
    [`"${REDACTED_SENTINEL}"`, ""],
    [`{"tokens":["prefix${REDACTED_SENTINEL}suffix"]}`, "/tokens/0"],
    [`{"${REDACTED_SENTINEL}":1}`, `/${REDACTED_SENTINEL}`],
    [`[{"prefix${REDACTED_SENTINEL}suffix":1}]`, `/0/prefix${REDACTED_SENTINEL}suffix`],
  ])("refuses new sentinel content before mutation: %s", (raw, suffix) => {
    const value = parseJsonc(raw).root;
    if (!value) {
      throw new Error("Expected a parsed JSON fixture");
    }
    for (const operation of ["set", "insert"] as const) {
      const ast = parseJsonc('{ "x": "ok" }');
      expect(() =>
        operation === "set"
          ? setJsoncOcPath(ast, parseOcPath("oc://config/x"), value)
          : insertJsoncOcPath(ast, parseOcPath("oc://config"), "x2", value),
      ).toThrow(`sentinel literal at oc://config/${operation === "set" ? "x" : "x2"}${suffix}`);
      expect(ast.raw).toBe('{ "x": "ok" }');
    }
    const lines = parseJsonl('{"x":"ok"}\n');
    expect(() => setJsonlOcPath(lines, parseOcPath("oc://config.jsonl/L1"), value)).toThrow(
      OcEmitSentinelError,
    );
    expect(() => appendJsonlOcPath(lines, value)).toThrow(OcEmitSentinelError);
    expect(lines.raw).toBe('{"x":"ok"}\n');
  });
});
