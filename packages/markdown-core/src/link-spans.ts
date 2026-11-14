import { fromMarkdown } from "mdast-util-from-markdown";

type PositionedMarkdownNode = {
  type: string;
  position?: { start?: { offset?: number }; end?: { offset?: number } };
  children?: PositionedMarkdownNode[];
};

/** Returns parser-owned source spans for links, images, and reference definitions. */
export function findMarkdownLinkSourceSpans(
  markdown: string,
  options: { html?: boolean } = {},
): Array<{ start: number; end: number; definition: boolean }> {
  const spans: Array<{ start: number; end: number; definition: boolean }> = [];
  const tree: PositionedMarkdownNode = fromMarkdown(markdown, {
    extensions: options.html === false ? [{ disable: { null: ["htmlFlow", "htmlText"] } }] : [],
  });
  const pending = [tree];

  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) {
      continue;
    }
    if (["link", "image", "linkReference", "imageReference", "definition"].includes(node.type)) {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (start !== undefined && end !== undefined) {
        spans.push({ start, end, definition: node.type === "definition" });
      }
      // The outer link owns nested image source, so overlapping spans are not useful to callers.
      continue;
    }
    for (const child of node.children ?? []) {
      pending.push(child);
    }
  }

  return spans.toSorted((left, right) => left.start - right.start);
}
