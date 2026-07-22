import { describe, expect, it } from "vitest";
import { extractCleanTextCore } from "./sandboxed-fetch-extract.js";

describe("extractCleanTextCore", () => {
  it("strips script/style/nav/header/footer and keeps real content", () => {
    const html = `<html><head><script>evil()</script><style>.x{color:red}</style></head>
<body><nav>Home | About</nav>
<header>Site Header</header>
<article><h1>Real Title</h1><p>This is the &amp; real content with a &quot;quote&quot;.</p></article>
<footer>Copyright 2026</footer>
</body></html>`;
    const text = extractCleanTextCore(html, 1000);
    expect(text).not.toContain("evil()");
    expect(text).not.toContain("Home | About");
    expect(text).not.toContain("Copyright");
    expect(text).toContain("Real Title");
    expect(text).toContain('real content with a "quote"');
  });

  it("truncates long content with a marker", () => {
    const longHtml = `<p>${"x".repeat(2000)}</p>`;
    const truncated = extractCleanTextCore(longHtml, 100);
    expect(truncated.length).toBeLessThanOrEqual(120);
    expect(truncated.endsWith("[truncated]")).toBe(true);
  });

  it("decodes a single level of entity escaping without cascading", () => {
    expect(decodeEntitiesTestHelper("&amp;amp;lt;")).toBe("&amp;lt;");
    expect(decodeEntitiesTestHelper("&amp;lt;")).toBe("&lt;");
    expect(decodeEntitiesTestHelper("Tom &amp; Jerry")).toBe("Tom & Jerry");
    expect(decodeEntitiesTestHelper("&#39;hi&#39;")).toBe("'hi'");
  });

  it("strips an unclosed script tag's body instead of leaking it", () => {
    const html = '<script>evil()<p>Real content</p>';
    const text = extractCleanTextCore(html, 1000);
    expect(text).not.toContain("evil()");
  });

  function decodeEntitiesTestHelper(input: string): string {
    // extractCleanTextCore always strips tags first; wrap input so the
    // entity-decode assertion is unaffected by tag stripping.
    return extractCleanTextCore(input, 1000);
  }
});
