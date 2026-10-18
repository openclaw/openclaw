// OC Path tests cover yaml kind plugin behavior.
import { describe, expect, it } from "vitest";
import { inferKind } from "../../dispatch.js";
import { parseOcPath } from "../../oc-path.js";
import { OcEmitSentinelError, REDACTED_SENTINEL } from "../../sentinel.js";
import { resolveOcPath, setOcPath } from "../../universal.js";
import { insertYamlOcPath, setYamlOcPath } from "../../yaml/edit.js";
import { parseYaml } from "../../yaml/parse.js";

const LOBSTER = `name: inbox-triage
description: A simple example workflow

steps:
  - id: fetch
    command: gog.gmail.search --query 'newer_than:1d' --max 20

  - id: classify
    command: openclaw.invoke --tool llm-task --action json
    stdin: $fetch.stdout
`;

describe("YAML numeric source preservation", () => {
  it.each([
    { operation: "leaf replacement", address: "name", value: "updated" },
    { operation: "map insertion", address: "options/+enabled", value: "true" },
    { operation: "sequence append", address: "items/+", value: "2" },
    { operation: "indexed insertion", address: "items/+0", value: "2" },
  ])("preserves untouched numeric sources during $operation", ({ address, value }) => {
    const before =
      "id: 9007199254740993\nratio: 1.0000000000000001\nname: old\n" +
      "options: {}\nitems: [9007199254740995]\n";
    const ast = parseYaml(before).ast;
    const result = setOcPath(ast, parseOcPath(`oc://workflow.yaml/${address}`), value);

    expect(result.raw).toContain("id: 9007199254740993\n");
    expect(result.raw).toContain("ratio: 1.0000000000000001\n");
    expect(result.raw).toContain("9007199254740995");
    expect(typeof parseYaml(result.raw).ast.doc.get("id")).toBe("number");
    expect(ast.raw).toBe(before);
  });

  it("replaces the selected numeric source even when its rounded value is unchanged", () => {
    const ast = parseYaml("untouched: 9007199254740993\nselected: 1.0000000000000001\n").ast;
    const result = setOcPath(ast, parseOcPath("oc://workflow.yaml/selected"), "1");

    expect(result.raw).toBe("untouched: 9007199254740993\nselected: 1\n");
  });
});

describe("setYamlOcPath — direct", () => {
  it("reports unresolved for missing path", () => {
    const { ast } = parseYaml(LOBSTER);
    expect(() => setYamlOcPath(ast, parseOcPath("oc://workflow.lobster/missing"), "x")).toThrow(
      expect.objectContaining({ reason: "unresolved" }),
    );
  });

  it("reports parse-error before editing a malformed document", () => {
    const { ast } = parseYaml("key: value\n  bad indent: oops\n");
    expect(() => setYamlOcPath(ast, parseOcPath("oc://workflow.yaml/key"), "new-value")).toThrow(
      expect.objectContaining({ reason: "parse-error" }),
    );
  });

  it("reports parse-error before inserting into a malformed document", () => {
    const { ast } = parseYaml("key: value\n  bad indent: oops\n");
    expect(() =>
      insertYamlOcPath(ast, parseOcPath("oc://workflow.yaml"), { kind: "keyed", key: "next" }, "x"),
    ).toThrow(expect.objectContaining({ reason: "parse-error" }));
  });
});

describe("setYamlOcPath — positional tokens", () => {
  it("edits the first seq element via $first", () => {
    const { ast } = parseYaml(LOBSTER);
    const r = setYamlOcPath(
      ast,
      parseOcPath("oc://workflow.lobster/steps/$first/id"),
      "fetch-renamed",
    );
    expect(r.raw).toContain("id: fetch-renamed");
  });

  it("edits the last seq element via $last", () => {
    const { ast } = parseYaml(LOBSTER);
    const r = setYamlOcPath(
      ast,
      parseOcPath("oc://workflow.lobster/steps/$last/id"),
      "classify-renamed",
    );
    expect(r.raw).toContain("id: classify-renamed");
  });

  it("edits the first map entry via $first", () => {
    const { ast } = parseYaml("config:\n  a: 1\n  b: 2\n  c: 3\n");
    const r = setYamlOcPath(ast, parseOcPath("oc://x.yaml/config/$first"), 99);
    expect(r.raw).toContain("a: 99");
  });

  it("edits the last map entry via $last", () => {
    const { ast } = parseYaml("config:\n  a: 1\n  b: 2\n  c: 3\n");
    const r = setYamlOcPath(ast, parseOcPath("oc://x.yaml/config/$last"), 99);
    expect(r.raw).toContain("c: 99");
  });

  it("reports unresolved for $last against an empty seq", () => {
    const { ast } = parseYaml("items: []\n");
    expect(() => setYamlOcPath(ast, parseOcPath("oc://x.yaml/items/$last"), "x")).toThrow(
      expect.objectContaining({ reason: "unresolved" }),
    );
  });
});

describe("inferKind — yaml extensions", () => {
  it("maps .yaml / .yml / .lobster to yaml", () => {
    expect(inferKind("workflow.yaml")).toBe("yaml");
    expect(inferKind("config.yml")).toBe("yaml");
    expect(inferKind("inbox-triage.lobster")).toBe("yaml");
  });
});

describe("universal verbs — yaml dispatch", () => {
  it.each([
    { text: "1", key: 1 },
    { text: "true", key: true },
    { text: "null", key: null },
  ])("edits a YAML map's native $text key", ({ text, key }) => {
    const ast = parseYaml(`${text}: old\nuntouched: keep\n`).ast;
    const result = setOcPath(ast, parseOcPath(`oc://workflow.yaml/${text}`), "updated");

    const written = parseYaml(result.raw).ast.doc;
    expect(written.get(key)).toBe("updated");
    expect(written.get("untouched")).toBe("keep");
  });

  it("resolveOcPath returns kind-agnostic match for yaml leaf", () => {
    const { ast } = parseYaml(LOBSTER);
    const m = resolveOcPath(ast, parseOcPath("oc://workflow.lobster/name"));
    expect(m).toMatchObject({ kind: "leaf", valueText: "inbox-triage", leafType: "string" });
  });

  it("resolveOcPath returns node:yaml-map for top-level seq item", () => {
    const { ast } = parseYaml(LOBSTER);
    const m = resolveOcPath(ast, parseOcPath("oc://workflow.lobster/steps.0"));
    expect(m).toMatchObject({ kind: "node", descriptor: "yaml-map" });
  });

  it("resolveOcPath returns yaml-map insertion for map root", () => {
    const { ast } = parseYaml("name: inbox\n");
    const m = resolveOcPath(ast, parseOcPath("oc://workflow.yaml/+owner"));
    expect(m).toMatchObject({ kind: "insertion-point", container: "yaml-map" });
  });

  it("resolveOcPath returns yaml-seq insertion for sequence root", () => {
    const { ast } = parseYaml("- a\n");
    const m = resolveOcPath(ast, parseOcPath("oc://items.yaml/+"));
    expect(m).toMatchObject({ kind: "insertion-point", container: "yaml-seq" });
  });

  it("resolveOcPath rejects insertion under scalar root", () => {
    const { ast } = parseYaml("hello\n");
    const m = resolveOcPath(ast, parseOcPath("oc://value.yaml/+"));
    expect(m).toBeNull();
  });

  it("setOcPath coerces numeric string to number for number leaf", () => {
    const { ast } = parseYaml("count: 5\n");
    const r = setOcPath(ast, parseOcPath("oc://x.yaml/count"), "42");
    expect(r.raw).toContain("count: 42");
  });

  it("setOcPath reports parse-error for invalid coercion", () => {
    const { ast } = parseYaml("count: 5\n");
    expect(() => setOcPath(ast, parseOcPath("oc://x.yaml/count"), "abc")).toThrow(
      expect.objectContaining({ reason: "parse-error" }),
    );
  });
});

describe("universal verbs — yaml insertion", () => {
  it("appends to an empty yaml seq with `+`", () => {
    const { ast } = parseYaml("items: []\n");
    const r = setOcPath(ast, parseOcPath("oc://x.yaml/items/+"), '"a"');
    expect(r.raw).toContain("items: [ a ]");
  });

  it("adds key to yaml map with `+key`", () => {
    const { ast } = parseYaml("config:\n  a: 1\n");
    const r = setOcPath(ast, parseOcPath("oc://x.yaml/config/+b"), "2");
    expect(r.raw).toContain("b: 2");
  });

  it("rejects duplicate map key on insertion", () => {
    const { ast } = parseYaml("config:\n  a: 1\n");
    expect(() => setOcPath(ast, parseOcPath("oc://x.yaml/config/+a"), "99")).toThrow(
      expect.objectContaining({ reason: "unresolved" }),
    );
  });

  it("rejects sentinel-bearing yaml replacements before raw emit", () => {
    const { ast } = parseYaml("token: safe\n");
    expect(() => setOcPath(ast, parseOcPath("oc://x.yaml/token"), REDACTED_SENTINEL)).toThrow(
      OcEmitSentinelError,
    );
  });

  it("rejects sentinel-bearing yaml insertions before raw emit", () => {
    const { ast } = parseYaml("items: []\n");
    expect(() =>
      setOcPath(ast, parseOcPath("oc://x.yaml/items/+"), `{"token":"${REDACTED_SENTINEL}"}`),
    ).toThrow(OcEmitSentinelError);
  });

  it("rejects sentinel-bearing yaml insertion keys before raw emit", () => {
    const { ast } = parseYaml("config:\n  safe: 1\n");
    expect(() =>
      setOcPath(ast, parseOcPath(`oc://x.yaml/config/+${REDACTED_SENTINEL}`), "2"),
    ).toThrow(OcEmitSentinelError);
  });

  it("rejects sentinel-bearing yaml object keys before raw emit", () => {
    const { ast } = parseYaml("items: []\n");
    expect(() =>
      setOcPath(ast, parseOcPath("oc://x.yaml/items/+"), `{"${REDACTED_SENTINEL}":"2"}`),
    ).toThrow(OcEmitSentinelError);
  });
});
