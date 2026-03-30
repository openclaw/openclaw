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

	it("does not auto-link bare file references into external urls", () => {
		const html = markdownToMatrixHtml("Check README.md and backup.sh");
		expect(html).toContain("README.md");
		expect(html).toContain("backup.sh");
		expect(html).not.toContain('href="http://README.md"');
		expect(html).not.toContain('href="http://backup.sh"');
	});

	it("keeps real domains linked even when path segments look like filenames", () => {
		const html = markdownToMatrixHtml("See https://docs.example.com/backup.sh");
		expect(html).toContain('href="https://docs.example.com/backup.sh"');
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
});
