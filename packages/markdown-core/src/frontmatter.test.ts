import { expect, it } from "vitest";
import {
  parseFrontmatterBlock,
  parseFrontmatterBlockResult,
  stripFrontmatterBlock,
} from "./frontmatter.js";

const block = (body: string) => `---\n${body}\n---\n`;
const parse = (body: string) => parseFrontmatterBlock(block(body));
const parseResult = (body: string) => parseFrontmatterBlockResult(block(body));
const task = "signals: user announcing a conversion task";

it.each<[string, string, Record<string, string>]>([
  [
    "JSON5 metadata",
    'metadata:\n  {\n    "openclaw":\n      {\n        "emoji": "disk",\n        "events": ["command:new"],\n      },\n  }',
    { metadata: '{"openclaw":{"emoji":"disk","events":["command:new"]}}' },
  ],
  [
    "indented YAML flow",
    "  metadata: {openclaw: {emoji: lobster}} # display metadata",
    { metadata: '{"openclaw":{"emoji":"lobster"}}' },
  ],
  ["multiline flow", "metadata: {a: 1,\n  b: 2}", { metadata: '{"a":1,"b":2}' }],
  [
    "objects and arrays",
    "enabled: true\nretries: 3\ntags:\n  - alpha\n  - beta\nmetadata:\n  openclaw:\n    events:\n      - command:new",
    {
      enabled: "true",
      retries: "3",
      tags: '["alpha","beta"]',
      metadata: '{"openclaw":{"events":["command:new"]}}',
    },
  ],
  [
    "colon-rich description",
    "description: Use anime style IMPORTANT: Must be kawaii",
    { description: "Use anime style IMPORTANT: Must be kawaii" },
  ],
  [
    "multiple colon-rich fields",
    "read_when: " + task + "\nsummary: handles formats: pdf and docx",
    { read_when: task, summary: "handles formats: pdf and docx" },
  ],
  [
    "structured sibling",
    "read_when: " + task + "\nmetadata:\n  openclaw:\n    emoji: beaker",
    { read_when: task, metadata: '{"openclaw":{"emoji":"beaker"}}' },
  ],
  [
    "commented sibling",
    "description: text # note\nread_when: " + task,
    { description: "text", read_when: task },
  ],
  [
    "escaped sibling",
    'description: "line\\n: detail"\nread_when: ' + task,
    { description: "line\n: detail", read_when: task },
  ],
  ["double-quoted key", '"description": ' + task, { description: task }],
  ["single-quoted key", "'read_when': " + task, { read_when: task }],
  ["quoted escape", 'description: "line\\nbreak"', { description: "line\nbreak" }],
  [
    "block scalar",
    "description: | # note\n  line one\n  line two",
    { description: "line one\nline two" },
  ],
  [
    "hash-led text",
    "description: # Add a description here\nsummary: #1 pick for audits\ncolor: #ff8800",
    { summary: "#1 pick for audits", color: "#ff8800" },
  ],
  [
    "chomped block scalar",
    "description: |-\n  {json-like text}",
    { description: "{json-like text}" },
  ],
])("parses frontmatter: %s", (_name, body, frontmatter) => {
  expect(parseResult(body)).toEqual({ frontmatter, issues: [] });
});

it.each(["", " # display metadata", " #"])("preserves inline JSON before %j", (comment) => {
  expect(parse('metadata: {"openclaw": {"events": ["test#tag"]}}' + comment).metadata).toBe(
    '{"openclaw": {"events": ["test#tag"]}}',
  );
});

it.each([
  [
    "strict structured field",
    "read_when: " + task + "\nmetadata: owner: value",
    "BLOCK_AS_IMPLICIT_KEY",
  ],
  ["malformed sequence", "name: [broken\ndescription: Broken skill", "BAD_INDENT"],
  ["duplicate key", "name: first\ndescription: Working skill\nname: second", "DUPLICATE_KEY"],
  ["unresolved alias", "name: sample-skill\nmetadata: *missing", "YAML_EXCEPTION"],
  [
    "quoted alias key",
    'name: sample-skill\ndescription: Working skill\n"metadata": *missing',
    "YAML_EXCEPTION",
  ],
])("retains parser error: %s", (_name, body, code) => {
  const result = parseResult(body);
  expect(result.issues[0]).toMatchObject({ code });
  if (code === "BAD_INDENT") {
    expect(result.frontmatter.name).toBe("[broken");
  }
});

it.each(["*legacy", "Use anime style IMPORTANT: Must be kawaii"])(
  "recovers description %s without masking structured aliases",
  (description) => {
    expect(parseResult("description: " + description + "\nmetadata: *missing").issues).toEqual([
      expect.objectContaining({ code: "YAML_EXCEPTION" }),
    ]);
  },
);

it("returns empty when frontmatter is missing", () => {
  expect(parseFrontmatterBlock("# No frontmatter")).toStrictEqual({});
});

it("reports an unterminated frontmatter block", () => {
  expect(
    parseFrontmatterBlockResult("---\nname: broken\ndescription: Missing delimiter\n"),
  ).toEqual({
    frontmatter: {},
    issues: [expect.objectContaining({ code: "UNTERMINATED_FRONTMATTER" })],
  });
});

it.each(["---not", "----", "--- name"])("ignores opening prefix %s", (prefix) => {
  expect(parseFrontmatterBlock(prefix + "\nname: nope\n---\nBody text")).toStrictEqual({});
});

it.each(["---not", "---\u2028Body text"])("ignores closing prefix %s", (closing) => {
  const content = "---\nname: nope\n" + closing + "\nBody text";
  expect(parseFrontmatterBlock(content)).toStrictEqual({});
  expect(stripFrontmatterBlock(content)).toBe(content);
});

it("accepts delimiter lines with trailing whitespace", () => {
  const content = "---   \nname: sample\n---\t\nBody text";
  expect(parseFrontmatterBlock(content)).toStrictEqual({ name: "sample" });
  expect(stripFrontmatterBlock(content)).toBe("Body text");
});

it("preserves prototype-named keys when YAML value is null", () => {
  const keys = ["toString", "constructor", "valueOf", "hasOwnProperty"];
  const result = parse("title: Hello\n" + keys.map((key) => key + ": null").join("\n"));
  for (const key of keys) {
    expect(Object.hasOwn(result, key)).toBe(true);
    expect(result[key]).toBe("null");
  }
  expect(result.title).toBe("Hello");
});

it("parses frontmatter after a leading UTF-8 BOM", () => {
  expect(
    parseFrontmatterBlock(
      "\uFEFF" + block("name: windows-skill\ndescription: Written by PowerShell"),
    ),
  ).toEqual({ name: "windows-skill", description: "Written by PowerShell" });
});

it("preserves Markdown that starts with a non-delimiter prefix", () => {
  const content = "---not\nname: nope\n---not\nBody text";
  expect(stripFrontmatterBlock(content)).toBe(content);
});
