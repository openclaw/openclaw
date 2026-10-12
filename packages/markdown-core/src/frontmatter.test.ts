// Markdown Core tests cover frontmatter behavior.
import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import {
  parseFrontmatterBlock,
  parseFrontmatterBlockResult,
  stripFrontmatterBlock,
} from "./frontmatter.js";

describe("parseFrontmatterBlock", () => {
  it("preserves inline JSON values", () => {
    const content = `---
name: inline-json
metadata: {"openclaw": {"events": ["test"]}}
---
`;
    const result = parseFrontmatterBlock(content);
    expect(result.metadata).toBe('{"openclaw": {"events": ["test"]}}');
  });

  it("keeps a flow value that continues on the next line", () => {
    const content = `---
name: wrapped-flow
metadata: {a: 1,
  b: 2}
---
`;
    const result = parseFrontmatterBlock(content);
    expect(JSON.parse(result.metadata ?? "")).toEqual({ a: 1, b: 2 });
  });

  it("stringifies YAML objects and arrays", () => {
    const content = `---
name: yaml-objects
enabled: true
retries: 3
tags:
  - alpha
  - beta
metadata:
  openclaw:
    events:
      - command:new
---
`;
    const result = parseFrontmatterBlock(content);
    expect(result.enabled).toBe("true");
    expect(result.retries).toBe("3");
    expect(JSON.parse(result.tags ?? "[]")).toEqual(["alpha", "beta"]);
    const parsed = JSON5.parse(result.metadata ?? "");
    expect(parsed.openclaw?.events).toEqual(["command:new"]);
  });

  it("normalizes multiple colon-rich pure-text fields in one block", () => {
    const content = `---
name: sample-skill
read_when: signals: user announcing a conversion task
summary: handles formats: pdf and docx
---`;
    const result = parseFrontmatterBlockResult(content);

    expect(result.frontmatter.read_when).toBe("signals: user announcing a conversion task");
    expect(result.frontmatter.summary).toBe("handles formats: pdf and docx");
    expect(result.issues).toEqual([]);
  });

  it("keeps structured fields strict when a pure-text field is normalized", () => {
    const result = parseFrontmatterBlockResult(`---
name: sample-skill
read_when: signals: user announcing a conversion task
metadata: owner: value
---`);

    expect(result.issues[0]).toMatchObject({ code: "BLOCK_AS_IMPLICIT_KEY" });
  });

  it("does not rewrite valid quoted sibling scalars with escape sequences", () => {
    const content = `---
name: sample-skill
description: "line\\n: detail"
read_when: signals: user announcing a conversion task
---`;
    const result = parseFrontmatterBlockResult(content);

    expect(result.frontmatter.description).toBe("line\n: detail");
    expect(result.frontmatter.read_when).toBe("signals: user announcing a conversion task");
    expect(result.issues).toEqual([]);
  });

  it("recovers single-quoted freeform keys with colon-rich values", () => {
    const content = `---
name: sample-skill
'read_when': signals: user announcing a conversion task
---`;
    const result = parseFrontmatterBlockResult(content);

    expect(result.frontmatter.read_when).toBe("signals: user announcing a conversion task");
    expect(result.issues).toEqual([]);
  });

  it("normalizes description aliases without masking structured aliases", () => {
    const result = parseFrontmatterBlockResult(`---
name: sample-skill
description: *legacy
metadata: *missing
---`);

    expect(result.issues).toEqual([expect.objectContaining({ code: "YAML_EXCEPTION" })]);
  });

  it("returns empty when frontmatter is missing", () => {
    const content = "# No frontmatter";
    expect(parseFrontmatterBlock(content)).toStrictEqual({});
  });

  it("ignores non-delimiter closing prefixes", () => {
    for (const closing of ["---not", "---\u2028Body text"]) {
      const content = `---
name: nope
${closing}
Body text`;
      expect(parseFrontmatterBlock(content)).toStrictEqual({});
      expect(stripFrontmatterBlock(content)).toBe(content);
    }
  });

  it("accepts delimiter lines with trailing whitespace", () => {
    const content = ["---   ", "name: sample", "---\t", "Body text"].join("\n");
    expect(parseFrontmatterBlock(content)).toStrictEqual({ name: "sample" });
    expect(stripFrontmatterBlock(content)).toBe("Body text");
  });

  it("preserves prototype-named keys when YAML value is null", () => {
    const content = `---
title: Hello
toString: null
constructor: null
valueOf: null
hasOwnProperty: null
---
Body text`;
    const result = parseFrontmatterBlock(content);
    expect(Object.hasOwn(result, "toString")).toBe(true);
    expect(result["toString"]).toBe("null");
    expect(Object.hasOwn(result, "constructor")).toBe(true);
    expect(result["constructor"]).toBe("null");
    expect(Object.hasOwn(result, "valueOf")).toBe(true);
    expect(result["valueOf"]).toBe("null");
    expect(Object.hasOwn(result, "hasOwnProperty")).toBe(true);
    expect(result["hasOwnProperty"]).toBe("null");
    // normal key unaffected
    expect(result.title).toBe("Hello");
  });
});
