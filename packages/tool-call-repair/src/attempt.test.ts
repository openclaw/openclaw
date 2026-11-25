import { expect, it } from "vitest";
import { detectToolCallShapedText, isPlainTextToolCallAttempt } from "./attempt.js";

const hasToolName = (name: string) => name === "write" || name === "read";
const call = '{"name":"write","arguments":{"path":"proof.txt","content":"OK"}}';
const fenced = `\`\`\`json\n${call}\n\`\`\``;
const definition =
  '{"name":"write","description":"Write a file","parameters":{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}}}}';
const wrappedXml =
  "<tool_call><function=read><parameter=path>proof.txt</parameter></function></tool_call>";
const react = 'Action: read\nAction Input: {"path":"proof.txt"}';
const legacy = '[TOOL_CALL]{tool => "read", args => {"path":"proof.txt"}}[/TOOL_CALL]';
const detects = (text: string) => isPlainTextToolCallAttempt(text, hasToolName);

it.each([
  call,
  `{"function_call":${call}}`,
  `{"functionCall":${call}}`,
  '{"name":"write","parameters":{"path":"proof.txt","content":"OK"}}',
  fenced,
  `I'll call write now.\n${fenced}`,
  `I'll create the file now.\n${fenced}`,
  `[{"function":{"name":"read","arguments":"{}"}}]`,
  '{"tool_calls":[{"function":{"name":"read","arguments":{}}}]}',
  '{"tool_calls":[{"function":{"name":"unregistered","arguments":{}}},{"function":{"name":"write","arguments":{}}}]}',
  `[{"tool_calls":[]},${call}]`,
  '<invoke name="read"><parameter name="path">proof.txt</parameter></invoke>',
  'read\n<invoke name="read"><parameter name="path">proof.txt</parameter></invoke>',
  `<tool_call>${call}</tool_call>`,
  "```xml\n<function=read><parameter=path>proof.txt</parameter></function>\n```",
  wrappedXml,
  "<function_call><function=read><parameter=path>proof.txt</parameter></function></function_call>",
  react,
  "Action: read\r\nAction Input: proof.txt",
  legacy,
])("recognizes a structured attempt: %s", (text) => expect(detects(text)).toBe(true));

it.each([
  "I will call write to create the file.",
  '{"name":"write","description":"an available tool"}',
  '{"name":"unregistered","arguments":{}}',
  definition,
  '{"name":"write","parameters":{"type":"object"}}',
  '{"name":"write","parameters":{"properties":{"path":{"type":"string"}},"required":["path"]}}',
  '{"type":"function","function":{"name":"write","description":"Write a file","parameters":{}}}',
  `Here is an example of the API:\n${fenced}`,
  `I'll show an example.\n${fenced}`,
  `I will describe the payload.\nIts path selects a file and content supplies its bytes.\n${fenced}`,
  `I'll create a representation of the request.\n${fenced}`,
  `I'll call unregistered now.\n${fenced}`,
  `${fenced}\nThis is an example; it has not run.`,
  `\`\`\`text\ncall write proof.txt\n\`\`\``,
  '```json\n{"name":"write","arguments":{}}',
  ...[wrappedXml, react, legacy].flatMap((text) => [
    text.replaceAll("read", "unregistered"),
    `Here is an example:\n${text}`,
    `Here is an example:\n\`\`\`\n${text}\n\`\`\``,
  ]),
  "<tool_call><function=read><parameter=path>proof.txt</parameter></function>",
  "<tool_call><function=read><parameter=path>proof.txt</parameter></function></function_call>",
  "Action: read",
  "Action: read\nAction Input:",
  'Action: read\nAction Input: {"path":"proof.txt"',
  'Action: read\nAction Input: ["proof.txt"',
  'Action: read\nAction Input: "proof.txt',
  'Action: read\nAction Input: {"path":"proof.txt"}\nObservation: example result',
  '[TOOL_CALL]{tool => "read", args => {}}',
  '[TOOL_CALL]{tool => "read"}[/TOOL_CALL]',
])("preserves prose, examples, and unknown tools: %s", (text) => expect(detects(text)).toBe(false));

it("uses only the current offered tool names", () => {
  expect(isPlainTextToolCallAttempt(fenced, (name) => name === "read")).toBe(false);
});

it("keeps explanatory prefixes literal even with permissive name matching", () => {
  const matches = (name: string) => name === "write" || name.endsWith(".write");
  expect(isPlainTextToolCallAttempt(`Example of functions.write\n${fenced}`, matches)).toBe(false);
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
