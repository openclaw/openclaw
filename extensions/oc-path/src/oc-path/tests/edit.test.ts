// OC Path tests cover edit plugin behavior.
import { describe, expect, it } from "vitest";
import { parseOcPath } from "../oc-path.js";
import { parseMd } from "../parse.js";
import { OcEmitSentinelError, REDACTED_SENTINEL } from "../sentinel.js";
import { setOcPath } from "../universal.js";

describe("setOcPath — frontmatter", () => {
  it("replaces frontmatter while retaining unrelated pre-existing sentinel text", () => {
    const raw = `---
name: github
description: old desc
---
Body ${REDACTED_SENTINEL}.`;
    const ast = parseMd(raw);
    const r = setOcPath(ast, parseOcPath("oc://AGENTS.md/[frontmatter]/description"), "new desc");
    expect(r.raw).toBe(`---\nname: github\ndescription: new desc\n---\nBody ${REDACTED_SENTINEL}.`);
  });

  it("reports unresolved when the key is missing", () => {
    const ast = parseMd("---\nname: x\n---\n");
    expect(() => setOcPath(ast, parseOcPath("oc://AGENTS.md/[frontmatter]/nope"), "x")).toThrow(
      expect.objectContaining({ reason: "unresolved" }),
    );
  });

  it("quotes frontmatter values containing structural chars", () => {
    const ast = parseMd("---\nx: a\n---\n");
    const r = setOcPath(ast, parseOcPath("oc://AGENTS.md/[frontmatter]/x"), "has: colon");
    expect(r.raw).toContain('x: "has: colon"');
  });
});

describe("setOcPath — item kv field", () => {
  it.each([["$first", "changed", "second"]])(
    "edits only the duplicate-key item selected by %s",
    (selector, first, second) => {
      const ast = parseMd("## Tools\n- name: first\n- name: second\n");
      const result = setOcPath(
        ast,
        parseOcPath(`oc://AGENTS.md/tools/${selector}/name`),
        "changed",
      );
      expect(result.raw).toBe(`## Tools\n- name: ${first}\n- name: ${second}\n`);
      expect(ast.raw).toBe("## Tools\n- name: first\n- name: second\n");
    },
  );

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

  it.each(["$&"])("preserves literal dollar replacement text %s", (token) => {
    const raw = "## Tools\n\n- command: old\n- keep: stable\n";
    const ast = parseMd(raw);
    const before = structuredClone(ast);
    const value = `literal ${token}`;
    const result = setOcPath(ast, parseOcPath("oc://X.md/tools/command/command"), value);
    expect(result.raw).toBe(`## Tools\n\n- command: ${value}\n- keep: stable\n`);
    expect(ast).toEqual(before);
  });

  it("reports no-item-kv for an item without kv shape", () => {
    const raw = `## Boundaries

- plain bullet
`;
    const ast = parseMd(raw);
    expect(() =>
      setOcPath(ast, parseOcPath("oc://AGENTS.md/boundaries/plain-bullet/plain-bullet"), "x"),
    ).toThrow(expect.objectContaining({ reason: "no-item-kv" }));
  });

  it("reports unresolved when section/item is missing", () => {
    const ast = parseMd("## Other\n\n- foo: bar\n");
    expect(() => setOcPath(ast, parseOcPath("oc://AGENTS.md/missing/foo/foo"), "x")).toThrow(
      expect.objectContaining({ reason: "unresolved" }),
    );
  });

  it("reports not-writable for section-only addresses", () => {
    const ast = parseMd("## Boundaries\n\n- enabled: true\n");
    expect(() => setOcPath(ast, parseOcPath("oc://AGENTS.md/boundaries"), "x")).toThrow(
      expect.objectContaining({ reason: "not-writable" }),
    );
  });
});

describe("setOcPath — sentinel guard (defense-in-depth)", () => {
  it("rejects substring-embedded sentinel on item kv", () => {
    const ast = parseMd("## Boundaries\n\n- enabled: true\n");
    expect(() =>
      setOcPath(
        ast,
        parseOcPath("oc://AGENTS.md/boundaries/enabled/enabled"),
        `prefix${REDACTED_SENTINEL}suffix`,
      ),
    ).toThrow(OcEmitSentinelError);
  });
});
