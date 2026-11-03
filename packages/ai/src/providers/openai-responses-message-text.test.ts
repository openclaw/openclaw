import MarkdownIt from "markdown-it";
import { expect, it } from "vitest";
import { renderResponsesMessageText } from "./openai-responses-message-text.js";

it("renders safe clickable sources once across message parts while preserving provider text", () => {
  const cite = (url: string, title?: string) => ({ type: "url_citation", url, title });
  expect(
    renderResponsesMessageText([
      {
        type: "output_text",
        text: "Answer.",
        annotations: [
          cite("https://example.test/a(b)", "[Source]\\\nnext"),
          cite("javascript:alert(1)", "unsafe"),
          cite("not a URL"),
          { type: "file_citation", url: "https://example.test/file" },
        ],
      },
      {
        type: "output_text",
        text: " More.",
        annotations: [
          cite("https://example.test/a(b)", "duplicate"),
          cite("https://other.test/source"),
        ],
      },
      { type: "refusal", refusal: " Declined." },
      null,
    ]).text,
  ).toBe(
    "Answer. More. Declined.\n\n[\\[Source\\]\\\\ next](https://example.test/a%28b%29) [other\\.test](https://other.test/source)",
  );
});

it("leaves ordinary OpenAI and Azure text and refusal bytes unchanged", () => {
  expect(
    renderResponsesMessageText([
      { type: "output_text", text: "a\n", annotations: [] },
      { type: "text", text: " b" },
      { type: "refusal", refusal: "!" },
    ]).text,
  ).toBe("a\n b!");
});

it.each(["```", "~~~"])("keeps citation Markdown clickable after a closing %s fence", (fence) => {
  const rendered = renderResponsesMessageText([
    {
      type: "output_text",
      text: `${fence}\nconst answer = 42;\n${fence}`,
      annotations: [{ type: "url_citation", url: "https://example.test/source", title: "Source" }],
    },
  ]);
  expect(new MarkdownIt().render(rendered.text)).toBe(
    '<pre><code>const answer = 42;\n</code></pre>\n<p><a href="https://example.test/source">Source</a></p>\n',
  );
});
