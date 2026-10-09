// OC Path tests cover sentinel cross kind plugin behavior.
import { describe, expect, it } from "vitest";
import { insertJsoncOcPath, setJsoncOcPath } from "../../jsonc/edit.js";
import { parseJsonc } from "../../jsonc/parse.js";
import { parseOcPath } from "../../oc-path.js";
import { OcEmitSentinelError, REDACTED_SENTINEL } from "../../sentinel.js";

describe("sentinel guard cross-kind", () => {
  it("jsonc edits reject caller-injected sentinels before mutation", () => {
    const ast = parseJsonc('{ "x": "ok" }').ast;
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
});
