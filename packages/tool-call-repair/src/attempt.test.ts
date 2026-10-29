import { describe, expect, it } from "vitest";
import { detectToolCallShapedText, isPlainTextToolCallAttempt } from "./attempt.js";

const names = new Set(["write", "read"]);
const hasToolName = (name: string) => names.has(name);
const call = '{"name":"write","arguments":{"path":"proof.txt","content":"OK"}}';
const fenced = `\`\`\`json\n${call}\n\`\`\``;
const definition =
  '{"name":"write","description":"Write a file","parameters":{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}}}}';

describe("non-executing text tool-call detection", () => {
  it.each([
    call,
    `{"function_call":${call}}`,
    `{"functionCall":${call}}`,
    '{"name":"write","parameters":{"path":"proof.txt","content":"OK"}}',
    fenced,
    `I'll call write now.\n${fenced}`,
    `Let me invoke the write tool.\n${call}`,
    `I'll create the file now.\n${fenced}`,
    `[{"function":{"name":"read","arguments":"{}"}}]`,
    '{"tool_calls":[{"function":{"name":"read","arguments":{}}}]}',
    `[{"name":"unregistered","arguments":{}},${call}]`,
    '{"tool_calls":[{"function":{"name":"unregistered","arguments":{}}},{"function":{"name":"write","arguments":{}}}]}',
    `[{"tool_calls":[]},${call}]`,
    '<invoke name="read"><parameter name="path">proof.txt</parameter></invoke>',
    'read\n<invoke name="read"><parameter name="path">proof.txt</parameter></invoke>',
    `<tool_call>${call}</tool_call>`,
    "```xml\n<function=read><parameter=path>proof.txt</parameter></function>\n```",
  ])("recognizes a structured attempt: %s", (text) => {
    expect(isPlainTextToolCallAttempt(text, hasToolName)).toBe(true);
  });

  it.each([
    "I will call write to create the file.",
    '{"name":"write","description":"an available tool"}',
    '{"name":"unregistered","arguments":{}}',
    definition,
    '{"name":"write","description":"Write a file","parameters":{"type":"object"}}',
    '{"name":"write","parameters":{"type":"object"}}',
    '{"name":"write","parameters":{"properties":{"path":{"type":"string"}},"required":["path"]}}',
    '{"type":"function","function":{"name":"write","description":"Write a file","parameters":{}}}',
    `{"type":"function","function":${definition}}`,
    `Here is an example of the API:\n${fenced}`,
    `I'll show an example.\n${fenced}`,
    `I will explain the request format. The path selects a file and content supplies its bytes.\n${fenced}`,
    `Documentation\n${fenced}`,
    `I will describe the payload.\nIts path selects a file and content supplies its bytes.\n${fenced}`,
    `I'll outline the request format: path selects the destination and content supplies the file bytes.\n${fenced}`,
    `I'll create a representation of the request.\n${fenced}`,
    `I'll call unregistered now.\n${fenced}`,
    `Usage\n${fenced}`,
    `The file format has two properties. You can adapt this sample to your application.\n${fenced}`,
    `${fenced}\nThis is an example; it has not run.`,
    `\`\`\`text\ncall write proof.txt\n\`\`\``,
    '```json\n{"name":"write","arguments":{}}',
  ])("preserves prose, examples, and unknown tools: %s", (text) => {
    expect(isPlainTextToolCallAttempt(text, hasToolName)).toBe(false);
  });

  it("uses only the current offered tool names", () => {
    expect(isPlainTextToolCallAttempt(fenced, (name) => name === "read")).toBe(false);
    expect(isPlainTextToolCallAttempt(fenced, () => false)).toBe(false);
  });

  it("keeps explanatory prefixes literal even with permissive name matching", () => {
    expect(
      isPlainTextToolCallAttempt(
        `Example of functions.write\n${fenced}`,
        (name) => name === "write" || name.endsWith(".write"),
      ),
    ).toBe(false);
  });
});

it.each([
  [`<TOOL_CALL>\n  ${call}  \n</tool_call>`, true],
  [`<tool_calls> ${call} </tool_calls>`, true],
  [`<tool_call>${call}</tool_calls>`, false],
  [`write\r\n\`\`\`json\r\n${call}\r\n\`\`\``, true],
  [`write\n~~~\n${call}\n\`\`\``, false],
])("keeps wrapper and fence boundaries: %j", (text, expected) =>
  expect(detects(text)).toBe(expected),
);

it("names the tool in a legacy bracketed call", () => {
  expect(detectToolCallShapedText(`note ${legacy}`)).toEqual({
    kind: "bracketed_tool_call",
    toolName: "read",
  });
  expect(detectToolCallShapedText('[TOOL_CALL]{tool => "read"}')).toBeNull();
});

// Each reply shape below took seconds on the former single-regex checks.
it.each([
  [
    "a wrapper tag followed by blank characters",
    () => detects(`<tool_call>${" \n".repeat(1_000)}x`),
    false,
  ],
  ["a fence-like line run", () => detects(`M${"\n~~~\n\u0000".repeat(12_000)}`), false],
  [
    "repeated legacy openers",
    () => detectToolCallShapedText(`{${'[TOOL_CALL]{TOOL=>"G"'.repeat(950)}a`),
    null,
  ],
  [
    "an Action line before blank lines",
    () => detectToolCallShapedText(`Action: x${"\n".repeat(2_000)}y`),
    null,
  ],
] as const)("returns promptly for %s", (_label, run, expected) => {
  const started = performance.now();
  expect(run()).toBe(expected);
  expect(performance.now() - started).toBeLessThan(500);
});

const detects = (text: string) => isPlainTextToolCallAttempt(text, hasToolName);
const legacy = '[TOOL_CALL]{tool => "read", args => {"path":"proof.txt"}}[/TOOL_CALL]';
