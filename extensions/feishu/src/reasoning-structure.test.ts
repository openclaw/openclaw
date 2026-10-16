// Feishu tests cover how delivered reasoning keeps fenced samples out of its italic styling.
import { describe, expect, it } from "vitest";
import { formatReasoningPreservingStructure } from "./reasoning-structure.js";

describe("formatReasoningPreservingStructure fences", () => {
  // Only the character that opened a fence closes it, and only at the same length or
  // longer, so every line between the markers below is sample text and stays as written.
  it.each([
    { shape: "a backtick fence holding a tilde line", fence: "```\n~~~\nplain sample\n```" },
    { shape: "a tilde fence holding a backtick line", fence: "~~~\n```\nplain sample\n~~~" },
    { shape: "a long tilde fence holding a short one", fence: "~~~~\n~~~\nplain sample\n~~~~" },
    { shape: "a long backtick fence holding a short one", fence: "````\n```\nplain sample\n````" },
    { shape: "a tilde fence closed by a longer marker", fence: "~~~\nplain sample\n~~~~~" },
    { shape: "a fence behind a quote", fence: "> ~~~\n> plain sample\n> ~~~" },
    { shape: "a fence that was never closed", fence: "~~~\nplain sample" },
    { shape: "a fence an info line does not close", fence: "```\n```js\nplain sample\n```" },
    { shape: "a fence opened behind a list marker", fence: "- ~~~\n  plain sample\n  ~~~" },
    {
      shape: "an indented sample holding fence markers",
      fence: "    ```\n    plain sample\n    ```",
    },
    { shape: "an indented sample", fence: "    plain sample\n    more sample" },
  ])("leaves $shape as written", ({ fence }) => {
    expect(formatReasoningPreservingStructure(`Checking.\n\n${fence}`)).toBe(
      `Thinking\n\n_Checking._\n\n${fence}`,
    );
  });

  // The formatter reads the trimmed text, and a lone carriage return is a line ending to the
  // parser but not to the split, so the lines must still line up in both cases.
  it.each([
    { shape: "leading blank lines", text: "\n\nChecking.\n\n~~~\nplain sample\n~~~" },
    {
      shape: "a lone carriage return",
      text: "Checking.\rStill checking.\n\n```\nplain sample\n```",
    },
  ])("keeps the markers after $shape", ({ text }) => {
    const [prose, ...fence] = text.trim().split("\n\n");
    expect(formatReasoningPreservingStructure(text)).toBe(
      `Thinking\n\n_${prose}_\n\n${fence.join("\n\n")}`,
    );
  });

  // Table conversion and routing read Markdown with HTML off, where a tag line is plain text and
  // cannot take the fence after it. Only the tag lines are prose here.
  it.each(["```", "~~~"])("keeps a %s fence that follows an HTML tag line", (fence) => {
    expect(
      formatReasoningPreservingStructure(`<div>\n${fence}\nplain sample\n${fence}\n</div>`),
    ).toBe(`Thinking\n\n_<div>_\n${fence}\nplain sample\n${fence}\n_</div>_`);
  });

  // A quote that starts beside a fenced list item ends the fence nothing closed. The parser puts
  // the end of that block at the start of the quote's line, which is prose.
  it("italicises a quote that ends an unclosed fence in a list item", () => {
    expect(formatReasoningPreservingStructure("- ~~~\n  plain sample\n> Back to prose.")).toBe(
      "Thinking\n\n- ~~~\n  plain sample\n_> Back to prose._",
    );
  });

  // Every marker here follows a lone carriage return, so no line the split sees starts with one.
  it("finds a fence whose markers all follow a lone carriage return", () => {
    expect(formatReasoningPreservingStructure("Checking.\r~~~\nplain sample\r~~~")).toContain(
      "\nplain sample\r~~~",
    );
  });

  it("italicises the prose after a tilde fence closes", () => {
    expect(formatReasoningPreservingStructure("~~~\nplain sample\n~~~\nBack to prose.")).toBe(
      "Thinking\n\n~~~\nplain sample\n~~~\n_Back to prose._",
    );
  });
});
