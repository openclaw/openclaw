import { describe, expect, it } from "vitest";
import { findOcPaths } from "../find.js";
import type { JsoncValue } from "../jsonc/ast.js";
import { parseJsonc } from "../jsonc/parse.js";
import { parseJsonl } from "../jsonl/parse.js";
import { formatOcPath, OcPathError, parseOcPath } from "../oc-path.js";
import { parseMd } from "../parse.js";
import { resolveOcPath, setOcPath, type OcAst } from "../universal.js";
import { parseYaml } from "../yaml/parse.js";

function find(ast: OcAst, uri: string) {
  return findOcPaths(ast, parseOcPath(uri));
}

function leafValues(results: ReturnType<typeof findOcPaths>): string[] {
  return results.map(({ match }) => {
    if (match.kind !== "leaf") {
      throw new Error("Expected a leaf match");
    }
    return match.valueText;
  });
}

function formattedPaths(results: ReturnType<typeof findOcPaths>): string[] {
  return results.map(({ path }) => formatOcPath(path));
}

function expectRoundTrips(ast: OcAst, results: ReturnType<typeof findOcPaths>) {
  for (const { path, match } of results) {
    expect(resolveOcPath(ast, parseOcPath(formatOcPath(path)))).toEqual(match);
  }
}

function nestedValue(keys: string[], value: unknown = 1): unknown {
  return keys.reduceRight<unknown>((child, key) => ({ [key]: child }), value);
}

function limitEntryReads(root: JsoncValue | null, budget: number) {
  let reads = 0;
  for (let node = root; node?.kind === "object";) {
    const entries = node.entries;
    Object.defineProperty(node, "entries", {
      get() {
        if (++reads > budget) {
          throw new Error("Recursive wildcard exceeded the AST expansion budget");
        }
        return entries;
      },
    });
    node = entries[0]?.value ?? null;
  }
}

describe("empty string keys", () => {
  it.each([
    ["f.json", parseJsonc, '{"":"old","keep":"unchanged"}', '""'],
    ["f.yaml", parseYaml, '"": old\nkeep: unchanged\n', '""'],
    ["f.jsonl/L1", parseJsonl, '{"":"old","keep":"unchanged"}\n', '""'],
    ["f.json", parseJsonc, '{"":{"value":"old"},"keep":"unchanged"}', '""/value'],
    ["f.yaml", parseYaml, '"":\n  value: old\nkeep: unchanged\n', '""/value'],
    ["f.jsonl/L1", parseJsonl, '{"":{"value":"old"},"keep":"unchanged"}\n', '""/value'],
  ])("finds, resolves, and edits empty keys in %s (case %#)", (file, parse, raw, suffix) => {
    const ast = parse(raw);
    const prefix = "oc://" + file;
    const results = find(ast, prefix + "/*");
    expect(formattedPaths(results)).toEqual([prefix + '/""', prefix + "/keep"]);
    expectRoundTrips(ast, results);
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
    expect(formattedPaths(out)).toEqual(["oc://config/items/" + key]);
    expect(leafValues(out)).toEqual([value]);
    expect(resolveOcPath(ast, pattern)).toMatchObject({ kind: "leaf", valueText: value });
  });

  it("matches zero sub-segments for a mid-path recursive wildcard", () => {
    const ast = parseJsonc('{"mcp":{"GITHUB_TOKEN":"t","nest":{"GITHUB_TOKEN":"u"}}}');
    const out = find(ast, "oc://f.json/mcp/**/GITHUB_TOKEN");
    expect(formattedPaths(out)).toEqual([
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
    const out = find(ast, "oc://config/plugins/[enabled=true]/enabled");
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
    const out = find(quoted, 'oc://config/models/"vendor/model"/{alias,contextWindow}');
    expect(out.map(({ path }) => path.field)).toEqual(["alias", "contextWindow"]);
    expect(leafValues(out)).toEqual(["one", "1000000"]);
  });
});

describe("quoted union targets", () => {
  it.each([
    { key: "a,b", pattern: '{"a,b",plain}' },
    { key: 'a,,"b', pattern: '{"a,,\\"b",plain}' },
    { key: 'a,,"b', pattern: '{{"a,,\\"b",missing},plain}' },
    { key: "{a,,b}", pattern: '{"{a,,b}",plain}' },
  ])("keeps commas inside the quoted union key $key", ({ key, pattern }) => {
    const ast = parseJsonc(JSON.stringify({ [key]: "selected", plain: "sibling" }));
    const out = find(ast, "oc://f.json/" + pattern);
    expect(leafValues(out)).toEqual(["selected", "sibling"]);
    expectRoundTrips(ast, out);
  });

  it.each([
    { file: "f.json", parse: parseJsonc, raw: '{"a.b":1}' },
    { file: "f.yaml", parse: parseYaml, raw: "a.b: 1\n" },
  ])("resolves either ordering of literal key aliases in $file", ({ file, parse, raw }) => {
    const ast = parse(raw);
    const prefix = "oc://" + file;
    for (const union of ['{a.b,"a.b"}', '{"a.b",a.b}']) {
      const out = find(ast, prefix + "/" + union);
      expect(formattedPaths(out)).toEqual([prefix + '/"a.b"']);
      expect(leafValues(out)).toEqual(["1"]);
      expectRoundTrips(ast, out);
    }
  });
  it.each([
    { file: "f.json", parse: parseJsonc, raw: '{"*":1,"**":2,"a":3}' },
    { file: "f.yaml", parse: parseYaml, raw: '"*": 1\n"**": 2\na: 3\n' },
  ])("preserves explicit quotes in literal unions in $file", ({ file, parse, raw }) => {
    const ast = parse(raw);
    const prefix = "oc://" + file;
    const out = find(ast, prefix + '/{"*","**","a"}');
    expect(formattedPaths(out)).toEqual([prefix + '/"*"', prefix + '/"**"', prefix + '/"a"']);
    expect(leafValues(out)).toEqual(["1", "2", "3"]);
    expectRoundTrips(ast, out);
  });
});

describe("recursive wildcard targets", () => {
  it.each([
    { file: "f.json", parse: parseJsonc, raw: '{"a":{"b":1},"a.b":2}' },
    { file: "f.yaml", parse: parseYaml, raw: "a:\n  b: 1\na.b: 2\n" },
  ])("returns each target once across recursive slots in $file", ({ file, parse, raw }) => {
    const ast = parse(raw);
    const prefix = "oc://" + file;
    const out = find(ast, prefix + "/**/**/**");
    expect(formattedPaths(out)).toEqual([
      prefix,
      prefix + "/a",
      prefix + "/a.b",
      prefix + '/"a.b"',
    ]);
    expect(leafValues(out.filter(({ match }) => match.kind === "leaf"))).toEqual(["1", "2"]);
    expectRoundTrips(ast, out);
  });

  it("bounds AST expansion for repeated recursive wildcards", () => {
    const depth = 10;
    const value = nestedValue(Array.from({ length: depth }, (_, i) => "k" + i));
    const ast = parseJsonc(JSON.stringify(value));
    const pattern = parseOcPath("oc://f.json/" + Array(depth).fill("**").join("."));
    limitEntryReads(ast.root, 100 * (depth + 1) * depth);

    const out = findOcPaths(ast, pattern);
    expect(out).toHaveLength(depth + 1);
    expect(leafValues(out.filter(({ match }) => match.kind === "leaf"))).toEqual(["1"]);
  });
});

describe("findOcPaths — JSONL", () => {
  const ast = parseJsonl(
    '{"event":"start","userId":"u1"}\n{"event":"action","userId":"u1"}\n{"event":"end","userId":"u1"}\n',
  );

  it.each([
    ["*/**/**", ["oc://session/L1"], ["oc://session/L3"]],
    ["**/**/**", ["oc://session", "oc://session/L1", "oc://session/L3"], []],
    ["{L1,$first,$last}/**/**", ["oc://session/L1"], ["oc://session/L3"]],
  ])("retains distinct physical-line targets for %s", (pattern, prefix, nextLine) => {
    const lineAst = parseJsonl('{"a":{"b":1},"a.b":2}\n\n{"a":{"b":1},"a.b":2}\n');
    const out = find(lineAst, "oc://session/" + pattern);
    expect(formattedPaths(out)).toEqual([
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
    expectRoundTrips(lineAst, out);
  });

  it("deduplicates quoted aliases within a line", () => {
    const lineAst = parseJsonl('{"a":{"b":1}}\n');
    for (const { union, paths } of [
      { union: '{a,"a"}', paths: ["oc://session/L1/a", "oc://session/L1/a/b"] },
      { union: '{"a",a}', paths: ['oc://session/L1/"a"', 'oc://session/L1/"a"/b'] },
    ]) {
      for (const suffix of ["", "/**"]) {
        const out = find(lineAst, "oc://session/L1/" + union + suffix);
        expect(formattedPaths(out)).toEqual(suffix ? paths : paths.slice(0, 1));
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
    const out = find(lineAst, "oc://session/**/**/event");
    expect(formattedPaths(out)).toEqual(["oc://session/L1/nest/event"]);
    expect(leafValues(out)).toEqual(["x"]);
    expectRoundTrips(lineAst, out);
  });

  it("bounds JSONL expansion across recursive slot partitions", () => {
    const depth = 32;
    const wildcardsPerSlot = 8;
    const value = nestedValue(Array.from({ length: depth }, (_, i) => "k" + i));
    const lineAst = parseJsonl(JSON.stringify(value) + "\n");
    const line = lineAst.lines[0];
    if (line?.kind !== "value") {
      throw new Error("Expected a parsed JSONL value line");
    }
    limitEntryReads(line.value, 3 * (depth + 1) ** 2 * wildcardsPerSlot);
    const slot = Array(wildcardsPerSlot).fill("**").join(".");
    const out = find(lineAst, "oc://session/" + [slot, slot, slot].join("/"));
    expect(out).toHaveLength(depth + 2);
    expect(leafValues(out.filter(({ match }) => match.kind === "leaf"))).toEqual(["1"]);
    expectRoundTrips(lineAst, out);
  });

  it("expands a union of literal and positional line addresses", () => {
    const out = find(ast, "oc://session/{L2,$first,$last}/event");
    expect(leafValues(out)).toEqual(["action", "start", "end"]);
    expect(out.map(({ path }) => path.section)).toEqual(["L2", "L1", "L3"]);
  });

  it("filters value lines by a top-level field", () => {
    const out = find(ast, "oc://session/[event=action]/userId");
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
    expect(leafValues(find(ast, "oc://config/models/[" + predicate + "]/id"))).toEqual(expected);
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
      const out = find(ast, pattern);
      expect(formattedPaths(out)).toEqual([address]);
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
        const out = find(ast, `oc://notes.md/settings/#0/${field}`);
        expect(formattedPaths(out)).toEqual([address]);
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
      expect(leafValues(find(ast, address))).toEqual(["keep"]);
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
    const out = find(md, 'oc://AGENTS.md/{tools,"tools"}/*/foo');
    expect(out.map(({ path }) => path.item)).toEqual(["#0", "#1"]);
    expect(leafValues(out)).toEqual(["a", "b"]);
  });

  it("keeps item nodes when a recursive wildcard consumes the item slot", () => {
    const out = find(md, "oc://AGENTS.md/tools/**");
    expect(formattedPaths(out)).toEqual([
      "oc://AGENTS.md/tools",
      "oc://AGENTS.md/tools/#0",
      "oc://AGENTS.md/tools/#1",
      "oc://AGENTS.md/tools/bar",
    ]);
    expectRoundTrips(md, out);
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
    const out = find(document, "oc://tools.md/" + [slot, slot, slot].join("/"));
    expect(out).toHaveLength(1 + blockCount + 2 * blockCount * itemsPerBlock);
    expect(leafValues(out.filter(({ match }) => match.kind === "leaf"))).toEqual(
      Array.from({ length: blockCount * itemsPerBlock }, (_, index) => String(index)),
    );
    expectRoundTrips(document, out);
  });

  it("rejects out-of-range ordinals", () => {
    expect(resolveOcPath(md, parseOcPath("oc://AGENTS.md/tools/#99/foo"))).toBeNull();
  });

  it("wraps a concrete item match without expansion", () => {
    const out = find(md, "oc://AGENTS.md/tools/bar");
    expect(formattedPaths(out)).toEqual(["oc://AGENTS.md/tools/bar"]);
    expect(out.map(({ match }) => match)).toEqual([
      { kind: "node", descriptor: "md-item", line: 5 },
    ]);
  });

  it("enumerates frontmatter keys", () => {
    const ast = parseMd("---\nname: drafter\nrole: writer\n---\n");
    const out = find(ast, "oc://SOUL.md/[frontmatter]/*");
    expect(out.map(({ path }) => path.item)).toEqual(["name", "role"]);
    expect(leafValues(out)).toEqual(["drafter", "writer"]);
  });

  const predicates = parseMd(
    "## Boundaries\n\n- enabled: true\n- timeout: 5\n\n## Limits\n\n- enabled: false\n- max-tokens: 4096\n",
  );

  it.each([
    ["[enabled=true]/*/*", ["boundaries", "boundaries"], ["true", "5"]],
    ["limits/[enabled=false]/*", ["limits"], ["false"]],
    ["limits/max-tokens/[max-tokens=4096]", ["limits"], ["4096"]],
  ])("filters Markdown at %s", (suffix, sections, values) => {
    const out = find(predicates, "oc://X.md/" + suffix);
    expect(out.map(({ path }) => path.section)).toEqual(sections);
    expect(leafValues(out)).toEqual(values);
  });
});

describe.each([
  ["f.json", parseJsonc, "", [64, 65, 129, 192]],
  ["f.yaml", parseYaml, "", [64, 65, 129, 192]],
  ["events.jsonl", parseJsonl, "/L1", [64, 65, 128]],
])("deep recursive targets in %s", (file, parse, base, depths) => {
  const slots = base ? "**/**" : "**/**/**";
  it.each(depths)("round-trips every result at depth %i", (depth) => {
    const keys = Array.from({ length: depth }, (_, i) => (i === 63 ? "a.b" : "k"));
    const ast = parse(JSON.stringify(nestedValue(keys)) + (base ? "\n" : ""));
    const out = find(ast, "oc://" + file + base + "/" + slots + "?session=deep");
    expect(out).toHaveLength(depth + 1);
    expect(new Set(formattedPaths(out)).size).toBe(out.length);
    expect(leafValues(out.filter(({ match }) => match.kind === "leaf"))).toEqual(["1"]);
    for (const { path } of out) {
      expect(path.session).toBe("deep");
      if (base) {
        expect(path.section).toBe("L1");
      }
    }
    expectRoundTrips(ast, out);
  });
  it("preserves an already valid slot partition", () => {
    const middle = Array(base ? 63 : 64).fill("k");
    const end = base ? ".end" : "/end";
    const raw = JSON.stringify({ start: nestedValue(middle, { end: 1 }) });
    const ast = parse(raw + (base ? "\n" : ""));
    const prefix = "oc://" + file + base + "/start/";
    const out = find(ast, prefix + "**" + end);
    expect(formattedPaths(out)).toEqual([prefix + middle.join(".") + end]);
    expect(leafValues(out)).toEqual(["1"]);
    expectRoundTrips(ast, out);
  });
});
