// OC Path tests cover frontmatter edges plugin behavior.
import { describe, expect, it } from "vitest";
import { parseMd } from "../../parse.js";

describe("frontmatter-edges", () => {
  it("empty frontmatter (just open + close)", () => {
    const { ast } = parseMd("---\n---\n");
    expect(ast.frontmatter).toEqual([]);
  });

  it("frontmatter only, file has no other content", () => {
    const { ast } = parseMd("---\nk: v\n---\n");
    expect(ast.frontmatter).toEqual([{ key: "k", value: "v", line: 2 }]);
    expect(ast.preamble).toBe("");
    expect(ast.blocks).toEqual([]);
  });

  it("unquoted value with internal colons preserved", () => {
    const { ast } = parseMd("---\nurl: https://example.com:443/p\n---\n");
    expect(ast.frontmatter[0]?.value).toBe("https://example.com:443/p");
  });

  it("empty value", () => {
    const { ast } = parseMd("---\nk:\n---\n");
    expect(ast.frontmatter[0]).toEqual({ key: "k", value: "", line: 2 });
  });

  it("value with leading/trailing whitespace trimmed", () => {
    const { ast } = parseMd("---\nk:    spaced    \n---\n");
    expect(ast.frontmatter[0]?.value).toBe("spaced");
  });

  it("list-style continuations are silently dropped (substrate stays opinion-free)", () => {
    const { ast } = parseMd("---\ntools:\n  - gh\n  - curl\n---\n");
    // The `tools:` key has an empty inline value; the list continuation
    // lines `  - gh` and `  - curl` don't match the kv regex and are
    // skipped. Lint rules can do their own structural reading of
    // frontmatter; the substrate does not.
    expect(ast.frontmatter.map((e) => e.key)).toEqual(["tools"]);
    expect(ast.frontmatter[0]?.value).toBe("");
  });

  it("dash-key allowed", () => {
    const { ast } = parseMd("---\nuser-invocable: true\n---\n");
    expect(ast.frontmatter[0]?.key).toBe("user-invocable");
  });

  it("underscore-key allowed", () => {
    const { ast } = parseMd("---\nparam_set: foo\n---\n");
    expect(ast.frontmatter[0]?.key).toBe("param_set");
  });

  it("number-only value preserved as string", () => {
    const { ast } = parseMd("---\ntimeout: 15000\n---\n");
    expect(ast.frontmatter[0]?.value).toBe("15000");
  });

  it("boolean-like value preserved as string", () => {
    const { ast } = parseMd("---\nenabled: true\n---\n");
    expect(ast.frontmatter[0]?.value).toBe("true");
  });

  it("frontmatter with same key twice — both retained (no dedup)", () => {
    const { ast } = parseMd("---\nk: v1\nk: v2\n---\n");
    expect(ast.frontmatter).toEqual([
      { key: "k", value: "v1", line: 2 },
      { key: "k", value: "v2", line: 3 },
    ]);
  });

  it("frontmatter must be at start — leading blank line breaks detection", () => {
    const { ast } = parseMd("\n---\nk: v\n---\n");
    expect(ast.frontmatter).toEqual([]);
  });

  it("BOM before frontmatter open is tolerated", () => {
    const { ast } = parseMd("﻿---\nname: bom\n---\n");
    expect(ast.frontmatter[0]?.value).toBe("bom");
  });
});
