// OC Path tests cover sentinel cross kind plugin behavior.
import { describe, expect, it } from "vitest";
import { insertJsoncOcPath, setJsoncOcPath } from "../../jsonc/edit.js";
import { parseJsonc } from "../../jsonc/parse.js";
import { parseOcPath } from "../../oc-path.js";
import { OcEmitSentinelError, REDACTED_SENTINEL } from "../../sentinel.js";

describe("sentinel guard cross-kind", () => {
  it("jsonc edits reject caller-injected sentinels before mutation", () => {
    const ast = parseJsonc('{ "x": "ok" }');
    expect(() =>
      setJsoncOcPath(ast, parseOcPath("oc://config/x"), {
        kind: "string",
        value: REDACTED_SENTINEL,
      }),
    ).toThrow(OcEmitSentinelError);
    expect(() =>
      insertJsoncOcPath(ast, parseOcPath("oc://config"), "y", {
        kind: "string",
        value: REDACTED_SENTINEL,
      }),
    ).toThrow(OcEmitSentinelError);
  });

  it.each(["set", "insert"] as const)("reports nested sentinel paths during %s", (operation) => {
    const ast = parseJsonc('{ "x": "ok" }');
    const value = {
      kind: "object" as const,
      entries: [
        {
          key: "tokens",
          line: 0,
          value: {
            kind: "array" as const,
            items: [{ kind: "string" as const, value: `prefix${REDACTED_SENTINEL}suffix` }],
          },
        },
      ],
    };
    expect(() =>
      operation === "set"
        ? setJsoncOcPath(ast, parseOcPath("oc://config/x"), value)
        : insertJsoncOcPath(ast, parseOcPath("oc://config"), "x2", value),
    ).toThrow(`sentinel literal at oc://config/${operation === "set" ? "x" : "x2"}/tokens/0`);
    expect(ast.raw).toBe('{ "x": "ok" }');
  });
});
