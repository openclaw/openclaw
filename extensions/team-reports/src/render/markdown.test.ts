import { JSDOM } from "jsdom";
import { marked } from "marked";
import { expect, it } from "vitest";
import { githubItem, reportDocument, reportMember } from "../reports-data.test-support.js";
import { githubCounts } from "../reports.fixtures.js";
import type { SummaryDocument } from "../types.js";
import { renderMarkdown } from "./markdown.js";

it("preserves literal report metadata while keeping overview Markdown and link destinations", () => {
  const display = "Alice &amp; <team>";
  const title = "Document &copy; and &#169; with <tags> & plain text";
  const excerpt = "Keep &lt;name&gt; and a > b literal";
  const warning = "Missing &copy; <coverage>";
  const highlight = "Highlight &amp; <work>";
  const url = "https://github.com/sample/project/pull/1?view=files&plain=1";
  const report = reportDocument([
    reportMember("alice", {
      display,
      github: { ...githubCounts(1), items: [githubItem({ title, url })] },
      discord: {
        total: 1,
        channels: { planning: 1 },
        excerpts: [{ channel: "planning", atMs: 1, excerpt }],
      },
    }),
  ]);
  report.sources.github.warnings = [warning];
  const summary: SummaryDocument = {
    source: "model",
    generatedAtMs: 1,
    fingerprint: "fixture",
    globalSummary: "**Overview** with intentional Markdown.",
    highlights: [highlight],
  };

  const document = new JSDOM(marked.parse(renderMarkdown(report, summary), { async: false })).window
    .document;

  expect(document.querySelector("h3")?.textContent).toBe(`${display} (@alice)`);
  expect(document.querySelector("a")?.textContent).toBe(title);
  expect(document.querySelector("a")?.href).toBe(url);
  for (const text of [excerpt, warning, highlight]) {
    expect(document.body.textContent).toContain(text);
  }
  expect(document.querySelector("strong")?.textContent).toBe("Overview");
  expect(document.querySelector("tags")).toBeNull();
});
