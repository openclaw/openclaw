// OC Path tests cover cross kind properties plugin behavior.
import { describe, expect, it } from "vitest";
import { inferKind } from "../../dispatch.js";
import { parseJsonc } from "../../jsonc/parse.js";
import { resolveJsoncOcPath } from "../../jsonc/resolve.js";
import { parseJsonl } from "../../jsonl/parse.js";
import { resolveJsonlOcPath } from "../../jsonl/resolve.js";
import { parseOcPath } from "../../oc-path.js";
import { parseMd } from "../../parse.js";
import { resolveMdOcPath } from "../../resolve.js";

describe("cross-kind property invariants", () => {
  const mdRaw = "---\nname: x\n---\n\n## Boundaries\n\n- enabled: true\n";
  const jsoncRaw = '// h\n{ "k": 1, "n": [1,2,3] }\n';
  const jsonlRaw = '{"a":1}\n\nbroken\n{"b":2}\n';

  it("resolve is non-mutating across all kinds", () => {
    const md = parseMd(mdRaw).ast;
    let before = JSON.stringify(md);
    resolveMdOcPath(md, parseOcPath("oc://X/[frontmatter]/name"));
    resolveMdOcPath(md, parseOcPath("oc://X/boundaries"));
    expect(JSON.stringify(md)).toBe(before);

    const jsonc = parseJsonc(jsoncRaw).ast;
    before = JSON.stringify(jsonc);
    resolveJsoncOcPath(jsonc, parseOcPath("oc://X/k"));
    resolveJsoncOcPath(jsonc, parseOcPath("oc://X/n.0"));
    expect(JSON.stringify(jsonc)).toBe(before);

    const jsonl = parseJsonl(jsonlRaw).ast;
    before = JSON.stringify(jsonl);
    resolveJsonlOcPath(jsonl, parseOcPath("oc://X/L1"));
    resolveJsonlOcPath(jsonl, parseOcPath("oc://X/$last"));
    expect(JSON.stringify(jsonl)).toBe(before);
  });

  it("inferKind aligns with the parser actually used", () => {
    expect(inferKind("AGENTS.md")).toBe("md");
    expect(inferKind("SOUL.md")).toBe("md");
    expect(inferKind("config.jsonc")).toBe("jsonc");
    expect(inferKind("plugins.json")).toBe("jsonc");
    expect(inferKind("events.jsonl")).toBe("jsonl");
    expect(inferKind("audit.ndjson")).toBe("jsonl");
  });

  it("hostile inputs do not throw at parse time across all kinds", () => {
    const hostile = [
      "\x00\x01\x02 binary garbage",
      '{ "unclosed":',
      "## heading without anything",
      "\n\n\n\n\n",
    ];
    for (const raw of hostile) {
      expect(() => parseMd(raw)).not.toThrow();
      expect(() => parseJsonc(raw)).not.toThrow();
      expect(() => parseJsonl(raw)).not.toThrow();
    }
  });

  it("inferKind returns null for unknown extensions", () => {
    expect(inferKind("binary.bin")).toBeNull();
    expect(inferKind("no-ext")).toBeNull();
    expect(inferKind("archive.tar.gz")).toBeNull();
  });
});
