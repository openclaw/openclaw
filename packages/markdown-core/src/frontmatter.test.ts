import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import {
  parseFrontmatterBlock,
  parseFrontmatterBlockResult,
  stripFrontmatterBlock,
} from "./frontmatter.js";

const block = (body: string) => `---\n${body}\n---\n`;
const parse = (body: string) => parseFrontmatterBlock(block(body));
const parseResult = (body: string) => parseFrontmatterBlockResult(block(body));

describe("parseFrontmatterBlock", () => {
  it("handles JSON5-style multi-line metadata", () => {
    const content = `---
name: session-memory
metadata:
  {
    "openclaw":
      {
        "emoji": "disk",
        "events": ["command:new"],
      },
  }
---
`;
    const result = parseFrontmatterBlock(content);
    expect(result.metadata).toBe('{"openclaw":{"emoji":"disk","events":["command:new"]}}');
  });

  it.each(["", " # display metadata", " #"])(
    "preserves inline JSON values before %j",
    (comment) => {
      const result = parse(`metadata: {"openclaw": {"events": ["test#tag"]}}${comment}`);
      expect(result.metadata).toBe('{"openclaw": {"events": ["test#tag"]}}');
    },
  );

  it("normalizes an indented YAML flow mapping without a line-parser fallback", () => {
    const result = parse("  metadata: {openclaw: {emoji: lobster}} # display metadata");
    expect(JSON.parse(result.metadata ?? "")).toEqual({ openclaw: { emoji: "lobster" } });
  });

  it("keeps a flow value that continues on the next line", () => {
    const result = parse("metadata: {a: 1,\n  b: 2}");
    expect(JSON.parse(result.metadata ?? "")).toEqual({ a: 1, b: 2 });
  });

  it("stringifies YAML objects and arrays", () => {
    const result = parse(
      "enabled: true\nretries: 3\ntags:\n  - alpha\n  - beta\n" +
        "metadata:\n  openclaw:\n    events:\n      - command:new",
    );
    expect(result).toMatchObject({ enabled: "true", retries: "3" });
    expect(JSON.parse(result.tags ?? "[]")).toEqual(["alpha", "beta"]);
    const parsed = JSON5.parse(result.metadata ?? "");
    expect(parsed.openclaw?.events).toEqual(["command:new"]);
  });

  it("normalizes free-form descriptions before YAML parsing", () => {
    const content = `---
name: sample-skill
description: Use anime style IMPORTANT: Must be kawaii
---`;
    const result = parseFrontmatterBlockResult(content);

    expect(result.frontmatter.description).toBe("Use anime style IMPORTANT: Must be kawaii");
    expect(result.issues).toEqual([]);
  });

  it("normalizes multiple colon-rich pure-text fields in one block", () => {
    expect(
      parseResult(
        "read_when: signals: user announcing a conversion task\nsummary: handles formats: pdf and docx",
      ),
    ).toEqual({
      frontmatter: {
        read_when: "signals: user announcing a conversion task",
        summary: "handles formats: pdf and docx",
      },
      issues: [],
    });
  });

  it("keeps structured fields strict when a pure-text field is normalized", () => {
    const result = parseResult(
      "read_when: signals: user announcing a conversion task\nmetadata: owner: value",
    );

    expect(result.issues[0]).toMatchObject({ code: "BLOCK_AS_IMPLICIT_KEY" });
  });

  it("preserves valid structured siblings when pure-text fields are normalized", () => {
    const result = parseFrontmatterBlockResult(`---
name: sample-skill
read_when: signals: user announcing a conversion task
metadata:
  openclaw:
    emoji: beaker
---`);

    expect(result.frontmatter.metadata).toBe('{"openclaw":{"emoji":"beaker"}}');
    expect(result.issues).toEqual([]);
  });

  it("does not rewrite valid sibling values when recovering a malformed field", () => {
    const content = `---
name: sample-skill
description: text # note
read_when: signals: user announcing a conversion task
---`;
    const result = parseFrontmatterBlockResult(content);

    expect(result.frontmatter.description).toBe("text");
    expect(result.frontmatter.read_when).toBe("signals: user announcing a conversion task");
    expect(result.issues).toEqual([]);
  });

  it("does not rewrite valid quoted sibling scalars with escape sequences", () => {
    expect(
      parseResult(
        'description: "line\\n: detail"\nread_when: signals: user announcing a conversion task',
      ),
    ).toEqual({
      frontmatter: {
        description: "line\n: detail",
        read_when: "signals: user announcing a conversion task",
      },
      issues: [],
    });
  });

  it("recovers quoted freeform keys with colon-rich values", () => {
    const content = `---
name: sample-skill
"description": signals: user announcing a conversion task
---`;
    const result = parseFrontmatterBlockResult(content);

    expect(result.frontmatter.description).toBe("signals: user announcing a conversion task");
    expect(result.issues).toEqual([]);
  });

  it("recovers single-quoted freeform keys with colon-rich values", () => {
    expect(parseResult("'read_when': signals: user announcing a conversion task")).toEqual({
      frontmatter: { read_when: "signals: user announcing a conversion task" },
      issues: [],
    });
  });

  it("leaves valid YAML description semantics untouched", () => {
    expect(
      parseFrontmatterBlock(`---
name: comment
description: text # note
---`).description,
    ).toBe("text");
    expect(
      parseFrontmatterBlock(`---
name: escape
description: "line\\nbreak"
---`).description,
    ).toBe("line\nbreak");
    expect(
      parseFrontmatterBlock(`---
name: block
description: | # note
  line one
  line two
---`).description,
    ).toBe("line one\nline two");
  });

  it("drops comment-only values but keeps unquoted hash-led text", () => {
    const parsed = parse(
      "description: # Add a description here\nsummary: #1 pick for audits\ncolor: #ff8800",
    );

    expect(parsed.description).toBeUndefined();
    expect(parsed.summary).toBe("#1 pick for audits");
    expect(parsed.color).toBe("#ff8800");
  });

  it("retains structured-value parser errors for owning loaders", () => {
    const result = parseFrontmatterBlockResult(`---
name: [broken
description: Broken skill
---`);

    expect(result.frontmatter.name).toBe("[broken");
    expect(result.issues[0]).toMatchObject({ code: "BAD_INDENT" });
  });

  it("attributes errors positioned on a key to that key", () => {
    const result = parseFrontmatterBlockResult(`---
name: first
description: Working skill
name: second
---`);

    expect(result.issues[0]).toMatchObject({ code: "DUPLICATE_KEY" });
  });

  it("attributes unresolved alias conversion errors to their owning field", () => {
    const result = parseFrontmatterBlockResult(`---
name: sample-skill
metadata: *missing
---`);

    expect(result.issues[0]).toMatchObject({ code: "YAML_EXCEPTION" });
  });

  it("decodes quoted keys when attributing conversion errors", () => {
    const result = parseFrontmatterBlockResult(`---
name: sample-skill
description: Working skill
"metadata": *missing
---`);

    expect(result.issues[0]).toMatchObject({ code: "YAML_EXCEPTION" });
  });

  it("normalizes description aliases without masking structured aliases", () => {
    const result = parseResult("description: *legacy\nmetadata: *missing");

    expect(result.issues).toEqual([expect.objectContaining({ code: "YAML_EXCEPTION" })]);
  });

  it("normalizes colon-rich descriptions without masking structured aliases", () => {
    const result = parseFrontmatterBlockResult(`---
name: sample-skill
description: Use anime style IMPORTANT: Must be kawaii
metadata: *missing
---`);

    expect(result.issues).toEqual([expect.objectContaining({ code: "YAML_EXCEPTION" })]);
  });

  it("does not replace YAML block scalars with block indicators", () => {
    const content = `---
name: sample-skill
description: |-
  {json-like text}
---`;
    const result = parseFrontmatterBlock(content);
    expect(result.description).toBe("{json-like text}");
  });

  it("returns empty when frontmatter is missing", () => {
    expect(parseFrontmatterBlock("# No frontmatter")).toStrictEqual({});
  });

  it("reports an unterminated frontmatter block", () => {
    const result = parseFrontmatterBlockResult(`---
name: broken
description: Missing the closing delimiter
`);

    expect(result.frontmatter).toEqual({});
    expect(result.issues).toEqual([expect.objectContaining({ code: "UNTERMINATED_FRONTMATTER" })]);
  });

  it("ignores non-delimiter opening prefixes", () => {
    for (const prefix of ["---not", "----", "--- name"]) {
      const content = `${prefix}
name: nope
---
Body text`;
      expect(parseFrontmatterBlock(content)).toStrictEqual({});
    }
  });

  it("ignores non-delimiter closing prefixes", () => {
    for (const closing of ["---not", "---\u2028Body text"]) {
      const content = `---\nname: nope\n${closing}\nBody text`;
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
    const keys = ["toString", "constructor", "valueOf", "hasOwnProperty"];
    const result = parse(`title: Hello\n${keys.map((key) => `${key}: null`).join("\n")}`);
    for (const key of keys) {
      expect(Object.hasOwn(result, key)).toBe(true);
      expect(result[key]).toBe("null");
    }
    expect(result.title).toBe("Hello");
  });

  it("parses frontmatter after a leading UTF-8 BOM", () => {
    const content = "\uFEFF---\nname: windows-skill\ndescription: Written by PowerShell\n---\n";
    const result = parseFrontmatterBlock(content);

    expect(result.name).toBe("windows-skill");
    expect(result.description).toBe("Written by PowerShell");
  });
});

describe("stripFrontmatterBlock", () => {
  it("preserves Markdown that starts with a non-delimiter prefix", () => {
    const content = `---not
name: nope
---not
Body text`;
    expect(stripFrontmatterBlock(content)).toBe(content);
  });
});
