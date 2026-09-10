import { describe, expect, it } from "vitest";
import { countMarkdownFencedCodeChars } from "./ir.js";

describe("fenced code content length", () => {
  it.each([
    { name: "below half", text: "```\n1234567\n```", count: 7 },
    { name: "exactly half", text: "```\n12345678\n```", count: 8 },
    { name: "above half", text: "```\n123456789\n```", count: 9 },
    { name: "empty fence", text: "```\n```", count: 0 },
    { name: "one blank body line", text: "```\n\n```", count: 0 },
    { name: "two blank body lines", text: "```\n\n\n```", count: 1 },
    { name: "trailing code spaces", text: "```\nx  \n```", count: 3 },
    { name: "trailing code tab", text: "```\nx\t\n```", count: 2 },
    { name: "interior blank line", text: "```\nleft\n\nright\n```", count: 11 },
    { name: "CRLF body", text: "```\r\nleft\r\nright\r\n```", count: 10 },
    { name: "unterminated body", text: "```ts\nconst answer = 42;", count: 18 },
    { name: "unterminated empty fence", text: "```ts", count: 0 },
    { name: "longer closer", text: "```\nconst answer = 42;\n````", count: 18 },
    { name: "tilde fence", text: "~~~ts\nconst answer = 42;\n~~~", count: 18 },
    { name: "mismatched interior marker", text: "```\n~~~\nconst answer = 42;\n```", count: 22 },
    { name: "indented closer", text: "```\nconst answer = 42;\n   ```", count: 18 },
    { name: "quoted fence", text: "> ```\n> const answer = 42;\n> ```", count: 18 },
    {
      name: "two-level list fence",
      text: '- Outer\n  - Inner\n    ```\n    const detailedAnswer = "this body dominates the reply";\n    ```',
      count: 55,
    },
    {
      name: "tab terminated closer",
      text: "```\nx\n```\t\nThis prose follows the code fence and is much longer than it.",
      count: 1,
    },
    {
      name: "indented code excluded",
      text: "Ordinary paragraph.\n\n    const answer = 42;",
      count: 0,
    },
  ])("preserves body characters: $name", ({ text, count }) => {
    expect(countMarkdownFencedCodeChars(text)).toBe(count);
  });
});
