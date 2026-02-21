import { describe, expect, it } from "vitest";
import { markdownToMatrixHtml } from "./format.js";

describe("markdownToMatrixHtml", () => {
  it("renders basic inline formatting", () => {
    const html = markdownToMatrixHtml("hi _there_ **boss** `code`");
    expect(html).toContain("<em>there</em>");
    expect(html).toContain("<strong>boss</strong>");
    expect(html).toContain("<code>code</code>");
  });

  it("renders links as HTML", () => {
    const html = markdownToMatrixHtml("see [docs](https://example.com)");
    expect(html).toContain('<a href="https://example.com">docs</a>');
  });

  it("escapes raw HTML", () => {
    const html = markdownToMatrixHtml("<b>nope</b>");
    expect(html).toContain("&lt;b&gt;nope&lt;/b&gt;");
    expect(html).not.toContain("<b>nope</b>");
  });

  it("flattens images into alt text", () => {
    const html = markdownToMatrixHtml("![alt](https://example.com/img.png)");
    expect(html).toContain("alt");
    expect(html).not.toContain("<img");
  });

  it("preserves line breaks", () => {
    const html = markdownToMatrixHtml("line1\nline2");
    expect(html).toContain("<br");
  });

  describe("LaTeX/Math rendering (data-mx-maths)", () => {
    it("converts display math $$...$$ to block form when standalone", () => {
      const html = markdownToMatrixHtml("$$x^2 + y^2 = z^2$$");
      expect(html).toContain('<div data-mx-maths="x^2 + y^2 = z^2">');
      expect(html).toContain("<code>x^2 + y^2 = z^2</code>");
    });

    it("falls back to inline maths when display delimiters are embedded in a sentence", () => {
      const html = markdownToMatrixHtml("Here is math: $$x^2 + y^2 = z^2$$");
      expect(html).toContain('<span data-mx-maths="x^2 + y^2 = z^2">');
    });

    it("converts inline math $...$", () => {
      const html = markdownToMatrixHtml("The equation $x = 1$ is true.");
      expect(html).toContain('<span data-mx-maths="x = 1">');
      expect(html).toContain("<code>x = 1</code>");
    });

    it("handles multiple inline math expressions", () => {
      const html = markdownToMatrixHtml("We have $a$ and $b$ and $c$.");
      expect(html).toContain('data-mx-maths="a"');
      expect(html).toContain('data-mx-maths="b"');
      expect(html).toContain('data-mx-maths="c"');
    });

    it("converts LaTeX display environment \\[...\\]", () => {
      const html = markdownToMatrixHtml("\\[x^2 + 1\\]");
      expect(html).toContain('<div data-mx-maths="x^2 + 1">');
    });

    it("converts LaTeX inline environment \\(...\\)", () => {
      const html = markdownToMatrixHtml("We have \\(x = 1\\) here.");
      expect(html).toContain('<span data-mx-maths="x = 1">');
    });

    it("preserves LaTeX in code blocks (does not convert)", () => {
      const html = markdownToMatrixHtml("Code: `$$x^2$$`");
      // Math-like syntax inside code spans should stay literal code, never converted to data-mx-maths.
      expect(html).toContain("<code>$$x^2$$</code>");
      expect(html).not.toContain('data-mx-maths=');
    });

    it("renders pure display math as a block div", () => {
      const html = markdownToMatrixHtml("$$x^2$$");
      expect(html).toBe('<div data-mx-maths="x^2"><code>x^2</code></div>');
    });

    it("strips whitespace from LaTeX content", () => {
      const html = markdownToMatrixHtml("Math: $  x^2  $");
      expect(html).toContain('data-mx-maths="x^2"');
    });
  });
});
