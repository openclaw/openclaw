import type { Entry } from "./update-clawtributors.types.js";

type RenderableEntry = Pick<Entry, "avatar_url" | "display" | "html_url">;
type ParsedEntry = Pick<Entry, "avatar_url" | "display" | "html_url">;

export function renderClawtributorRows(
  entries: readonly RenderableEntry[],
  perLine: number,
): string[] {
  const rows: string[] = [];
  for (let i = 0; i < entries.length; i += perLine) {
    rows.push(
      entries
        .slice(i, i + perLine)
        .map(renderClawtributorEntry)
        .join(" "),
    );
  }
  return rows;
}

export function renderClawtributorEntry(entry: RenderableEntry): string {
  return `[<img src="${escapeHtmlAttribute(entry.avatar_url)}" alt="${escapeHtmlAttribute(entry.display)}" width="48">](${entry.html_url})`;
}

export function parseClawtributorEntries(content: string): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  const markdown = /\[!\[(.*?)\]\((.*?)\)\]\((.*?)\)/g;
  for (const match of content.matchAll(markdown)) {
    const [, alt, src, href] = match;
    if (!href || !src || !alt) {
      continue;
    }
    entries.push({
      html_url: href,
      avatar_url: src,
      display: alt.replace(/\\([\\[\]])/g, "$1"),
    });
  }

  const markdownHtmlImage = /\[<img\b([^>]*)>\]\((.*?)\)/g;
  for (const match of content.matchAll(markdownHtmlImage)) {
    const [, attributes, href] = match;
    const src = readHtmlAttribute(`<img${attributes}>`, "src");
    const alt = readHtmlAttribute(`<img${attributes}>`, "alt");
    if (!href || !src || !alt) {
      continue;
    }
    entries.push({ html_url: href, avatar_url: src, display: alt });
  }

  const linked = /<a\b[^>]*>\s*<img\b[^>]*>\s*<\/a>/g;
  for (const match of content.matchAll(linked)) {
    const anchor = match[0];
    const href = readHtmlAttribute(anchor, "href");
    const src = readHtmlAttribute(anchor, "src");
    const alt = readHtmlAttribute(anchor, "alt");
    if (!href || !src || !alt) {
      continue;
    }
    entries.push({ html_url: href, avatar_url: src, display: alt });
  }

  const standalone = /<img\b[^>]*>/g;
  for (const match of content.matchAll(standalone)) {
    const img = match[0];
    const src = readHtmlAttribute(img, "src");
    const alt = readHtmlAttribute(img, "alt");
    if (!src || !alt) {
      continue;
    }
    if (entries.some((entry) => entry.display === alt && entry.avatar_url === src)) {
      continue;
    }
    entries.push({ html_url: fallbackHref(alt), avatar_url: src, display: alt });
  }
  return entries;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function readHtmlAttribute(tag: string, name: string): string | null {
  const match = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i").exec(tag);
  return match?.[1] ? unescapeHtmlAttribute(match[1]) : null;
}

function unescapeHtmlAttribute(value: string): string {
  return value
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function fallbackHref(value: string): string {
  const encoded = encodeURIComponent(value.trim());
  return encoded ? `https://github.com/search?q=${encoded}` : "https://github.com";
}
