import { describe, expect, it } from "vitest";
import { lintMarkdownCodeFences } from "./markdown-code-fence-lint.js";

describe("lintMarkdownCodeFences", () => {
  // ---------------------------------------------------------------------------
  // Already-correct content — no changes
  // ---------------------------------------------------------------------------

  it("leaves properly fenced TypeScript unchanged", () => {
    const md = "## Example\n\n```ts\nconst x = 1;\n```\n";
    const { fixed, changes } = lintMarkdownCodeFences(md);
    expect(fixed).toBe(md);
    expect(changes).toHaveLength(0);
  });

  it("leaves properly fenced shell unchanged", () => {
    const md = "```sh\n$ npm install\n```\n";
    const { fixed, changes } = lintMarkdownCodeFences(md);
    expect(fixed).toBe(md);
    expect(changes).toHaveLength(0);
  });

  it("leaves plain prose unchanged", () => {
    const md = "This is a sentence. Nothing to fence here.\n\nAnother paragraph.\n";
    const { fixed, changes } = lintMarkdownCodeFences(md);
    expect(fixed).toBe(md);
    expect(changes).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Missing language tag — infer and add
  // ---------------------------------------------------------------------------

  it("adds language tag to a fence with no language", () => {
    const md = "```\nconst x = require('foo');\n```\n";
    const { fixed, changes } = lintMarkdownCodeFences(md);
    expect(fixed).toMatch(/^```ts\n/);
    expect(changes).toHaveLength(1);
    expect(changes[0].description).toMatch(/Added missing language tag `ts`/);
  });

  it("adds 'sh' tag when fence contains a shell command", () => {
    const md = "```\nnpm install -g openclaw\n```\n";
    const { fixed, changes } = lintMarkdownCodeFences(md);
    expect(fixed).toMatch(/^```sh\n/);
    expect(changes[0].description).toMatch(/`sh`/);
  });

  it("adds 'python' tag for Python code", () => {
    const md = "```\ndef hello():\n    print('hi')\n```\n";
    const { fixed, changes } = lintMarkdownCodeFences(md);
    expect(fixed).toMatch(/^```python\n/);
  });

  it("adds 'json' tag for JSON content", () => {
    const md = '```\n{"key": "value"}\n```\n';
    const { fixed, changes } = lintMarkdownCodeFences(md);
    expect(fixed).toMatch(/^```json\n/);
  });

  // ---------------------------------------------------------------------------
  // Unfenced code detection
  // ---------------------------------------------------------------------------

  it("wraps unfenced shell command", () => {
    const md = "Run this:\n\n$ npm install openclaw\n\nDone.\n";
    const { fixed, changes } = lintMarkdownCodeFences(md);
    expect(fixed).toContain("```sh\n$ npm install openclaw\n```");
    expect(changes).toHaveLength(1);
    expect(changes[0].line).toBe(3);
  });

  it("wraps unfenced TypeScript", () => {
    const md = "Add this to your file:\n\nconst x = require('openclaw');\n\nThen restart.\n";
    const { fixed, changes } = lintMarkdownCodeFences(md);
    expect(fixed).toContain("```ts\nconst x = require('openclaw');\n```");
    expect(changes).toHaveLength(1);
  });

  it("wraps multiple consecutive unfenced code lines as one block", () => {
    const md = "import foo from 'bar';\nconst x = foo();\nexport default x;\n";
    const { fixed, changes } = lintMarkdownCodeFences(md);
    expect(fixed).toMatch(/^```ts\nimport foo/);
    expect(changes).toHaveLength(1);
    expect(changes[0].description).toMatch(/3 unfenced/);
  });

  // ---------------------------------------------------------------------------
  // Warn mode — no modification
  // ---------------------------------------------------------------------------

  it("warn mode reports changes but does not modify content", () => {
    const md = "```\nconst x = 1;\n```\n";
    const { fixed, changes } = lintMarkdownCodeFences(md, { mode: "warn" });
    expect(fixed).toBe(md); // unchanged
    expect(changes).toHaveLength(1);
    expect(changes[0].description).toMatch(/Added missing language tag/);
  });

  // ---------------------------------------------------------------------------
  // Code inside a fence is not double-fenced
  // ---------------------------------------------------------------------------

  it("does not modify code-looking lines already inside a fence", () => {
    const md = "```ts\nimport x from 'y';\nconst z = x();\n```\n";
    const { fixed, changes } = lintMarkdownCodeFences(md);
    expect(fixed).toBe(md);
    expect(changes).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Tilde fences
  // ---------------------------------------------------------------------------

  it("handles tilde fences (~~~) and adds language tag", () => {
    const md = "~~~\nnpm install\n~~~\n";
    const { fixed, changes } = lintMarkdownCodeFences(md);
    expect(fixed).toMatch(/^~~~sh\n/);
    expect(changes).toHaveLength(1);
  });
});
