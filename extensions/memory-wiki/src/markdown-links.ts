import path from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";

export const WIKI_RELATED_START_MARKER = "<!-- openclaw:wiki:related:start -->";
export const WIKI_RELATED_END_MARKER = "<!-- openclaw:wiki:related:end -->";

const OBSIDIAN_LINK_PATTERN = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
const RELATED_BLOCK_PATTERN = new RegExp(
  `${WIKI_RELATED_START_MARKER}[\\s\\S]*?${WIKI_RELATED_END_MARKER}`,
  "g",
);

function normalizeMarkdownLinkTarget(sourceRelativePath: string, target: string): string {
  return path.posix.normalize(path.posix.join(path.posix.dirname(sourceRelativePath), target));
}

type MarkdownAstNode = {
  type?: string;
  url?: string;
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
  children?: MarkdownAstNode[];
};

function forEachCodeRange(
  tree: MarkdownAstNode,
  visitRange: (start: number, end: number) => void,
): void {
  const visit = (node: MarkdownAstNode): void => {
    if (node.type === "code" || node.type === "inlineCode") {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (start !== undefined && end !== undefined) {
        visitRange(start, end);
      }
      return;
    }
    for (const child of node.children ?? []) {
      visit(child);
    }
  };
  visit(tree);
}

export function forEachMarkdownCodeRange(
  markdown: string,
  visitRange: (start: number, end: number) => void,
): void {
  forEachCodeRange(fromMarkdown(markdown), visitRange);
}

export function maskMarkdownCode(markdown: string, keepUnclosedFences = false): string {
  // An extra heading exposes fences that would swallow a local Notes slot.
  const source = keepUnclosedFences ? `${markdown}\n\n#` : markdown;
  return maskMarkdownCodeFromTree(markdown, fromMarkdown(source));
}

function maskMarkdownCodeFromTree(markdown: string, tree: MarkdownAstNode): string {
  const masked = markdown.split("");
  forEachCodeRange(tree, (start, end) => {
    if (end > markdown.length) {
      return;
    }
    for (let index = start; index < end; index++) {
      if (masked[index] !== "\n" && masked[index] !== "\r") {
        masked[index] = " ";
      }
    }
  });
  return masked.join("");
}

export function extractWikiLinks(markdown: string, sourceRelativePath: string): string[] {
  // Masking cannot add brackets, and both supported link forms require one.
  if (!markdown.includes("[")) {
    return [];
  }
  const withoutRelatedBlock = markdown.replace(RELATED_BLOCK_PATTERN, "");
  const tree = fromMarkdown(withoutRelatedBlock);
  const searchable = maskMarkdownCodeFromTree(withoutRelatedBlock, tree);
  const links: string[] = [];
  for (const match of searchable.matchAll(OBSIDIAN_LINK_PATTERN)) {
    const target = match[1]?.trim();
    if (target) {
      links.push(target);
    }
  }
  const visit = (node: MarkdownAstNode): void => {
    // Reference links remain outside the wiki's supported inline-link syntax.
    if (node.type === "link" || node.type === "image") {
      const rawTarget = node.url?.trim();
      if (rawTarget && !rawTarget.startsWith("#") && !/^[a-z]+:/i.test(rawTarget)) {
        const target = rawTarget.split("#")[0]?.split("?")[0]?.replace(/\\/g, "/").trim();
        if (target) {
          links.push(normalizeMarkdownLinkTarget(sourceRelativePath, target));
        }
      }
    }
    for (const child of node.children ?? []) {
      visit(child);
    }
  };
  visit(tree);
  return links;
}
