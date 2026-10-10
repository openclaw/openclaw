import { describe, expect, it } from "vitest";
import { findOcPaths } from "../find.js";
import { parseJsonc } from "../jsonc/parse.js";
import { parseJsonl } from "../jsonl/parse.js";
import { formatOcPath, OcPathError, parseOcPath } from "../oc-path.js";
import { parseMd } from "../parse.js";
import { resolveOcPath, setOcPath } from "../universal.js";

function leafValues(results: ReturnType<typeof findOcPaths>): string[] {
  return results.map(({ match }) => {
    if (match.kind !== "leaf") {
      throw new Error("Expected a leaf match");
    }
    return match.valueText;
  });
}

describe("single-match wildcard guards", () => {
  const ast = parseJsonc('{"steps":[{"id":"a","command":"foo"}]}').ast;

  it("rejects recursive patterns in resolve with an actionable error", () => {
    expect(() => resolveOcPath(ast, parseOcPath("oc://wf/**"))).toThrow(OcPathError);
    expect(() => resolveOcPath(ast, parseOcPath("oc://wf/**"))).toThrow(
      expect.objectContaining({
        name: "OcPathError",
        code: "OC_PATH_WILDCARD_IN_RESOLVE",
        message: expect.stringContaining("findOcPaths"),
      }),
    );
  });

  it("rejects wildcard writes with an actionable reason", () => {
    expect(setOcPath(ast, parseOcPath("oc://wf/steps/*/command"), "bar")).toEqual({
      ok: false,
      reason: "wildcard-not-allowed",
      detail: expect.stringContaining("findOcPaths"),
    });
  });
});

describe("findOcPaths — JSONC", () => {
  it("returns no matches for an unresolved concrete path", () => {
    expect(findOcPaths(parseJsonc('{"name":"x"}').ast, parseOcPath("oc://wf/missing"))).toEqual([]);
  });

  it.each([
    ['{"items":{"zeta.key":10,"alpha":20}}', "$first", '"zeta.key"', "10"],
    ['{"items":[10,20,30]}', "$last", "2", "30"],
  ])("concretizes positional paths in %s", (raw, position, key, value) => {
    const ast = parseJsonc(raw).ast;
    const pattern = parseOcPath("oc://config/items/" + position);
    const out = findOcPaths(ast, pattern);
    expect(out.map(({ path }) => formatOcPath(path))).toEqual(["oc://config/items/" + key]);
    expect(leafValues(out)).toEqual([value]);
    expect(resolveOcPath(ast, pattern)).toMatchObject({ kind: "leaf", valueText: value });
  });

  const deep = parseJsonc(
    JSON.stringify({
      mcp: {
        servers: {
          github: { env: { GITHUB_TOKEN: "gh-token" } },
          gitlab: { env: { GITHUB_TOKEN: "gl-token" } },
        },
      },
      agents: [
        { id: "coder", tools: { exec: { security: "deny" } } },
        { id: "reviewer", tools: { exec: { security: "allowlist" } } },
      ],
    }),
  ).ast;

  it("expands slash-deep array wildcards into resolvable concrete paths", () => {
    const out = findOcPaths(deep, parseOcPath("oc://openclaw.json/agents/*/tools/exec/security"));
    expect(leafValues(out)).toEqual(["deny", "allowlist"]);
    for (const { path, match } of out) {
      expect(formatOcPath(path)).not.toContain("*");
      expect(resolveOcPath(deep, path)).toEqual(match);
    }
  });

  it("filters slash-deep arrays by a sibling field", () => {
    const out = findOcPaths(
      deep,
      parseOcPath("oc://openclaw.json/agents/[id=reviewer]/tools/exec/security"),
    );
    expect(leafValues(out)).toEqual(["allowlist"]);
  });

  it("finds leaves recursively in slash-deep objects", () => {
    const out = findOcPaths(deep, parseOcPath("oc://openclaw.json/mcp/**/GITHUB_TOKEN"));
    expect(leafValues(out)).toEqual(["gh-token", "gl-token"]);
  });

  it("expands a trailing recursive wildcard into each node exactly once", () => {
    const ast = parseJsonc('{"alpha":{"inner":1},"beta":2}').ast;
    const out = findOcPaths(ast, parseOcPath("oc://f.json/**"));
    expect(out.map(({ path }) => formatOcPath(path))).toEqual([
      "oc://f.json",
      "oc://f.json/alpha",
      "oc://f.json/alpha.inner",
      "oc://f.json/beta",
    ]);
    for (const { path, match } of out) {
      expect(resolveOcPath(ast, path)).toEqual(match);
    }
  });

  it("matches zero sub-segments for a mid-path recursive wildcard", () => {
    const ast = parseJsonc('{"mcp":{"GITHUB_TOKEN":"t","nest":{"GITHUB_TOKEN":"u"}}}').ast;
    const out = findOcPaths(ast, parseOcPath("oc://f.json/mcp/**/GITHUB_TOKEN"));
    expect(out.map(({ path }) => formatOcPath(path))).toEqual([
      "oc://f.json/mcp/GITHUB_TOKEN",
      "oc://f.json/mcp/nest/GITHUB_TOKEN",
    ]);
    expect(leafValues(out)).toEqual(["t", "u"]);
    for (const { path, match } of out) {
      expect(resolveOcPath(ast, path)).toEqual(match);
    }
  });

  it("filters object members by boolean values and preserves leaf types", () => {
    const ast = parseJsonc(
      '{"plugins":{"github":{"enabled":true},"slack":{"enabled":false},"jira":{"enabled":true}}}',
    ).ast;
    const out = findOcPaths(ast, parseOcPath("oc://config/plugins/[enabled=true]/enabled"));
    expect(out.map(({ path }) => path.item)).toEqual(["github", "jira"]);
    expect(out.map(({ match }) => match)).toEqual([
      { kind: "leaf", leafType: "boolean", valueText: "true", line: 1 },
      { kind: "leaf", leafType: "boolean", valueText: "true", line: 1 },
    ]);
  });

  const quoted = parseJsonc(
    '{\n  "models":{"vendor/model":{"alias":"one","contextWindow":1000000},"vendor/model.v2":{"alias":"two"},"plain":{"alias":"three"}}\n}\n',
  ).ast;

  it("quotes structural characters in wildcard results that round-trip", () => {
    const out = findOcPaths(quoted, parseOcPath("oc://config/models/*/alias"));
    expect(out.map(({ path }) => path.item)).toEqual([
      '"vendor/model"',
      '"vendor/model.v2"',
      "plain",
    ]);
    expect(leafValues(out)).toEqual(["one", "two", "three"]);
    for (const { path, match } of out) {
      expect(resolveOcPath(quoted, path)).toEqual(match);
    }
  });

  it("preserves quoted literal keys while expanding a field union", () => {
    const out = findOcPaths(
      quoted,
      parseOcPath('oc://config/models/"vendor/model"/{alias,contextWindow}'),
    );
    expect(out.map(({ path }) => path.field)).toEqual(["alias", "contextWindow"]);
    expect(leafValues(out)).toEqual(["one", "1000000"]);
  });
});

describe("findOcPaths — JSONL", () => {
  const ast = parseJsonl(
    '{"event":"start","userId":"u1"}\n{"event":"action","userId":"u1"}\n{"event":"end","userId":"u1"}\n',
  ).ast;

  it("enumerates value lines with concrete line addresses", () => {
    const out = findOcPaths(ast, parseOcPath("oc://session/*/event"));
    expect(leafValues(out)).toEqual(["start", "action", "end"]);
    expect(out.map(({ path }) => path.section)).toEqual(["L1", "L2", "L3"]);
  });

  it("expands a union of literal and positional line addresses", () => {
    const out = findOcPaths(ast, parseOcPath("oc://session/{L2,$first,$last}/event"));
    expect(leafValues(out)).toEqual(["action", "start", "end"]);
    expect(out.map(({ path }) => path.section)).toEqual(["L2", "L1", "L3"]);
  });

  it("filters value lines by a top-level field", () => {
    const out = findOcPaths(ast, parseOcPath("oc://session/[event=action]/userId"));
    expect(leafValues(out)).toEqual(["u1"]);
  });
});

describe("quoted segment validation", () => {
  it.each([
    ['oc://X/keys/"a\\\\b"', /Quoted segment cannot contain/],
    ['oc://X/"unterminated', /Unbalanced/],
    ['oc://X/"\x00"', /Control character/],
  ])("rejects %s", (uri, error) => {
    expect(() => parseOcPath(uri)).toThrow(error);
  });
});

describe("numeric predicates", () => {
  const ast = parseJsonc(
    '{"models":[{"id":"medium","contextWindow":1000000,"maxTokens":128000},{"id":"large","contextWindow":1000000,"maxTokens":240000},{"id":"small","contextWindow":200000,"maxTokens":64000},{"id":"unknown","contextWindow":"unknown","maxTokens":"unknown"}]}',
  ).ast;

  it.each([
    ["maxTokens>128000", ["large"]],
    ["maxTokens>=128000", ["medium", "large"]],
    ["contextWindow<500000", ["small"]],
    ["contextWindow<=200000", ["small"]],
    ["maxTokens>foo", []],
  ])("filters numeric leaves with %s", (predicate, expected) => {
    expect(
      leafValues(findOcPaths(ast, parseOcPath("oc://config/models/[" + predicate + "]/id"))),
    ).toEqual(expected);
  });
});

describe("findOcPaths — Markdown", () => {
  const md = parseMd("## Tools\n\n- foo: a\n- foo: b\n- bar: c\n").ast;

  it("uses ordinals to distinguish duplicate slugs", () => {
    const out = findOcPaths(md, parseOcPath("oc://AGENTS.md/tools/*/foo"));
    expect(out.map(({ path }) => path.item)).toEqual(["#0", "#1"]);
    expect(leafValues(out)).toEqual(["a", "b"]);
  });

  it("rejects out-of-range ordinals", () => {
    expect(resolveOcPath(md, parseOcPath("oc://AGENTS.md/tools/#99/foo"))).toBeNull();
  });

  it("wraps a concrete item match without expansion", () => {
    const out = findOcPaths(md, parseOcPath("oc://AGENTS.md/tools/bar"));
    expect(out.map(({ path }) => formatOcPath(path))).toEqual(["oc://AGENTS.md/tools/bar"]);
    expect(out.map(({ match }) => match)).toEqual([
      { kind: "node", descriptor: "md-item", line: 5 },
    ]);
  });

  it("enumerates frontmatter keys", () => {
    const ast = parseMd("---\nname: drafter\nrole: writer\n---\n").ast;
    const out = findOcPaths(ast, parseOcPath("oc://SOUL.md/[frontmatter]/*"));
    expect(out.map(({ path }) => path.item)).toEqual(["name", "role"]);
    expect(leafValues(out)).toEqual(["drafter", "writer"]);
  });

  const union = parseMd(
    "## Boundaries\n\n- enabled: true\n- timeout: 5\n\n## Limits\n\n- max-tokens: 4096\n- alias: example\n",
  ).ast;

  it("expands section unions", () => {
    const out = findOcPaths(union, parseOcPath("oc://X.md/{boundaries,limits}/*/*"));
    expect(out.map(({ path }) => path.section)).toEqual([
      "boundaries",
      "boundaries",
      "limits",
      "limits",
    ]);
    expect(leafValues(out)).toEqual(["true", "5", "4096", "example"]);
  });

  it("expands field unions and excludes absent alternatives", () => {
    const out = findOcPaths(union, parseOcPath("oc://X.md/limits/alias/{alias,nope}"));
    expect(out.map(({ path }) => path.field)).toEqual(["alias"]);
    expect(leafValues(out)).toEqual(["example"]);
  });

  const predicates = parseMd(
    "## Boundaries\n\n- enabled: true\n- timeout: 5\n\n## Limits\n\n- enabled: false\n- max-tokens: 4096\n",
  ).ast;

  it.each([
    ["[enabled=true]/*/*", ["boundaries", "boundaries"], ["true", "5"]],
    ["limits/[enabled=false]/*", ["limits"], ["false"]],
    ["limits/max-tokens/[max-tokens=4096]", ["limits"], ["4096"]],
  ])("filters Markdown at %s", (suffix, sections, values) => {
    const out = findOcPaths(predicates, parseOcPath("oc://X.md/" + suffix));
    expect(out.map(({ path }) => path.section)).toEqual(sections);
    expect(leafValues(out)).toEqual(values);
  });
});
