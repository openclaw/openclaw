// Web Readability tests cover web content extractor plugin behavior.
import { describe, expect, it } from "vitest";
import {
  createReadabilityWebContentExtractor,
  exceedsEstimatedHtmlNestingDepth,
} from "./web-content-extractor.js";

const SAMPLE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Example Article</title>
  </head>
  <body>
    <nav>
      <ul>
        <li><a href="/home">Home</a></li>
        <li><a href="/about">About</a></li>
      </ul>
    </nav>
    <main>
      <article>
        <h1>Example Article</h1>
        <p>Main content starts here with enough words to satisfy readability.</p>
        <p>Second paragraph for a bit more signal.</p>
        <p><a href="../next">Continue reading</a></p>
      </article>
    </main>
    <footer>Footer text</footer>
  </body>
</html>`;

type ReadabilityResult = Awaited<
  ReturnType<ReturnType<typeof createReadabilityWebContentExtractor>["extract"]>
>;

function requireReadabilityResult(result: ReadabilityResult): NonNullable<ReadabilityResult> {
  if (!result) {
    throw new Error("expected readability extraction result");
  }
  return result;
}

async function extractMarkdown(html: string) {
  return createReadabilityWebContentExtractor().extract({
    html,
    url: "https://example.com/article",
    extractMode: "markdown",
  });
}

describe("web readability extractor", () => {
  it("extracts readable text", async () => {
    const extractor = createReadabilityWebContentExtractor();
    const result = await extractor.extract({
      html: SAMPLE_HTML,
      url: "https://example.com/article",
      extractMode: "text",
    });
    const extracted = requireReadabilityResult(result);
    expect(extracted.text).toContain("Main content starts here");
    expect(extracted.title).toBe("Example Article");
  });

  it("extracts readable markdown", async () => {
    const extractor = createReadabilityWebContentExtractor();
    const result = await extractor.extract({
      html: SAMPLE_HTML,
      url: "https://example.com/article",
      extractMode: "markdown",
    });
    const extracted = requireReadabilityResult(result);
    expect(extracted.text).toContain("Main content starts here");
    expect(extracted.text).toContain("[Continue reading](https://example.com/next)");
    expect(extracted.title).toBe("Example Article");
  });

  it("does not count void tags toward the nesting limit", async () => {
    const html = SAMPLE_HTML.replace("<article>", `<article>${"<BR>".repeat(3100)}`);
    const result = await extractMarkdown(html);
    expect(requireReadabilityResult(result).text).toContain("Main content starts here");
  });

  it("does not count pseudo tags inside raw-text elements toward the nesting limit", async () => {
    const pseudoTags = "<div>".repeat(3100);
    const html = SAMPLE_HTML.replace(
      "<article>",
      `<article><script>const template = ${JSON.stringify(pseudoTags)};</script>`,
    );
    const result = await extractMarkdown(html);
    expect(requireReadabilityResult(result).text).toContain("Main content starts here");
  });

  it("handles quoted raw-text attributes while skipping pseudo tags", async () => {
    const pseudoTags = "<div>".repeat(3100);
    const html = SAMPLE_HTML.replace(
      "<article>",
      `<article><script data-close="/>">const template = ${JSON.stringify(pseudoTags)};</script>`,
    );
    const result = await extractMarkdown(html);
    expect(requireReadabilityResult(result).text).toContain("Main content starts here");
  });

  it("does not count pseudo tags after a raw-text start tag that reaches EOF", async () => {
    const pseudoTags = "<div>".repeat(3100);
    const html = SAMPLE_HTML.replace("</article>", `</article><script>${pseudoTags}`);
    const result = await extractMarkdown(html);
    expect(requireReadabilityResult(result).text).toContain("Main content starts here");
  });

  it("does not count pseudo tags after plaintext starts", async () => {
    const pseudoTags = "<div>".repeat(3100);
    const html = SAMPLE_HTML.replace("</article>", `</article><plaintext>${pseudoTags}`);
    const result = await extractMarkdown(html);
    expect(requireReadabilityResult(result).text).toContain("Main content starts here");
  });

  it("does not count pseudo tags inside legacy raw-text content", async () => {
    const pseudoTags = "<div ".repeat(3100);
    for (const tagName of ["noembed", "noframes"]) {
      const html = SAMPLE_HTML.replace(
        "<article>",
        `<article><${tagName}>${pseudoTags}</${tagName}>`,
      );
      const result = await extractMarkdown(html);
      expect(requireReadabilityResult(result).text).toContain("Main content starts here");
    }
  });

  it("bounds malformed apparent start-tag scanning", async () => {
    const html = `<main>${"<a".repeat(50_000)}</main>`;
    const result = await extractMarkdown(html);
    expect(result).toBeNull();
  });

  it("counts deeply nested valid tags with long attributes", () => {
    const attr = "x".repeat(210);
    const html = Array.from({ length: 6 }, () => `<div data-long="${attr}">`).join("");
    expect(exceedsEstimatedHtmlNestingDepth(html, 5)).toBe(true);
  });
});
