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
const colonText = "Use anime style IMPORTANT: Must be kawaii";

it.each<[string, Record<string, string>]>([
  [
    'metadata:\n  {\n    "openclaw":\n      {\n        "emoji": "disk",\n        "events": ["command:new"],\n      },\n  }',
    { metadata: '{"openclaw":{"emoji":"disk","events":["command:new"]}}' },
  ],
  [
    "  metadata: {openclaw: {emoji: lobster}} # display metadata",
    { metadata: '{"openclaw":{"emoji":"lobster"}}' },
  ],
  [
    "metadata: {openclaw: {emoji: lobster}} # display metadata",
    { metadata: '{"openclaw":{"emoji":"lobster"}}' },
  ],
  ["metadata: {openclaw:{emoji:'lobster'}}", { metadata: "{openclaw:{emoji:'lobster'}}" }],
  ["metadata: {a: 1,\n  b: 2}", { metadata: '{"a":1,"b":2}' }],
  [
    "enabled: true\nretries: 3\ntags:\n  - alpha\n  - beta\nmetadata:\n  openclaw:\n    events:\n      - command:new",
    {
      enabled: "true",
      retries: "3",
      tags: '["alpha","beta"]',
      metadata: '{"openclaw":{"events":["command:new"]}}',
    },
  ],
  ["description: " + colonText, { description: colonText }],
  [
    "read_when: " + task + "\nsummary: handles formats: pdf and docx",
    { read_when: task, summary: "handles formats: pdf and docx" },
  ],
  [
    'description: "line\\n: detail" # note\nread_when: ' +
      task +
      "\nmetadata:\n  openclaw:\n    emoji: beaker",
    { description: "line\n: detail", read_when: task, metadata: '{"openclaw":{"emoji":"beaker"}}' },
  ],
  ["description: text # note\nread_when: " + task, { description: "text", read_when: task }],
  ['"description": ' + task, { description: task }],
  ["'read_when': " + task, { read_when: task }],
  ["description: | # note\n  line one\n  line two", { description: "line one\nline two" }],
  [
    "description: # Add a description here\nsummary: #1 pick for audits\ncolor: #ff8800",
    { summary: "#1 pick for audits", color: "#ff8800" },
  ],
  ["description: |-\n  {json-like text}", { description: "{json-like text}" }],
])("parses frontmatter: %s", (body, frontmatter) => {
  expect(parseResult(body)).toEqual({ frontmatter, issues: [] });
});

it.each(["", " # display metadata", " #"])("preserves inline JSON before %j", (comment) => {
  expect(parse('metadata: {"openclaw": {"events": ["test#tag"]}}' + comment).metadata).toBe(
    '{"openclaw": {"events": ["test#tag"]}}',
  );
});

it.each([
  ["read_when: " + task + "\nmetadata: owner: value", "BLOCK_AS_IMPLICIT_KEY"],
  ["name: [broken\ndescription: Broken skill", "BAD_INDENT"],
  ["name: first\ndescription: Working skill\nname: second", "DUPLICATE_KEY"],
  ["name: sample-skill\nmetadata: *missing", "YAML_EXCEPTION"],
  ['name: sample-skill\ndescription: Working skill\n"metadata": *missing', "YAML_EXCEPTION"],
])("retains parser error: %s", (body, code) => {
  const result = parseResult(body);
  expect(result.issues[0]).toMatchObject({ code });
  if (code === "BAD_INDENT") {
    expect(result.frontmatter.name).toBe("[broken");
  }
});

it.each(["*legacy", colonText])("recovery of %s does not mask structured aliases", (text) => {
  expect(parseResult("description: " + text + "\nmetadata: *missing").issues).toEqual([
    expect.objectContaining({ code: "YAML_EXCEPTION" }),
  ]);
});

it("reports an unterminated frontmatter block", () => {
  expect(parseFrontmatterBlockResult("---\nname: broken\n")).toEqual({
    frontmatter: {},
    issues: [expect.objectContaining({ code: "UNTERMINATED_FRONTMATTER" })],
  });
});

it.each([
  "# No frontmatter",
  "---not\nname: nope\n---\nBody text",
  "----\nname: nope\n---\nBody text",
  "--- name\nname: nope\n---\nBody text",
  "---\nname: nope\n---not\nBody text",
  "---\nname: nope\n---\u2028Body text\nBody text",
  "---not\nname: nope\n---not\nBody text",
])("preserves content without valid delimiters: %j", (content) => {
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
  expect(parseFrontmatterBlock("\uFEFF" + block("name: windows-skill"))).toEqual({
    name: "windows-skill",
  });
});
