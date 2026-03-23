import { describe, expect, it } from "vitest";
import { __testing } from "./ddg-client.js";

describe("duckduckgo html parsing", () => {
  it("decodes direct and redirect urls", () => {
    expect(
      __testing.decodeDuckDuckGoUrl(
        "https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fsearch%3Fq%3Dclaw",
      ),
    ).toBe("https://example.com/search?q=claw");
    expect(__testing.decodeDuckDuckGoUrl("https://example.com")).toBe("https://example.com");
  });

  it("decodes common html entities", () => {
    expect(__testing.decodeHtmlEntities("Fish &amp; Chips&nbsp;&hellip; &#39;ok&#39;")).toBe(
      "Fish & Chips ... 'ok'",
    );
  });

  it("parses results when href appears before class", () => {
    const html = `
      <a href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com" class="result__a">
        Example &amp; Co
      </a>
      <a class="result__snippet">Fast&nbsp;search &hellip; with details</a>
      <a class="result__a" href="https://example.org/direct">Direct result</a>
      <a class="result__snippet">Second snippet</a>
    `;

    expect(__testing.parseDuckDuckGoHtml(html)).toEqual([
      {
        title: "Example & Co",
        url: "https://example.com",
        snippet: "Fast search ... with details",
      },
      {
        title: "Direct result",
        url: "https://example.org/direct",
        snippet: "Second snippet",
      },
    ]);
  });

  it("returns no results for bot challenge pages", () => {
    const html = `
      <html>
        <body>
          <form>
            <h1>Are you a human?</h1>
            <div class="g-recaptcha">captcha</div>
          </form>
        </body>
      </html>
    `;

    expect(__testing.isBotChallenge(html)).toBe(true);
    expect(__testing.parseDuckDuckGoHtml(html)).toEqual([]);
  });

  it("does not treat ordinary result snippets mentioning challenge as bot pages", () => {
    const html = `
      <a class="result__a" href="https://example.com/challenge">Coding Challenge</a>
      <a class="result__snippet">A fun coding challenge for interview prep.</a>
    `;

    expect(__testing.isBotChallenge(html)).toBe(false);
    expect(__testing.parseDuckDuckGoHtml(html)).toEqual([
      {
        title: "Coding Challenge",
        url: "https://example.com/challenge",
        snippet: "A fun coding challenge for interview prep.",
      },
    ]);
  });
});
