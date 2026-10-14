// OC Path tests cover universal plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { parseJsonc } from "../jsonc/parse.js";
import { parseJsonl } from "../jsonl/parse.js";
import { parseOcPath } from "../oc-path.js";
import { parseMd } from "../parse.js";
import { REDACTED_SENTINEL } from "../sentinel.js";
import { resolveOcPath, setOcPath } from "../universal.js";
import { parseYaml } from "../yaml/parse.js";

function expectLeaf(
  match: ReturnType<typeof resolveOcPath>,
  expected: { leafType: string; valueText: string },
) {
  expect(match?.kind).toBe("leaf");
  if (match?.kind === "leaf") {
    expect(match.leafType).toBe(expected.leafType);
    expect(match.valueText).toBe(expected.valueText);
  }
}

function expectNode(match: ReturnType<typeof resolveOcPath>, descriptor: string) {
  expect(match?.kind).toBe("node");
  if (match?.kind === "node") {
    expect(match.descriptor).toBe(descriptor);
  }
}

function expectInsertionPoint(match: ReturnType<typeof resolveOcPath>, container: string) {
  expect(match?.kind).toBe("insertion-point");
  if (match?.kind === "insertion-point") {
    expect(match.container).toBe(container);
  }
}

describe("resolveOcPath — md AST", () => {
  const md = parseMd("---\nname: github\n---\n\n## Boundaries\n\n- enabled: true\n").ast;

  it("returns root for file-only path", () => {
    const m = resolveOcPath(md, parseOcPath("oc://X.md"));
    expect(m?.kind).toBe("root");
  });
});

describe("resolveOcPath — jsonc AST", () => {
  const ast = parseJsonc('{ "k": 42, "s": "x", "b": true, "n": null, "arr": [1,2,3] }').ast;

  it("returns leaf:null for null value", () => {
    const m = resolveOcPath(ast, parseOcPath("oc://config/n"));
    expectLeaf(m, { valueText: "null", leafType: "null" });
  });

  it("returns node:jsonc-array for array value", () => {
    const m = resolveOcPath(ast, parseOcPath("oc://config/arr"));
    expectNode(m, "jsonc-array");
  });
});

describe("resolveOcPath — jsonl AST", () => {
  const ast = parseJsonl('{"event":"start","n":1}\n{"event":"step","n":2}\n').ast;

  it("returns node:jsonl-line for line address", () => {
    const m = resolveOcPath(ast, parseOcPath("oc://log/L1"));
    expectNode(m, "jsonl-line");
  });
});

describe("resolveOcPath — insertion-point detection", () => {
  it("returns insertion-point for md section append", () => {
    const md = parseMd("## Tools\n").ast;
    const m = resolveOcPath(md, parseOcPath("oc://X.md/tools/+"));
    expectInsertionPoint(m, "md-section");
  });

  it("returns insertion-point for md file-level", () => {
    const md = parseMd("## Tools\n").ast;
    const m = resolveOcPath(md, parseOcPath("oc://X.md/+"));
    expectInsertionPoint(m, "md-file");
  });

  it("returns insertion-point for md frontmatter +key", () => {
    const md = parseMd("---\nname: x\n---\n").ast;
    const m = resolveOcPath(md, parseOcPath("oc://X.md/[frontmatter]/+description"));
    expectInsertionPoint(m, "md-frontmatter");
  });

  it("returns insertion-point for jsonl file-root +", () => {
    const ast = parseJsonl("").ast;
    const m = resolveOcPath(ast, parseOcPath("oc://log/+"));
    expectInsertionPoint(m, "jsonl-file");
  });

  it("returns null when insertion target is not a container", () => {
    const ast = parseJsonc('{ "k": 42 }').ast;
    const m = resolveOcPath(ast, parseOcPath("oc://config/k/+"));
    expect(m).toBeNull();
  });
});

describe("resolveOcPath — yaml AST", () => {
  it("preserves source line lookup for numeric map keys", () => {
    const ast = parseYaml("name: x\n1: one\n").ast;
    const m = resolveOcPath(ast, parseOcPath("oc://workflow.yaml/1"));

    expectLeaf(m, { valueText: "one", leafType: "string" });
    expect(m?.line).toBe(2);
  });
});

describe("setOcPath — jsonc leaf with coercion", () => {
  it('coerces "true"/"false" when leaf was boolean', () => {
    const ast = parseJsonc('{ "k": true }').ast;
    const r = setOcPath(ast, parseOcPath("oc://config/k"), "false");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(JSON.parse(r.ast.raw)).toEqual({ k: false });
    }
  });

  it("rejects non-numeric string for number leaf", () => {
    const ast = parseJsonc('{ "k": 1 }').ast;
    const r = setOcPath(ast, parseOcPath("oc://config/k"), "not-a-number");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("parse-error");
    }
  });

  it("rejects non-bool string for boolean leaf", () => {
    const ast = parseJsonc('{ "k": true }').ast;
    const r = setOcPath(ast, parseOcPath("oc://config/k"), "maybe");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("parse-error");
    }
  });

  it("resolves slash-deep JSONC paths", () => {
    const ast = parseJsonc(
      '{ "agents": { "entries": { "main": { "tools": { "exec": { "security": "deny" } } } } } }',
    ).ast;
    const r = setOcPath(
      ast,
      parseOcPath("oc://openclaw.json/agents/entries/main/tools/exec/security"),
      "allowlist",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(JSON.parse(r.ast.raw)).toEqual({
        agents: { entries: { main: { tools: { exec: { security: "allowlist" } } } } },
      });
    }
  });

  it("replaces a JSONC leaf with parsed JSON when requested", () => {
    const ast = parseJsonc('{ "token": "${TOKEN}" }').ast;
    const r = setOcPath(
      ast,
      parseOcPath("oc://openclaw.json/token"),
      '{"source":"file","provider":"secrets","id":"/test"}',
      { valueJson: true },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(JSON.parse(r.ast.raw)).toEqual({
        token: { source: "file", provider: "secrets", id: "/test" },
      });
    }
  });

  it("rejects non-finite parsed JSON replacement values", () => {
    const ast = parseJsonc('{ "limit": 1 }').ast;
    const r = setOcPath(ast, parseOcPath("oc://openclaw.json/limit"), "1e999", {
      valueJson: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("parse-error");
    }
  });
});

describe("setOcPath — jsonl leaf", () => {
  it("replaces whole line via JSON value", () => {
    const ast = parseJsonl('{"event":"start"}\n').ast;
    const r = setOcPath(ast, parseOcPath("oc://log/L1"), '{"event":"replaced"}');
    expect(r.ok).toBe(true);
    if (r.ok) {
      const out = r.ast.raw;
      expect(JSON.parse(expectDefined(out.split("\n")[0], "replaced JSONL line"))).toEqual({
        event: "replaced",
      });
    }
  });

  it("rejects malformed JSON for whole-line replacement", () => {
    const ast = parseJsonl('{"event":"start"}\n').ast;
    const r = setOcPath(ast, parseOcPath("oc://log/L1"), "not json");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("parse-error");
    }
  });
});

describe("setOcPath — md insertion", () => {
  it.each([["oc://X.md/tools/+", "## Tools\n- keep: stable\n"]])(
    "refuses sentinel-bearing Markdown insertion values at %s",
    (uri, raw) => {
      const md = parseMd(raw).ast;
      const before = structuredClone(md);
      for (const value of [REDACTED_SENTINEL, `before${REDACTED_SENTINEL}after`]) {
        expect(() => setOcPath(md, parseOcPath(uri), value)).toThrow(
          expect.objectContaining({ code: "OC_EMIT_SENTINEL", path: uri }),
        );
        expect(md).toEqual(before);
      }
    },
  );

  it("keeps the insertion-value guard separate from new frontmatter keys", () => {
    const md = parseMd("---\nname: x\n---\n").ast;
    const result = setOcPath(
      md,
      parseOcPath(`oc://X.md/[frontmatter]/+${REDACTED_SENTINEL}`),
      "safe",
    );
    expect(result).toMatchObject({
      ok: true,
      ast: { raw: `---\nname: x\n${REDACTED_SENTINEL}: safe\n---` },
    });
  });

  it.each([
    ["section", "## Existing\n", "oc://X.md/+", "New Section", "## Existing\n\n## New Section"],
  ])("preserves output and input AST when inserting a %s", (_kind, raw, path, value, expected) => {
    const md = parseMd(raw).ast;
    const before = structuredClone(md);
    const result = setOcPath(md, parseOcPath(path), value);
    if (!result.ok || result.ast.kind !== "md") {
      throw new Error("expected a successful Markdown insertion");
    }
    expect(result.ast.raw).toBe(expected);
    expect(md).toEqual(before);
  });

  it("rejects duplicate frontmatter key on insertion", () => {
    const md = parseMd("---\nname: x\n---\n").ast;
    const r = setOcPath(md, parseOcPath("oc://X.md/[frontmatter]/+name"), "y");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("type-mismatch");
    }
  });
});

describe("setOcPath — jsonc insertion", () => {
  it("appends to array with `+`", () => {
    const ast = parseJsonc('{ "items": [1, 2] }').ast;
    const r = setOcPath(ast, parseOcPath("oc://config/items/+"), "3");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(JSON.parse(r.ast.raw)).toEqual({ items: [1, 2, 3] });
    }
  });

  it("inserts at index with `+nnn`", () => {
    const ast = parseJsonc('{ "items": [1, 3] }').ast;
    const r = setOcPath(ast, parseOcPath("oc://config/items/+1"), "2");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(JSON.parse(r.ast.raw)).toEqual({ items: [1, 2, 3] });
    }
  });

  it("rejects duplicate object key", () => {
    const ast = parseJsonc('{ "plugins": { "github": "x" } }').ast;
    const r = setOcPath(ast, parseOcPath("oc://config/plugins/+github"), '"y"');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("unresolved");
    }
  });

  it("rejects +key on array", () => {
    const ast = parseJsonc('{ "items": [1, 2] }').ast;
    const r = setOcPath(ast, parseOcPath("oc://config/items/+abc"), "3");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("type-mismatch");
    }
  });

  it("inserts complex object via JSON value", () => {
    const ast = parseJsonc('{ "plugins": {} }').ast;
    const r = setOcPath(
      ast,
      parseOcPath("oc://config/plugins/+gitlab"),
      '{"token":"xyz","enabled":true}',
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(JSON.parse(r.ast.raw)).toEqual({
        plugins: { gitlab: { token: "xyz", enabled: true } },
      });
    }
  });
});

describe("setOcPath — jsonl insertion (session append)", () => {
  it("appends a JSON line with `+`", () => {
    const ast = parseJsonl('{"event":"start"}\n').ast;
    const r = setOcPath(ast, parseOcPath("oc://log/+"), '{"event":"step","n":1}');
    expect(r.ok).toBe(true);
    if (r.ok) {
      const out = r.ast.raw;
      const lines = out.split("\n").filter((l) => l.length > 0);
      expect(lines).toHaveLength(2);
      expect(JSON.parse(expectDefined(lines[1], "appended JSONL line"))).toEqual({
        event: "step",
        n: 1,
      });
    }
  });

  it("rejects malformed JSON value", () => {
    const ast = parseJsonl("").ast;
    const r = setOcPath(ast, parseOcPath("oc://log/+"), "not json");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("parse-error");
    }
  });

  it("rejects non-root insertion target", () => {
    const ast = parseJsonl('{"a":1}\n').ast;
    const r = setOcPath(ast, parseOcPath("oc://log/L1/+"), "{}");
    expect(r.ok).toBe(false);
  });
});

describe("setOcPath — cross-cutting properties", () => {
  it("is non-mutating across all kinds", () => {
    const md = parseMd("---\nname: x\n---\n").ast;
    const before = JSON.stringify(md);
    setOcPath(md, parseOcPath("oc://X.md/[frontmatter]/name"), "new");
    expect(JSON.stringify(md)).toBe(before);

    const jsonc = parseJsonc('{ "k": 1 }').ast;
    const before2 = JSON.stringify(jsonc);
    setOcPath(jsonc, parseOcPath("oc://config/k"), "99");
    expect(JSON.stringify(jsonc)).toBe(before2);

    const jsonl = parseJsonl('{"a":1}\n').ast;
    const before3 = JSON.stringify(jsonl);
    setOcPath(jsonl, parseOcPath("oc://log/L1/a"), "99");
    expect(JSON.stringify(jsonl)).toBe(before3);
  });

  it("returns failure-tagged result with reason on unresolved", () => {
    const ast = parseJsonc("{}").ast;
    const r = setOcPath(ast, parseOcPath("oc://config/missing"), "v");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("unresolved");
    }
  });
});
