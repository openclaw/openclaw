import { createHash } from "node:crypto";
import { serialize } from "node:v8";
import { expect, it } from "vitest";
import {
  prepareMemoryIndexChunks,
  type MemoryIndexPreparationInput,
} from "./manager-index-preparation.js";

const prepare = (content: string, overrides: Partial<MemoryIndexPreparationInput> = {}) =>
  prepareMemoryIndexChunks({
    entry: { path: "MEMORY.md", mtimeMs: 1 },
    source: "memory",
    content,
    pathClassification: { curatedRoot: true, originClass: "agent" },
    chunking: { tokens: 400, overlap: 80 },
    hardMaxInputTokens: 8192,
    ...overrides,
  });

const prepareHeading = (content: string, overlap = 0) =>
  prepare(content, {
    entry: { path: "memory/notes.md", mtimeMs: 1 },
    pathClassification: { curatedRoot: false, originClass: "agent" },
    chunking: { tokens: 8, overlap },
  });

it("retains invalid scope on an unterminated heading annotation", () => {
  const { chunks } = prepare(
    "# Private <!-- project: alpha-key\n- Global neighbor. <!-- trigger: global -->",
  );
  expect(chunks.map(({ text, projectKey }) => ({ text, projectKey }))).toEqual([
    { text: "# Private <!-- project: alpha-key", projectKey: "!invalid-project-annotation" },
    { text: "- Global neighbor.", projectKey: null },
  ]);
});

it("keeps a heading fragment's curated-entry annotations", () => {
  const { chunks } = prepare(
    "- Scoped entry. <!-- project: alpha-key -->\n  ## Private heading\n- Global neighbor. <!-- trigger: global -->",
    { chunking: { tokens: 8, overlap: 0 } },
  );
  expect(chunks).toMatchObject([
    { text: "- Scoped entry.", projectKey: "alpha-key", triggers: null },
    { text: "  ## Private heading", projectKey: "alpha-key", triggers: null },
    { text: "- Global neighbor.", projectKey: null, triggers: "global" },
  ]);
});

it.each([0, 2])("keeps a whole heading when chunk overlap is %s", (overlap) => {
  const content = "# Plan\nThe irrigation starts at dawn.";
  const hash = createHash("sha256").update(content).digest("hex");
  const { chunks } = prepareHeading(content, overlap);
  expect(chunks).toMatchObject([{ startLine: 1, endLine: 2, text: content, hash }]);
});

it("preserves a heading continuation sharing the next chunk's source line", () => {
  const { chunks } = prepareHeading(`# ${"a".repeat(32)}\nBody`);
  expect(chunks.map((chunk) => chunk.text).join("")).toBe(`# ${"a".repeat(32)}\nBody`);
});

it.each(["memory", "sessions"] as const)("preserves a final heading for %s", (source) => {
  const { chunks } = prepare("## Unfinished", { source });
  expect(chunks.map((chunk) => chunk.text)).toEqual(["## Unfinished"]);
});

it.each([undefined, { id: "test", maxInputTokens: 4096 }])(
  "transfers plain text once, including provider-limited fragments (%j)",
  (provider) => {
    const content = "a".repeat(64 * 1024);
    const prepared = prepare(content, {
      entry: { path: "sessions/large.jsonl", mtimeMs: 1 },
      source: "sessions",
      pathClassification: { curatedRoot: false, originClass: "agent" },
      chunking: { tokens: 20_000, overlap: 0 },
      provider,
    });

    expect(prepared.chunks.map((chunk) => chunk.text).join("")).toBe(content);
    expect(serialize(prepared).byteLength).toBeLessThan(80 * 1024);
  },
);

const topicBullets = [
  "- Alice prefers morning standups.",
  "- Alice is allergic to peanuts.",
  "- Alice drives a green Volvo.",
];
const topicChunks = (content: string, path = "memory/people/alice.md") =>
  prepare(content, {
    entry: { path, mtimeMs: 1 },
    pathClassification: { curatedRoot: false, originClass: "agent" },
  }).chunks;

it.each([
  ["before the heading", ["<!-- chunking: entries -->", "# Alice"]],
  ["after the heading", ["# Alice", "<!-- chunking: entries -->"]],
])("chunks a topic file per entry with the marker %s", (_label, head) => {
  const chunks = topicChunks([...head, ...topicBullets].join("\n"));
  // The heading attaches to the first entry, as in MEMORY.md.
  // A marker after the heading leaves its blank line behind; the heading still attaches.
  expect(chunks.map((chunk) => chunk.text.replace(/\n\n/u, "\n"))).toEqual([
    `# Alice\n${topicBullets[0]}`,
    topicBullets[1],
    topicBullets[2],
  ]);
});

it("keeps size-based chunking for topic files without the marker", () => {
  const chunks = topicChunks(["# Alice", ...topicBullets].join("\n"));
  expect(chunks).toHaveLength(1);
  expect(chunks[0]?.text).toBe(["# Alice", ...topicBullets].join("\n"));
});

it.each([
  ["a marker inside prose", "Notes mention <!-- chunking: entries --> inline."],
  ["a fenced example", "```md\n<!-- chunking: entries -->\n```"],
  ["an indented code example", "Example:\n\n    <!-- chunking: entries -->\n"],
  ["a tab-indented code example", "Example:\n\n\t<!-- chunking: entries -->\n"],
  [
    "a marker after a non-closing fence line",
    "```md\n```not-a-close\n<!-- chunking: entries -->\n```",
  ],
])("ignores %s", (_label, line) => {
  expect(topicChunks([line, ...topicBullets].join("\n"))).toHaveLength(1);
});

it.each([
  ["a marker inside prose", "Notes mention <!-- chunking: entries --> inline."],
  ["a fenced example", "Example:\n\n```md\n<!-- chunking: entries -->\n```"],
  ["an indented code example", "Example:\n\n    <!-- chunking: entries -->\n"],
])("keeps %s in the indexed text", (_label, line) => {
  const content = [line, ...topicBullets].join("\n");
  expect(topicChunks(content).map((chunk) => chunk.text)).toEqual([content]);
});

it("does not honor the marker outside memory/ topic files", () => {
  const content = ["<!-- chunking: entries -->", ...topicBullets].join("\n");
  expect(topicChunks(content, "notes/alice.md").map((chunk) => chunk.text)).toEqual([content]);
});

it("keeps source lines for a chunking comment that is not a marker line", () => {
  const { chunks } = prepare(
    ["- Global.", "<!--", "chunking: entries -->", "- Scoped. <!-- project: alpha -->"].join("\n"),
  );
  expect(chunks.at(-1)).toMatchObject({
    text: "- Scoped.",
    startLine: 4,
    endLine: 4,
    projectKey: "alpha",
  });
});

it("leaves recall metadata eligibility to the path classification", () => {
  const chunks = topicChunks(
    [
      "<!-- chunking: entries -->",
      "- Scoped fact. <!-- project: alpha-key -->",
      "- Triggered fact. <!-- trigger: deploy --> <!-- importance: 9 -->",
    ].join("\n"),
  );
  // Same as an unmarked topic file: project scope applies, triggers and importance do not.
  expect(chunks).toMatchObject([
    { text: "- Scoped fact.", projectKey: "alpha-key", triggers: null, importance: null },
    { text: "- Triggered fact.", projectKey: null, triggers: null, importance: null },
  ]);
});

it("keeps list-fenced marker examples and honors a marker after a dedented list", () => {
  const example = "- ```md\n  <!-- chunking: entries -->\n  ```";
  const content = [example, ...topicBullets].join("\n");
  expect(topicChunks(content).map((chunk) => chunk.text)).toEqual([content]);
  const afterList = "- Example:\n  ```md\n  sample\n\n<!-- chunking: entries -->";
  const chunks = topicChunks([afterList, ...topicBullets].join("\n"));
  expect(chunks.some((chunk) => chunk.text === topicBullets[1])).toBe(true);
  expect(chunks.map((chunk) => chunk.text).join("\n")).not.toContain("<!-- chunking:");
});
