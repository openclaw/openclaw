import { describe, expect, it } from "vitest";
import { inferKind } from "../../dispatch.js";
import { parseOcPath } from "../../oc-path.js";
import { OcEmitSentinelError, REDACTED_SENTINEL } from "../../sentinel.js";
import { resolveOcPath, setOcPath } from "../../universal.js";
import { insertYamlOcPath, setYamlOcPath } from "../../yaml/edit.js";
import { parseYaml } from "../../yaml/parse.js";

const LOBSTER = "name: inbox-triage\nsteps:\n  - id: fetch\n  - id: classify\n";
const MALFORMED = "key: value\n  bad indent: oops\n";
const path = (address: string) => parseOcPath(`oc://workflow.yaml/${address}`);
const set = (raw: string, address: string, value: string) =>
  setOcPath(parseYaml(raw), path(address), value);
const error = (reason: string) => expect.objectContaining({ reason });
const timestampSpelling = new Date("2001-12-15T00:00:00Z").toString();
const timestampRow = "2001-12-15: original";
const stringRow = `${JSON.stringify(timestampSpelling)}: untouched`;

describe("YAML", () => {
  it.each([
    { operation: "leaf replacement", address: "name", value: "updated" },
    { operation: "map insertion", address: "options/+enabled", value: "true" },
    { operation: "sequence append", address: "items/+", value: "2" },
    { operation: "indexed insertion", address: "items/+0", value: "2" },
  ])("preserves untouched numeric sources during $operation", ({ address, value }) => {
    const before =
      "id: 9007199254740993\nratio: 1.0000000000000001\nname: old\n" +
      "options: {}\nitems: [9007199254740995]\n";
    const ast = parseYaml(before);
    const result = setOcPath(ast, path(address), value);

    expect(result.raw).toContain("id: 9007199254740993\n");
    expect(result.raw).toContain("ratio: 1.0000000000000001\n");
    expect(result.raw).toContain("9007199254740995");
    expect(typeof parseYaml(result.raw).doc.get("id")).toBe("number");
    expect(ast.raw).toBe(before);
  });

  it("replaces the selected numeric source even when its rounded value is unchanged", () => {
    const result = set(
      "untouched: 9007199254740993\nselected: 1.0000000000000001\n",
      "selected",
      "1",
    );
    expect(result.raw).toBe("untouched: 9007199254740993\nselected: 1\n");
  });
  it.each([
    [LOBSTER, "missing", "unresolved"],
    [MALFORMED, "key", "parse-error"],
    ["items: []\n", "items/$last", "unresolved"],
  ])("rejects direct edits of %s at %s: %s", (raw, address, reason) => {
    expect(() => setYamlOcPath(parseYaml(raw), path(address), "x")).toThrow(error(reason));
  });

  it("reports parse-error before inserting into a malformed document", () => {
    expect(() =>
      insertYamlOcPath(
        parseYaml(MALFORMED),
        parseOcPath("oc://workflow.yaml"),
        { kind: "keyed", key: "next" },
        "x",
      ),
    ).toThrow(error("parse-error"));
  });

  it.each([
    [LOBSTER, "steps/$first/id", "fetch-renamed", "id: fetch-renamed"],
    [LOBSTER, "steps/$last/id", "classify-renamed", "id: classify-renamed"],
    ["config:\n  a: 1\n  b: 2\n  c: 3\n", "config/$first", 99, "a: 99"],
    ["config:\n  a: 1\n  b: 2\n  c: 3\n", "config/$last", 99, "c: 99"],
  ])("edits %s at %s", (raw, address, value, expected) => {
    expect(setYamlOcPath(parseYaml(raw), path(address), value).raw).toContain(expected);
  });

  it("maps .yaml / .yml / .lobster to yaml", () => {
    expect(inferKind("workflow.yaml")).toBe("yaml");
    expect(inferKind("config.yml")).toBe("yaml");
    expect(inferKind("inbox-triage.lobster")).toBe("yaml");
  });
  it.each([
    { text: "1", key: 1 },
    { text: "true", key: true },
    { text: "null", key: null },
  ])("edits a YAML map's native $text key", ({ text, key }) => {
    const result = set(`${text}: old\nuntouched: keep\n`, text, "updated");
    const written = parseYaml(result.raw).doc;
    expect(written.get(key)).toBe("updated");
    expect(written.get("untouched")).toBe("keep");
  });

  it.each([
    [LOBSTER, "name", { kind: "leaf", valueText: "inbox-triage", leafType: "string" }],
    [LOBSTER, "steps.0", { kind: "node", descriptor: "yaml-map" }],
    ["name: inbox\n", "+owner", { kind: "insertion-point", container: "yaml-map" }],
    ["- a\n", "+", { kind: "insertion-point", container: "yaml-seq" }],
  ])("resolves %s at %s", (raw, address, expected) => {
    expect(resolveOcPath(parseYaml(raw), path(address))).toMatchObject(expected);
  });

  it("resolveOcPath rejects insertion under scalar root", () => {
    expect(resolveOcPath(parseYaml("hello\n"), path("+"))).toBeNull();
  });

  it("setOcPath coerces numeric string to number for number leaf", () => {
    expect(set("count: 5\n", "count", "42").raw).toContain("count: 42");
  });

  it.each([
    ["count: 5\n", "count", "abc", "parse-error"],
    ["config:\n  a: 1\n", "config/+a", "99", "unresolved"],
  ])("rejects universal edits of %s at %s", (raw, address, value, reason) => {
    expect(() => set(raw, address, value)).toThrow(error(reason));
  });

  it.each([
    [[timestampRow], "original"],
    [[timestampRow, stringRow], "original"],
    [[stringRow, timestampRow], "untouched"],
  ] as const)("does not redirect edits after cloning: %s", (rows, valueText) => {
    const raw = `%YAML 1.1\n---\n${rows.join("\n")}\n`;
    const ast = parseYaml(raw);
    const targetPath = parseOcPath(`oc://x.yaml/${JSON.stringify(timestampSpelling)}`);
    expect(resolveOcPath(ast, targetPath)).toMatchObject({ valueText, line: 3 });
    if (valueText === "untouched") {
      const result = setOcPath(ast, targetPath, "updated");
      expect(result.raw).toBe(raw.replace(": untouched", ": updated"));
    } else {
      expect(() => setOcPath(ast, targetPath, "updated")).toThrow(error("unresolved"));
    }
    expect(ast.raw).toBe(raw);
  });

  it.each([
    ["items: []\n", "items/+", '"a"', "items: [ a ]"],
    ["config:\n  a: 1\n", "config/+b", "2", "b: 2"],
  ])("inserts into %s at %s", (raw, address, value, expected) => {
    expect(set(raw, address, value).raw).toContain(expected);
  });

  it.each([
    ["token: safe\n", "token", REDACTED_SENTINEL],
    ["items: []\n", "items/+", `{"token":"${REDACTED_SENTINEL}"}`],
    ["config:\n  safe: 1\n", `config/+${REDACTED_SENTINEL}`, "2"],
    ["items: []\n", "items/+", `{"${REDACTED_SENTINEL}":"2"}`],
  ])("rejects sentinel-bearing YAML before raw emit: %s at %s", (raw, address, value) => {
    expect(() => set(raw, address, value)).toThrow(OcEmitSentinelError);
  });
});
