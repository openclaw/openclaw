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

describe("setYamlOcPath — direct", () => {
  it("returns unresolved for missing path", () => {
    const { ast } = parseYaml(LOBSTER);
    const r = setYamlOcPath(ast, parseOcPath("oc://workflow.lobster/missing"), "x");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("unresolved");
    }
  });

  it("returns parse-error before editing a malformed document", () => {
    const { ast } = parseYaml("key: value\n  bad indent: oops\n");
    const r = setYamlOcPath(ast, parseOcPath("oc://workflow.yaml/key"), "new-value");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("parse-error");
    }
  });

  it("returns parse-error before inserting into a malformed document", () => {
    const { ast } = parseYaml("key: value\n  bad indent: oops\n");
    const r = insertYamlOcPath(
      ast,
      parseOcPath("oc://workflow.yaml"),
      { kind: "keyed", key: "next" },
      "x",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("parse-error");
    }
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
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ast.raw).toContain("id: fetch-renamed");
    }
  });

  it("edits the last seq element via $last", () => {
    const { ast } = parseYaml(LOBSTER);
    const r = setYamlOcPath(
      ast,
      parseOcPath("oc://workflow.lobster/steps/$last/id"),
      "classify-renamed",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ast.raw).toContain("id: classify-renamed");
    }
  });

  it("edits the first map entry via $first", () => {
    const { ast } = parseYaml("config:\n  a: 1\n  b: 2\n  c: 3\n");
    const r = setYamlOcPath(ast, parseOcPath("oc://x.yaml/config/$first"), 99);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ast.raw).toContain("a: 99");
    }
  });

  it("edits the last map entry via $last", () => {
    const { ast } = parseYaml("config:\n  a: 1\n  b: 2\n  c: 3\n");
    const r = setYamlOcPath(ast, parseOcPath("oc://x.yaml/config/$last"), 99);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ast.raw).toContain("c: 99");
    }
  });

  it("returns unresolved for $last against an empty seq", () => {
    const { ast } = parseYaml("items: []\n");
    const r = setYamlOcPath(ast, parseOcPath("oc://x.yaml/items/$last"), "x");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("unresolved");
    }
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
    expect(r.ok).toBe(true);
    if (r.ok && r.ast.kind === "yaml") {
      expect(r.ast.raw).toContain("count: 42");
    }
  });

  it("setOcPath returns parse-error for invalid coercion", () => {
    const { ast } = parseYaml("count: 5\n");
    const r = setOcPath(ast, parseOcPath("oc://x.yaml/count"), "abc");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("parse-error");
    }
  });
});

describe("universal verbs — yaml typed keys", () => {
  it.each([
    ["first: ignored\n.nan: original\n", "NaN", 2],
    ["first: ignored\n? [1, 2]\n: original\n", '"[1,2]"', 3],
    [
      "%YAML 1.1\n---\n2001-12-15: original\n",
      `"${new Date("2001-12-15T00:00:00Z").toString()}"`,
      3,
    ],
  ])(
    "keeps read locations without creating unaddressable replacement keys: %s",
    (raw, key, line) => {
      const { ast } = parseYaml(raw);
      const path = parseOcPath(`oc://x.yaml/${key}`);
      expect(resolveOcPath(ast, path)).toMatchObject({ valueText: "original", line });
      expect(setOcPath(ast, path, "updated")).toMatchObject({ ok: false, reason: "unresolved" });
      expect(ast.raw).toBe(raw);
    },
  );

  it.each(["200", "true", "null"])("edits the resolved %s key", (key) => {
    const { ast } = parseYaml(`${key}: original\n`);
    const path = parseOcPath(`oc://x.yaml/${key}`);
    expect(resolveOcPath(ast, path)).toMatchObject({ valueText: "original", line: 1 });
    const result = setOcPath(ast, path, "updated");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ast.raw).toBe(`${key}: updated\n`);
    }
  });

  it.each([
    ["200", "200", '"200"'],
    ["200", '"200"', "200"],
    ["true", "true", '"true"'],
    ["true", '"true"', "true"],
  ])("keeps resolve and set on the first %s key (%s before %s)", (segment, first, second) => {
    const { ast } = parseYaml(`${first}: original\n${second}: untouched\n`);
    const path = parseOcPath(`oc://x.yaml/${segment}`);
    expect(resolveOcPath(ast, path)).toMatchObject({ valueText: "original", line: 1 });
    const result = setOcPath(ast, path, "updated");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ast.raw).toBe(`${first}: updated\n${second}: untouched\n`);
    }
  });

  it.each([
    ["description: ok", "+summary", '"success"', "description: ok\n    summary: success"],
    ["[one]", "+", '"two"', "[ one, two ]"],
    ["[one]", "+0", '"zero"', "[ zero, one ]"],
  ])("inserts %s via %s under a numeric key", (contents, marker, value, expected) => {
    const { ast } = parseYaml(`responses:\n  200:\n    ${contents}\n`);
    const path = parseOcPath(`oc://x.yaml/responses/200/${marker}`);
    expect(resolveOcPath(ast, path)).toMatchObject({ kind: "insertion-point", line: 3 });
    const result = setOcPath(ast, path, value);
    expect(result.ok).toBe(true);
    if (result.ok && result.ast.kind === "yaml") {
      expect(result.ast.doc.getIn(["responses", 200])).toBeDefined();
      expect(result.ast.raw).toContain(expected);
    }
  });
});

describe("universal verbs — yaml insertion", () => {
  it("appends to an empty yaml seq with `+`", () => {
    const { ast } = parseYaml("items: []\n");
    const r = setOcPath(ast, parseOcPath("oc://x.yaml/items/+"), '"a"');
    expect(r.ok).toBe(true);
    if (r.ok && r.ast.kind === "yaml") {
      expect(r.ast.raw).toContain("items: [ a ]");
    }
  });

  it("adds key to yaml map with `+key`", () => {
    const { ast } = parseYaml("config:\n  a: 1\n");
    const r = setOcPath(ast, parseOcPath("oc://x.yaml/config/+b"), "2");
    expect(r.ok).toBe(true);
    if (r.ok && r.ast.kind === "yaml") {
      expect(r.ast.raw).toContain("b: 2");
    }
  });

  it("rejects duplicate map key on insertion", () => {
    const { ast } = parseYaml("config:\n  a: 1\n");
    const r = setOcPath(ast, parseOcPath("oc://x.yaml/config/+a"), "99");
    expect(r.ok).toBe(false);
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
