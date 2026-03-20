import { describe, expect, it } from "vitest";
import { __testing } from "./ddg-client.js";

const { parseDdgLiteHtml } = __testing;

describe("parseDdgLiteHtml", () => {
  it("parses a typical DuckDuckGo Lite response", () => {
    const html = `
      <html>
      <body>
        <table>
          <tr>
            <td>
              <a rel="nofollow" href="https://example.com/page1" class="result-link">Example Page One</a>
            </td>
          </tr>
          <tr>
            <td class="result-snippet">This is the first result snippet with some content.</td>
          </tr>
          <tr>
            <td>
              <a rel="nofollow" href="https://example.com/page2" class="result-link">Example Page Two</a>
            </td>
          </tr>
          <tr>
            <td class="result-snippet">Second result snippet here.</td>
          </tr>
        </table>
      </body>
      </html>
    `;

    const results = parseDdgLiteHtml(html);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: "Example Page One",
      url: "https://example.com/page1",
      snippet: "This is the first result snippet with some content.",
    });
    expect(results[1]).toEqual({
      title: "Example Page Two",
      url: "https://example.com/page2",
      snippet: "Second result snippet here.",
    });
  });

  it("handles HTML entities in URLs and titles", () => {
    const html = `
      <a rel="nofollow" href="https://example.com/search?q=hello&amp;lang=en" class="result-link">Hello &amp; World</a>
      <td class="result-snippet">Results for &quot;hello&quot; search.</td>
    `;

    const results = parseDdgLiteHtml(html);
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe("https://example.com/search?q=hello&lang=en");
    expect(results[0].title).toBe("Hello & World");
  });

  it("returns empty array for empty or no-result HTML", () => {
    expect(parseDdgLiteHtml("")).toEqual([]);
    expect(parseDdgLiteHtml("<html><body>No results</body></html>")).toEqual([]);
  });

  it("handles results with missing snippets gracefully", () => {
    const html = `
      <a rel="nofollow" href="https://example.com/a" class="result-link">Page A</a>
      <a rel="nofollow" href="https://example.com/b" class="result-link">Page B</a>
      <td class="result-snippet">Only one snippet available.</td>
    `;

    const results = parseDdgLiteHtml(html);
    expect(results).toHaveLength(2);
    expect(results[0].snippet).toBe("Only one snippet available.");
    expect(results[1].snippet).toBe("");
  });

  it("strips nested HTML tags from titles and snippets", () => {
    const html = `
      <a rel="nofollow" href="https://example.com" class="result-link"><b>Bold</b> Title</a>
      <td class="result-snippet">Some <b>bold</b> and <i>italic</i> text.</td>
    `;

    const results = parseDdgLiteHtml(html);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Bold Title");
    expect(results[0].snippet).toBe("Some bold and italic text.");
  });

  it("handles multiple results with all fields present", () => {
    const entries = Array.from({ length: 5 }, (_, i) => {
      const n = i + 1;
      return `
        <a rel="nofollow" href="https://site${n}.example.com/" class="result-link">Site ${n}</a>
        <td class="result-snippet">Description for site ${n}.</td>
      `;
    });
    const html = `<html><body>${entries.join("")}</body></html>`;

    const results = parseDdgLiteHtml(html);
    expect(results).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(results[i].title).toBe(`Site ${i + 1}`);
      expect(results[i].url).toBe(`https://site${i + 1}.example.com/`);
      expect(results[i].snippet).toBe(`Description for site ${i + 1}.`);
    }
  });
});
