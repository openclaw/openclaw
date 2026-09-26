// OC Path tests cover sentinel cross kind plugin behavior.
import { describe, expect, it } from "vitest";
import { insertJsoncOcPath, setJsoncOcPath } from "../../jsonc/edit.js";
import { emitJsonc } from "../../jsonc/emit.js";
import { parseJsonc } from "../../jsonc/parse.js";
import { emitJsonl } from "../../jsonl/emit.js";
import { parseJsonl } from "../../jsonl/parse.js";
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

  it("sentinel as object key in raw — strict mode catches it", () => {
    const raw = `{ "${REDACTED_SENTINEL}": 1 }`;
    const ast = parseJsonc(raw).ast;
    expect(emitJsonc(ast)).toBe(raw); // default-mode echo
    expect(() => emitJsonc(ast, { acceptPreExistingSentinel: false })).toThrow(OcEmitSentinelError);
  });

  it("sentinel in jsonl malformed line — strict mode catches it", () => {
    const raw = `${REDACTED_SENTINEL}\n`;
    const ast = parseJsonl(raw).ast;
    expect(emitJsonl(ast)).toBe(raw); // round-trip echoes verbatim
    expect(() => emitJsonl(ast, { acceptPreExistingSentinel: false })).toThrow(OcEmitSentinelError);
  });
});
