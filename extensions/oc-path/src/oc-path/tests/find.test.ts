import { describe, expect, it } from "vitest";
import { findOcPaths } from "../find.js";
import { parseJsonc } from "../jsonc/parse.js";
import { parseJsonl } from "../jsonl/parse.js";
import { formatOcPath, OcPathError, parseOcPath } from "../oc-path.js";
import { parseMd } from "../parse.js";
import { resolveOcPath, setOcPath } from "../universal.js";
import { parseYaml } from "../yaml/parse.js";

function leafValues(results: ReturnType<typeof findOcPaths>): string[] {
  return results.map(({ match }) => {
    if (match.kind !== "leaf") {
      throw new Error("Expected a leaf match");
    }
    return match.valueText;
  });
}

describe("empty string keys", () => {
  it.each([
    { file: "f.json", parse: parseJsonc, raw: '{"":"old","keep":"unchanged"}', suffix: '""' },
    { file: "f.yaml", parse: parseYaml, raw: '"": old\nkeep: unchanged\n', suffix: '""' },
    { file: "f.jsonl/L1", parse: parseJsonl, raw: '{"":"old","keep":"unchanged"}\n', suffix: '""' },
    {
      file: "f.json",
      parse: parseJsonc,
      raw: '{"":{"value":"old"},"keep":"unchanged"}',
      suffix: '""/value',
    },
    {
      file: "f.yaml",
      parse: parseYaml,
      raw: '"":\n  value: old\nkeep: unchanged\n',
      suffix: '""/value',
    },
    {
      file: "f.jsonl/L1",
      parse: parseJsonl,
      raw: '{"":{"value":"old"},"keep":"unchanged"}\n',
      suffix: '""/value',
    },
  ])("finds, resolves, and edits $suffix in $file", ({ file, parse, raw, suffix }) => {
    const ast = parse(raw);
    const prefix = "oc://" + file;
    const results = findOcPaths(ast, parseOcPath(prefix + "/*"));
    expect(results.map(({ path }) => formatOcPath(path))).toEqual([
      prefix + '/""',
      prefix + "/keep",
    ]);
    for (const { path, match } of results) {
      expect(resolveOcPath(ast, parseOcPath(formatOcPath(path)))).toEqual(match);
    }
    const target = parseOcPath(prefix + "/" + suffix);
    expect(resolveOcPath(ast, target)).toMatchObject({ kind: "leaf", valueText: "old" });
    const edited = setOcPath(ast, target, "new");
    expect(edited.raw).toBe(raw.replace("old", "new"));
    expect(resolveOcPath(edited, target)).toMatchObject({ kind: "leaf", valueText: "new" });
    expect(resolveOcPath(edited, parseOcPath(prefix + "/keep"))).toMatchObject({
      kind: "leaf",
      valueText: "unchanged",
    });
    expect(ast.raw).toBe(raw);
  });

  it.each([
    { file: "f.json", parse: parseJsonc },
    { file: "f.yaml", parse: parseYaml },
    { file: "f.jsonl/L1", parse: parseJsonl },
  ])("does not treat an empty key as array index zero in $file", ({ file, parse }) => {
    const ast = parse('["unchanged"]\n');
    const target = parseOcPath("oc://" + file + '/""');
    expect(resolveOcPath(ast, target)).toBeNull();
    expect(() => setOcPath(ast, target, "new")).toThrow(
      expect.objectContaining({ reason: "unresolved" }),
    );
  });
});

describe("single-match wildcard guards", () => {
  const ast = parseJsonc('{"steps":[{"id":"a","command":"foo"}]}');

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
    expect(() => setOcPath(ast, parseOcPath("oc://wf/steps/*/command"), "bar")).toThrow(
      expect.objectContaining({
        reason: "wildcard-not-allowed",
        detail: expect.stringContaining("findOcPaths"),
      }),
    );
  });
});

describe("findOcPaths — JSONC", () => {
  it("returns no matches for an unresolved concrete path", () => {
    expect(findOcPaths(parseJsonc('{"name":"x"}'), parseOcPath("oc://wf/missing"))).toEqual([]);
  });

  it.each([
    ['{"items":{"zeta.key":10,"alpha":20}}', "$first", '"zeta.key"', "10"],
    ['{"items":[10,20,30]}', "$last", "2", "30"],
  ])("concretizes positional paths in %s", (raw, position, key, value) => {
    const ast = parseJsonc(raw);
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
  );

  it("finds leaves recursively in slash-deep objects", () => {
    const out = findOcPaths(deep, parseOcPath("oc://openclaw.json/mcp/**/GITHUB_TOKEN"));
    expect(leafValues(out)).toEqual(["gh-token", "gl-token"]);
  });

  it("expands a trailing recursive wildcard into each node exactly once", () => {
    const ast = parseJsonc('{"alpha":{"inner":1},"beta":2}');
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
    const ast = parseJsonc('{"mcp":{"GITHUB_TOKEN":"t","nest":{"GITHUB_TOKEN":"u"}}}');
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
    );
    const out = findOcPaths(ast, parseOcPath("oc://config/plugins/[enabled=true]/enabled"));
    expect(out.map(({ path }) => path.item)).toEqual(["github", "jira"]);
    expect(out.map(({ match }) => match)).toEqual([
      { kind: "leaf", leafType: "boolean", valueText: "true", line: 1 },
      { kind: "leaf", leafType: "boolean", valueText: "true", line: 1 },
    ]);
  });

  const quoted = parseJsonc(
    '{\n  "models":{"vendor/model":{"alias":"one","contextWindow":1000000},"vendor/model.v2":{"alias":"two"},"plain":{"alias":"three"}}\n}\n',
  );

  it("preserves quoted literal keys while expanding a field union", () => {
    const out = findOcPaths(
      quoted,
      parseOcPath('oc://config/models/"vendor/model"/{alias,contextWindow}'),
    );
    expect(out.map(({ path }) => path.field)).toEqual(["alias", "contextWindow"]);
    expect(leafValues(out)).toEqual(["one", "1000000"]);
  });
});

describe("quoted union targets", () => {
  it.each([
    { file: "f.json", parse: parseJsonc, raw: '{"a.b":1}' },
    { file: "f.yaml", parse: parseYaml, raw: "a.b: 1\n" },
  ])("resolves either ordering of literal key aliases in $file", ({ file, parse, raw }) => {
    const ast = parse(raw);
    const prefix = "oc://" + file;
    for (const union of ['{a.b,"a.b"}', '{"a.b",a.b}']) {
      const out = findOcPaths(ast, parseOcPath(prefix + "/" + union));
      expect(out.map(({ path }) => formatOcPath(path))).toEqual([prefix + '/"a.b"']);
      expect(leafValues(out)).toEqual(["1"]);
      for (const { path, match } of out) {
        expect(resolveOcPath(ast, parseOcPath(formatOcPath(path)))).toEqual(match);
      }
    }
  });
  it.each([
    { file: "f.json", parse: parseJsonc, raw: '{"*":1,"**":2,"a":3}' },
    { file: "f.yaml", parse: parseYaml, raw: '"*": 1\n"**": 2\na: 3\n' },
  ])("preserves explicit quotes in literal unions in $file", ({ file, parse, raw }) => {
    const ast = parse(raw);
    const prefix = "oc://" + file;
    const out = findOcPaths(ast, parseOcPath(prefix + '/{"*","**","a"}'));
    expect(out.map(({ path }) => formatOcPath(path))).toEqual([
      prefix + '/"*"',
      prefix + '/"**"',
      prefix + '/"a"',
    ]);
    expect(leafValues(out)).toEqual(["1", "2", "3"]);
    for (const { path, match } of out) {
      expect(resolveOcPath(ast, parseOcPath(formatOcPath(path)))).toEqual(match);
    }
  });
});

describe("recursive wildcard targets", () => {
  it.each([
    { file: "f.json", parse: parseJsonc, raw: '{"a":{"b":1},"a.b":2}' },
    { file: "f.yaml", parse: parseYaml, raw: "a:\n  b: 1\na.b: 2\n" },
  ])("returns each target once across recursive slots in $file", ({ file, parse, raw }) => {
    const ast = parse(raw);
    const prefix = "oc://" + file;
    const out = findOcPaths(ast, parseOcPath(prefix + "/**/**/**"));
    expect(out.map(({ path }) => formatOcPath(path))).toEqual([
      prefix,
      prefix + "/a",
      prefix + "/a.b",
      prefix + '/"a.b"',
    ]);
    expect(leafValues(out.filter(({ match }) => match.kind === "leaf"))).toEqual(["1", "2"]);
    for (const { path, match } of out) {
      expect(resolveOcPath(ast, parseOcPath(formatOcPath(path)))).toEqual(match);
    }
  });

  describe.each([
    { file: "f.json", parse: parseJsonc },
    { file: "f.yaml", parse: parseYaml },
  ])("deep recursive targets in $file", ({ file, parse }) => {
    it.each([64, 65, 129, 192])("round-trips every result at depth %i", (depth) => {
      const keys = Array.from({ length: depth }, (_, index) => (index === 63 ? "a.b" : "k"));
      const value = keys.reduceRight<unknown>((child, key) => ({ [key]: child }), 1);
      const ast = parse(JSON.stringify(value));
      const out = findOcPaths(ast, parseOcPath("oc://" + file + "/**/**/**?session=deep"));
      expect(out).toHaveLength(depth + 1);
      expect(new Set(out.map(({ path }) => formatOcPath(path))).size).toBe(out.length);
      expect(leafValues(out.filter(({ match }) => match.kind === "leaf"))).toEqual(["1"]);
      for (const { path, match } of out) {
        expect(path.session).toBe("deep");
        expect(resolveOcPath(ast, parseOcPath(formatOcPath(path)))).toEqual(match);
      }
    });

    it("preserves an already valid three-slot partition", () => {
      const middle = Array(64).fill("k").join(".");
      let value: unknown = { end: 1 };
      for (let level = 0; level < 64; level++) {
        value = { k: value };
      }
      const ast = parse(JSON.stringify({ start: value }));
      const out = findOcPaths(ast, parseOcPath("oc://" + file + "/start/**/end"));
      expect(out.map(({ path }) => formatOcPath(path))).toEqual([
        "oc://" + file + "/start/" + middle + "/end",
      ]);
      expect(leafValues(out)).toEqual(["1"]);
      for (const { path, match } of out) {
        expect(resolveOcPath(ast, parseOcPath(formatOcPath(path)))).toEqual(match);
      }
    });
  });

  it("bounds AST expansion for repeated recursive wildcards", () => {
    const depth = 10;
    let value: unknown = 1;
    for (let level = depth - 1; level >= 0; level--) {
      value = { ["k" + level]: value };
    }
    const ast = parseJsonc(JSON.stringify(value));
    const pattern = parseOcPath("oc://f.json/" + Array(depth).fill("**").join("."));
    const maxEntryReads = 100 * (depth + 1) * depth;
    let entryReads = 0;
    for (let node = ast.root; node?.kind === "object";) {
      const entries = node.entries;
      Object.defineProperty(node, "entries", {
        get() {
          if (++entryReads > maxEntryReads) {
            throw new Error("Recursive wildcard exceeded the AST expansion budget");
          }
          return entries;
        },
      });
      node = entries[0]?.value ?? null;
    }

    const out = findOcPaths(ast, pattern);
    expect(out).toHaveLength(depth + 1);
    expect(leafValues(out.filter(({ match }) => match.kind === "leaf"))).toEqual(["1"]);
  });
});

describe("findOcPaths — JSONL", () => {
  const ast = parseJsonl(
    '{"event":"start","userId":"u1"}\n{"event":"action","userId":"u1"}\n{"event":"end","userId":"u1"}\n',
  );

  it.each([64, 65, 128])("round-trips JSONL value paths at depth %i", (depth) => {
    const keys = Array.from({ length: depth }, (_, index) => (index === 63 ? "a.b" : "k"));
    const value = keys.reduceRight<unknown>((child, key) => ({ [key]: child }), 1);
    const lineAst = parseJsonl(JSON.stringify(value) + "\n");
    const out = findOcPaths(lineAst, parseOcPath("oc://events.jsonl/L1/**/**?session=deep"));
    expect(out).toHaveLength(depth + 1);
    expect(leafValues(out.filter(({ match }) => match.kind === "leaf"))).toEqual(["1"]);
    for (const { path, match } of out) {
      expect(path.section).toBe("L1");
      expect(path.session).toBe("deep");
      expect(resolveOcPath(lineAst, parseOcPath(formatOcPath(path)))).toEqual(match);
    }
  });

  it("preserves an already valid JSONL value partition", () => {
    let value: unknown = { end: 1 };
    for (let level = 0; level < 63; level++) {
      value = { k: value };
    }
    const lineAst = parseJsonl(JSON.stringify({ start: value }) + "\n");
    const out = findOcPaths(lineAst, parseOcPath("oc://events.jsonl/L1/start/**.end"));
    expect(out.map(({ path }) => formatOcPath(path))).toEqual([
      "oc://events.jsonl/L1/start/" + Array(63).fill("k").join(".") + ".end",
    ]);
    expect(leafValues(out)).toEqual(["1"]);
    for (const { path, match } of out) {
      expect(resolveOcPath(lineAst, parseOcPath(formatOcPath(path)))).toEqual(match);
    }
  });

  it.each([
    { pattern: "*/**/**", prefix: ["oc://session/L1"], nextLine: ["oc://session/L3"] },
    {
      pattern: "**/**/**",
      prefix: ["oc://session", "oc://session/L1", "oc://session/L3"],
      nextLine: [],
    },
    {
      pattern: "{L1,$first,$last}/**/**",
      prefix: ["oc://session/L1"],
      nextLine: ["oc://session/L3"],
    },
  ])("retains distinct physical-line targets for $pattern", ({ pattern, prefix, nextLine }) => {
    const lineAst = parseJsonl('{"a":{"b":1},"a.b":2}\n\n{"a":{"b":1},"a.b":2}\n');
    const out = findOcPaths(lineAst, parseOcPath("oc://session/" + pattern));
    expect(out.map(({ path }) => formatOcPath(path))).toEqual([
      ...prefix,
      "oc://session/L1/a",
      "oc://session/L1/a.b",
      'oc://session/L1/"a.b"',
      ...nextLine,
      "oc://session/L3/a",
      "oc://session/L3/a.b",
      'oc://session/L3/"a.b"',
    ]);
    expect(leafValues(out.filter(({ match }) => match.kind === "leaf"))).toEqual([
      "1",
      "2",
      "1",
      "2",
    ]);
    for (const { path, match } of out) {
      expect(resolveOcPath(lineAst, parseOcPath(formatOcPath(path)))).toEqual(match);
    }
  });

  it("deduplicates quoted aliases within a line", () => {
    const lineAst = parseJsonl('{"a":{"b":1}}\n');
    for (const { union, paths } of [
      { union: '{a,"a"}', paths: ["oc://session/L1/a", "oc://session/L1/a/b"] },
      { union: '{"a",a}', paths: ['oc://session/L1/"a"', 'oc://session/L1/"a"/b'] },
    ]) {
      for (const suffix of ["", "/**"]) {
        const out = findOcPaths(lineAst, parseOcPath("oc://session/L1/" + union + suffix));
        expect(out.map(({ path }) => formatOcPath(path))).toEqual(
          suffix ? paths : paths.slice(0, 1),
        );
        if (suffix) {
          expect(leafValues(out.filter(({ match }) => match.kind === "leaf"))).toEqual(["1"]);
        }
        for (const { path, match } of out) {
          expect(resolveOcPath(lineAst, parseOcPath(formatOcPath(path)))).toEqual(match);
        }
      }
    }
  });

  it("keeps valid line addresses after recursive zero-width routes", () => {
    const lineAst = parseJsonl('{"nest":{"event":"x"}}\n');
    const out = findOcPaths(lineAst, parseOcPath("oc://session/**/**/event"));
    expect(out.map(({ path }) => formatOcPath(path))).toEqual(["oc://session/L1/nest/event"]);
    expect(leafValues(out)).toEqual(["x"]);
    for (const { path, match } of out) {
      expect(resolveOcPath(lineAst, parseOcPath(formatOcPath(path)))).toEqual(match);
    }
  });

  it("bounds JSONL expansion across recursive slot partitions", () => {
    const depth = 32;
    const wildcardsPerSlot = 8;
    let value: unknown = 1;
    for (let level = depth - 1; level >= 0; level--) {
      value = { ["k" + level]: value };
    }
    const lineAst = parseJsonl(JSON.stringify(value) + "\n");
    const line = lineAst.lines[0];
    if (line?.kind !== "value") {
      throw new Error("Expected a parsed JSONL value line");
    }
    const maxEntryReads = 3 * (depth + 1) ** 2 * wildcardsPerSlot;
    let entryReads = 0;
    for (let node = line.value; node.kind === "object";) {
      const entries = node.entries;
      Object.defineProperty(node, "entries", {
        get() {
          if (++entryReads > maxEntryReads) {
            throw new Error("JSONL recursive wildcard exceeded the AST expansion budget");
          }
          return entries;
        },
      });
      const child = entries[0]?.value;
      if (!child) {
        break;
      }
      node = child;
    }
    const slot = Array(wildcardsPerSlot).fill("**").join(".");
    const out = findOcPaths(lineAst, parseOcPath("oc://session/" + [slot, slot, slot].join("/")));
    expect(out).toHaveLength(depth + 2);
    expect(leafValues(out.filter(({ match }) => match.kind === "leaf"))).toEqual(["1"]);
    for (const { path, match } of out) {
      expect(resolveOcPath(lineAst, parseOcPath(formatOcPath(path)))).toEqual(match);
    }
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
    [String.raw`oc://X/keys/"a\q"`, /Quoted segment must escape/],
    ['oc://X/"unterminated', /Unbalanced/],
  ])("rejects %s", (uri, error) => {
    expect(() => parseOcPath(uri)).toThrow(error);
  });
});

describe("numeric predicates", () => {
  const ast = parseJsonc(
    '{"models":[{"id":"medium","contextWindow":1000000,"maxTokens":128000},{"id":"large","contextWindow":1000000,"maxTokens":240000},{"id":"small","contextWindow":200000,"maxTokens":64000},{"id":"unknown","contextWindow":"unknown","maxTokens":"unknown"}]}',
  );

  it.each([
    ["maxTokens>128000", ["large"]],
    ["maxTokens>=128000", ["medium", "large"]],
    ["contextWindow<500000", ["small"]],
    ["contextWindow<=200000", ["small"]],
  ])("filters numeric leaves with %s", (predicate, expected) => {
    expect(
      leafValues(findOcPaths(ast, parseOcPath("oc://config/models/[" + predicate + "]/id"))),
    ).toEqual(expected);
  });
});

describe("findOcPaths — Markdown", () => {
  const md = parseMd("## Tools\n\n- foo: a\n- foo: b\n- bar: c\n");

  it("quotes empty Markdown slugs in reusable expanded paths", () => {
    const raw = "## 日本語\n- !!!: old\n- plain: keep\n";
    const ast = parseMd(raw);
    const address = 'oc://notes.md/""/""/!!!';
    for (const pattern of [
      'oc://notes.md/""/""/*',
      'oc://notes.md/""/*/!!!',
      'oc://notes.md/*/""/!!!',
      "oc://notes.md/*/*/!!!",
    ]) {
      const out = findOcPaths(ast, parseOcPath(pattern));
      expect(out.map(({ path }) => formatOcPath(path))).toEqual([address]);
      expect(leafValues(out)).toEqual(["old"]);
      for (const { path, match } of out) {
        const concrete = parseOcPath(formatOcPath(path));
        expect(resolveOcPath(ast, concrete)).toEqual(match);
        expect(setOcPath(ast, concrete, "changed").raw).toBe(
          raw.replace("!!!: old", "!!!: changed"),
        );
      }
      expect(ast.raw).toBe(raw);
    }
  });

  it("keeps quoted Markdown field paths usable after expansion and formatting", () => {
    for (const key of ["model name", "model.id", "a/b", 'say "hi"', "a\\b", "*", "$last", "+"]) {
      const raw = `## Settings\n- ${key}: old\n- plain: keep\n`;
      const ast = parseMd(raw);
      const address = `oc://notes.md/settings/#0/${JSON.stringify(key)}`;
      for (const field of ["*", JSON.stringify(key), `{${JSON.stringify(key)},absent}`]) {
        const out = findOcPaths(ast, parseOcPath(`oc://notes.md/settings/#0/${field}`));
        expect(out.map(({ path }) => formatOcPath(path))).toEqual([address]);
        expect(leafValues(out)).toEqual(["old"]);
      }
      const concrete = parseOcPath(address);
      expect(resolveOcPath(ast, concrete)).toMatchObject({ kind: "leaf", valueText: "old" });
      expect(setOcPath(ast, concrete, "changed").raw).toBe(
        `## Settings\n- ${key}: changed\n- plain: keep\n`,
      );
      expect(ast.raw).toBe(raw);
    }
  });

  it("decodes quoted Markdown containers without treating quoted selectors as syntax", () => {
    const raw = "---\nname: sample\n---\n## Settings\n- first: old\n- plain: keep\n";
    const ast = parseMd(raw);
    for (const address of [
      'oc://notes.md/"settings"/"plain"/plain',
      'oc://notes.md/"settings"/*/plain',
      'oc://notes.md/settings/"plain"/*',
      'oc://notes.md/{settings,"settings"}/plain/plain',
      'oc://notes.md/settings/{plain,"plain"}/plain',
      'oc://notes.md/settings/plain/{plain,"plain"}',
    ]) {
      expect(leafValues(findOcPaths(ast, parseOcPath(address)))).toEqual(["keep"]);
    }
    expect(
      setOcPath(ast, parseOcPath('oc://notes.md/"settings"/"plain"/plain'), "changed").raw,
    ).toBe(raw.replace("plain: keep", "plain: changed"));
    const frontmatter = parseOcPath('oc://notes.md/[frontmatter]/"name"');
    expect(resolveOcPath(ast, frontmatter)).toMatchObject({ kind: "leaf", valueText: "sample" });
    expect(setOcPath(ast, frontmatter, "changed").raw).toBe(
      raw.replace("name: sample", "name: changed"),
    );
    const insertion = parseOcPath('oc://notes.md/"settings"/+');
    expect(resolveOcPath(ast, insertion)).toMatchObject({ kind: "insertion-point" });
    expect(setOcPath(ast, insertion, "extra: added").raw).toBe(raw + "- extra: added\n");
    expect(setOcPath(ast, parseOcPath("oc://notes.md/settings/$last/plain"), "changed").raw).toBe(
      raw.replace("plain: keep", "plain: changed"),
    );
    for (const selector of ["#0", "$first", "$last"]) {
      const address = parseOcPath(`oc://notes.md/settings/"${selector}"`);
      expect(resolveOcPath(ast, address)).toBeNull();
      expect(findOcPaths(ast, address)).toEqual([]);
    }
    expect(resolveOcPath(ast, parseOcPath('oc://notes.md/"[frontmatter]"/name'))).toBeNull();
    expect(ast.raw).toBe(raw);
  });

  it("uses ordinals to distinguish duplicate slugs", () => {
    const out = findOcPaths(md, parseOcPath('oc://AGENTS.md/{tools,"tools"}/*/foo'));
    expect(out.map(({ path }) => path.item)).toEqual(["#0", "#1"]);
    expect(leafValues(out)).toEqual(["a", "b"]);
  });

  it("keeps item nodes when a recursive wildcard consumes the item slot", () => {
    const out = findOcPaths(md, parseOcPath("oc://AGENTS.md/tools/**"));
    expect(out.map(({ path }) => formatOcPath(path))).toEqual([
      "oc://AGENTS.md/tools",
      "oc://AGENTS.md/tools/#0",
      "oc://AGENTS.md/tools/#1",
      "oc://AGENTS.md/tools/bar",
    ]);
    for (const { path, match } of out) {
      expect(resolveOcPath(md, parseOcPath(formatOcPath(path)))).toEqual(match);
    }
  });

  it("bounds Markdown expansion across repeated recursive wildcards", () => {
    const blockCount = 4;
    const itemsPerBlock = 8;
    const wildcardsPerSlot = 32;
    const raw = Array.from({ length: blockCount }, (_, block) => {
      const items = Array.from(
        { length: itemsPerBlock },
        (_item, item) => `- key-${item}: ${block * itemsPerBlock + item}`,
      );
      return `## Block ${block}\n\n${items.join("\n")}\n`;
    }).join("\n");
    const document = parseMd(raw);
    const maxItemReads = 20 * blockCount * wildcardsPerSlot * 3;
    let itemReads = 0;
    for (const block of document.blocks) {
      const items = block.items;
      Object.defineProperty(block, "items", {
        get() {
          if (++itemReads > maxItemReads) {
            throw new Error("Markdown recursive wildcard exceeded the AST expansion budget");
          }
          return items;
        },
      });
    }
    const slot = Array(wildcardsPerSlot).fill("**").join(".");
    const out = findOcPaths(document, parseOcPath("oc://tools.md/" + [slot, slot, slot].join("/")));
    expect(out).toHaveLength(1 + blockCount + 2 * blockCount * itemsPerBlock);
    expect(leafValues(out.filter(({ match }) => match.kind === "leaf"))).toEqual(
      Array.from({ length: blockCount * itemsPerBlock }, (_, index) => String(index)),
    );
    for (const { path, match } of out) {
      expect(resolveOcPath(document, parseOcPath(formatOcPath(path)))).toEqual(match);
    }
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
    const ast = parseMd("---\nname: drafter\nrole: writer\n---\n");
    const out = findOcPaths(ast, parseOcPath("oc://SOUL.md/[frontmatter]/*"));
    expect(out.map(({ path }) => path.item)).toEqual(["name", "role"]);
    expect(leafValues(out)).toEqual(["drafter", "writer"]);
  });

  const union = parseMd(
    "## Boundaries\n\n- enabled: true\n- timeout: 5\n\n## Limits\n\n- max-tokens: 4096\n- alias: example\n",
  );

  it("expands field unions and excludes absent alternatives", () => {
    const out = findOcPaths(union, parseOcPath("oc://X.md/limits/alias/{alias,nope}"));
    expect(out.map(({ path }) => path.field)).toEqual(["alias"]);
    expect(leafValues(out)).toEqual(["example"]);
  });

  const predicates = parseMd(
    "## Boundaries\n\n- enabled: true\n- timeout: 5\n\n## Limits\n\n- enabled: false\n- max-tokens: 4096\n",
  );

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
