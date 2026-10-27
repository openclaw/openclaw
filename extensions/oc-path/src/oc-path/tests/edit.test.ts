import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { parseOcPath } from "../oc-path.js";
import { parseMd } from "../parse.js";
import { OcEmitSentinelError, REDACTED_SENTINEL } from "../sentinel.js";
import { setOcPath } from "../universal.js";

function edit(raw: string, address: string, value: string) {
  return setOcPath(parseMd(raw), parseOcPath(`oc://AGENTS.md/${address}`), value);
}

describe("setOcPath", () => {
  it("replaces frontmatter while retaining unrelated pre-existing sentinel text", () => {
    const r = edit(
      `---\nname: github\ndescription: old desc\n---\nBody ${REDACTED_SENTINEL}.`,
      "[frontmatter]/description",
      "new desc",
    );
    expect(r.raw).toBe(`---\nname: github\ndescription: new desc\n---\nBody ${REDACTED_SENTINEL}.`);
  });

  it.each(["has: colon", "1.10", "0123", "true", "~", "null", "- draft"])(
    "keeps the string %s readable as the same string",
    (value) => {
      const r = edit("---\nversion: 9.9\n---\n", "[frontmatter]/version", value);
      expect(r.raw).toContain(`version: ${JSON.stringify(value)}`);
      expect(parseYaml(r.raw.split(/^---$/m)[1] ?? "").version).toBe(value);
    },
  );

  it.each(["café", "$1", "plain value"])("writes the ordinary string %s unquoted", (value) => {
    const r = edit("---\nversion: 9.9\n---\n", "[frontmatter]/version", value);
    expect(r.raw).toContain(`version: ${value}`);
    expect(parseYaml(r.raw.split(/^---$/m)[1] ?? "").version).toBe(value);
  });

  it("keeps an inserted frontmatter value a string", () => {
    const r = edit("---\nname: x\n---\n", "[frontmatter]/+version", "1.10");
    expect(r.raw).toContain('version: "1.10"');
    expect(parseYaml(r.raw.split(/^---$/m)[1] ?? "").version).toBe("1.10");
  });

  it("edits only the selected duplicate-key item", () => {
    const raw = "## Tools\n- name: first\n- name: second\n";
    const ast = parseMd(raw);
    const result = setOcPath(ast, parseOcPath("oc://AGENTS.md/tools/$first/name"), "changed");
    expect(result.raw).toBe("## Tools\n- name: changed\n- name: second\n");
    expect(ast.raw).toBe(raw);
  });

  it("keeps item positions and explicit values through multiline edits and insertion", () => {
    let ast = parseMd(
      "---\ndescription: |\n  old\n  text\n---\n## Intro\n- keep: stable\n## Tools\n- name: first\n- name: second\n",
    );
    for (const [address, value] of [
      ["[frontmatter]/description", "short"],
      ["tools/#0/name", "first\n- name: literal"],
      ["tools/$last/name", "second changed"],
      ["[frontmatter]/+added", "value"],
      ["tools/+", "name: appended"],
      ["tools/#2/name", "appended changed"],
    ] as const) {
      const result = setOcPath(ast, parseOcPath(`oc://AGENTS.md/${address}`), value);
      if (result.kind !== "md") {
        throw new Error(`expected Markdown edit at ${address} to succeed`);
      }
      ast = result;
    }
    expect(ast.raw).toBe(
      "---\ndescription: short\nadded: value\n---\n## Intro\n- keep: stable\n## Tools\n- name: first\n- name: literal\n- name: second changed\n- name: appended changed\n",
    );
    expect(ast.blocks[1]?.items.map((item) => item.kv?.value)).toEqual([
      "first\n- name: literal",
      "second changed",
      "appended changed",
    ]);
  });

  it("preserves literal dollar replacement text", () => {
    const raw = "## Tools\n\n- command: old\n- keep: stable\n";
    const ast = parseMd(raw);
    const before = structuredClone(ast);
    const result = setOcPath(ast, parseOcPath("oc://X.md/tools/command/command"), "literal $&");
    expect(result.raw).toBe("## Tools\n\n- command: literal $&\n- keep: stable\n");
    expect(ast).toEqual(before);
  });

  it.each([
    ["---\nname: x\n---\n", "[frontmatter]/nope", "unresolved"],
    ["## Boundaries\n\n- plain bullet\n", "boundaries/plain-bullet/plain-bullet", "no-item-kv"],
    ["## Other\n\n- foo: bar\n", "missing/foo/foo", "unresolved"],
    ["## Boundaries\n\n- enabled: true\n", "boundaries", "not-writable"],
  ])("rejects %s at %s with %s", (raw, address, reason) => {
    expect(() => edit(raw, address, "x")).toThrow(expect.objectContaining({ reason }));
  });

  it("rejects substring-embedded sentinel on item kv", () => {
    expect(() =>
      edit(
        "## Boundaries\n\n- enabled: true\n",
        "boundaries/enabled/enabled",
        `prefix${REDACTED_SENTINEL}suffix`,
      ),
    ).toThrow(OcEmitSentinelError);
  });
});
