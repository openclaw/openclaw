// Web Readability tests cover web content extractor plugin behavior.
import { describe, expect, it } from "vitest";
import { createReadabilityWebContentExtractor } from "./web-content-extractor.js";

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

  it.each(["text", "markdown"] as const)(
    "excludes double-escaped script prose in %s mode",
    async (extractMode) => {
      const extractor = createReadabilityWebContentExtractor();
      const result = await extractor.extract({
        html: `<!doctype html><html><head><title>Cloud Costs</title></head><body><article>
<script><!--<script></script><p>Secret script paragraph. These words belong only to script data, and they must never become the article text returned to the reader. The paragraph has ordinary prose and no links or unusual attributes.</p>--></script>
<p>Visible sibling. Cloud costs depend on the services a team uses, the amount of data it stores, and the traffic its customers generate. A useful review starts with the current bill and compares each service with the work it supports. Teams can then remove unused resources, select suitable instance sizes, and set budgets for expected growth. Regular reviews make these decisions easier because each change has a clear purpose and a measured result. This visible article paragraph must remain available after extraction.</p>
</article></body></html>`,
        url: "https://example.com/article",
        extractMode,
      });
      const extracted = requireReadabilityResult(result);
      expect(extracted.text).toContain("Visible sibling");
      expect(extracted.text).not.toContain("Secret script paragraph");
      expect(extracted.title).toBe("Cloud Costs");
    },
  );

  it.each(["text", "markdown"] as const)(
    "does not join script delimiters across comments in %s mode",
    async (extractMode) => {
      const extractor = createReadabilityWebContentExtractor();
      const result = await extractor.extract({
        html: SAMPLE_HTML.replace(
          "<article>",
          "<article><script></scr<!-- -->ipt><p>Secret script paragraph. This prose belongs to script data and must remain excluded from extracted article text.</p></script>",
        ),
        url: "https://example.com/article",
        extractMode,
      });
      const extracted = requireReadabilityResult(result);
      expect(extracted.text).toContain("Main content starts here");
      expect(extracted.text).not.toContain("Secret script paragraph");
      expect(extracted.title).toBe("Example Article");
    },
  );

  it("preserves visible content after a quoted script closer", async () => {
    const extractor = createReadabilityWebContentExtractor();
    const result = await extractor.extract({
      html: SAMPLE_HTML.replace("<article>", '<article><script>x</script data-note="<!--">'),
      url: "https://example.com/article",
      extractMode: "text",
    });
    const extracted = requireReadabilityResult(result);
    expect(extracted.text).toContain("Main content starts here");
    expect(extracted.title).toBe("Example Article");
  });

  it("preserves JSON-LD article titles while filtering script text", async () => {
    const extractor = createReadabilityWebContentExtractor();
    const result = await extractor.extract({
      html: `<!doctype html><html><head><title>Site home</title><script type="application/ld+json">{"@context": "https://schema.org", "@type": "Article", "headline": "Cloud Spending Review"}</script></head><body><article><p>Visible sibling. Cloud costs depend on the services a team uses, the amount of data it stores, and the traffic its customers generate. A useful review starts with the current bill and compares each service with the work it supports. Teams can then remove unused resources, select suitable instance sizes, and set budgets for expected growth. Regular reviews make these decisions easier because each change has a clear purpose and a measured result. This visible article paragraph must remain available after extraction.</p>
</article></body></html>`,
      url: "https://example.com/article",
      extractMode: "text",
    });
    const extracted = requireReadabilityResult(result);
    expect(extracted.text).toContain("Visible sibling");
    expect(extracted.title).toBe("Cloud Spending Review");
  });

  it("does not count void tags toward the nesting limit", async () => {
    const extractor = createReadabilityWebContentExtractor();
    const html = SAMPLE_HTML.replace("<article>", `<article>${"<BR>".repeat(3100)}`);
    const result = await extractor.extract({
      html,
      url: "https://example.com/article",
      extractMode: "markdown",
    });
    expect(requireReadabilityResult(result).text).toContain("Main content starts here");
  });

  it("rejects excessively nested HTML before extraction", async () => {
    const extractor = createReadabilityWebContentExtractor();
    const result = await extractor.extract({
      html: `${"<section>".repeat(3001)}${SAMPLE_HTML}${"</section>".repeat(3001)}`,
      url: "https://example.com/article",
      extractMode: "text",
    });
    expect(result).toBeNull();
  });
});
