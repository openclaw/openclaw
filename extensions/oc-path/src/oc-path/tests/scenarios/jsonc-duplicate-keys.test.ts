// OC Path tests cover duplicate JSON object keys (last occurrence wins, like JSON.parse/JSON5).
import { describe, expect, it } from "vitest";
import { findOcPaths } from "../../find.js";
import { parseJsonc } from "../../jsonc/parse.js";
import { parseJsonl } from "../../jsonl/parse.js";
import { formatOcPath, parseOcPath } from "../../oc-path.js";
import { resolveOcPath, setOcPath } from "../../universal.js";

const jsoncRaw = '{\n  // old\n  "port": 1,\n  "name": "a",\n  "port": 2\n}\n';

function leafText(raw: string, path: string, kind: "jsonc" | "jsonl" = "jsonc") {
  const ast = kind === "jsonc" ? parseJsonc(raw) : parseJsonl(raw);
  const match = resolveOcPath(ast, parseOcPath(path));
  return match?.kind === "leaf" ? match.valueText : match?.kind;
}

describe("duplicate JSON object keys", () => {
  it("resolves the value JSON.parse uses", () => {
    expect(JSON.parse(jsoncRaw.replace("  // old\n", "")).port).toBe(2);
    expect(leafText(jsoncRaw, "oc://config.json/port")).toBe("2");
  });

  it("enumerates each key once with the effective value", () => {
    const matches = findOcPaths(parseJsonc(jsoncRaw), parseOcPath("oc://config.json/*"));
    expect(
      matches.map((m) => [formatOcPath(m.path), m.match.kind === "leaf" ? m.match.valueText : ""]),
    ).toEqual([
      ["oc://config.json/name", "a"],
      ["oc://config.json/port", "2"],
    ]);
  });

  it("writes the effective occurrence and leaves the shadowed one untouched", () => {
    const next = setOcPath(parseJsonc(jsoncRaw), parseOcPath("oc://config.json/port"), "5");
    expect(next.raw).toBe('{\n  // old\n  "port": 1,\n  "name": "a",\n  "port": 5\n}\n');
  });

  it("follows the last duplicate through nested objects, including a shape change", () => {
    const raw = '{"a":{"b":1},"a":{"b":2,"c":{"d":1,"d":3}}}';
    expect(leafText(raw, "oc://x.json/a.b")).toBe("2");
    expect(leafText(raw, "oc://x.json/a.c.d")).toBe("3");
    expect(setOcPath(parseJsonc(raw), parseOcPath("oc://x.json/a.c.d"), "4").raw).toBe(
      '{"a":{"b":1},"a":{"b":2,"c":{"d":1,"d":4}}}',
    );
    const scalarWins = '{"a":{"b":1},"a":7}';
    expect(resolveOcPath(parseJsonc(scalarWins), parseOcPath("oc://x.json/a.b"))).toBeNull();
    expect(leafText(scalarWins, "oc://x.json/a")).toBe("7");
  });

  it("applies the same rule to JSONL records", () => {
    const raw = '{"a":1,"a":2}\n';
    expect(leafText(raw, "oc://log.jsonl/L1/a", "jsonl")).toBe("2");
    expect(setOcPath(parseJsonl(raw), parseOcPath("oc://log.jsonl/L1/a"), "9").raw).toBe(
      '{"a":1,"a":9}\n',
    );
  });

  it("refuses to insert under a key whose earlier duplicate jsonc-parser would pick", () => {
    expect(() =>
      setOcPath(parseJsonc('{"a":{},"a":{"b":1}}'), parseOcPath("oc://x.json/a/+c"), "1"),
    ).toThrow(
      expect.objectContaining({
        reason: "not-writable",
        message: expect.stringContaining("merge the duplicate keys"),
      }),
    );
  });
});
