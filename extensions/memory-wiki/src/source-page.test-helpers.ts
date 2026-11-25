import { fromMarkdown } from "mdast-util-from-markdown";
import { expect } from "vitest";
import { parseWikiMarkdown } from "./markdown.js";
import { renderImportedSourcePage } from "./source-page-shared.js";

export function buildSourcePage(raw: string, updatedAt: string): string {
  const title = "imported *source* #";
  const rendered = renderImportedSourcePage({
    frontmatter: {
      pageType: "source",
      id: "source.imported",
      title,
      sourceType: "memory-unsafe-local",
      status: "active",
      updatedAt,
    },
    sourceHeading: "Local Source",
    sourceDetails: [],
    content: raw,
    language: "text",
  });
  const heading = fromMarkdown(parseWikiMarkdown(rendered).body).children[0];
  expect(heading).toMatchObject({ type: "heading", depth: 1, children: [{ value: title }] });
  return rendered;
}
