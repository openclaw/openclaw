import type { Entry } from "./update-clawtributors.types.js";

export type RenderableClawtributorEntry = Pick<Entry, "display" | "html_url" | "avatar_url">;

export type RenderClawtributorsBlockOptions = {
  perLine: number;
  avatarSize: number;
  startMarker: string;
  endMarker: string;
};

export function renderClawtributorsBlock(
  entries: readonly RenderableClawtributorEntry[],
  options: RenderClawtributorsBlockOptions,
): string {
  const lines = renderClawtributorsLines(entries, options.perLine);
  const body = lines.length > 0 ? `\n\n${lines.join("\n")}\n` : "\n";
  const block = `${options.startMarker}${body}\n${options.endMarker}`;
  assertRenderedClawtributorCount(block, entries);
  return block;
}

export function renderClawtributorsLines(
  entries: readonly RenderableClawtributorEntry[],
  perLine: number,
): string[] {
  const lines: string[] = [];
  for (let i = 0; i < entries.length; i += perLine) {
    const chunk = entries.slice(i, i + perLine);
    const parts = chunk.map((entry) => renderClawtributorEntry(entry));
    lines.push(parts.join(" "));
  }
  return lines;
}

export function renderClawtributorEntry(entry: RenderableClawtributorEntry): string {
  return `[![${escapeMarkdownText(entry.display)}](${entry.avatar_url})](${entry.html_url})`;
}

export function parseRenderedClawtributorEntries(
  content: string,
  options: { markdown?: boolean } = {},
): Array<{ display: string; html_url: string; avatar_url: string }> {
  const entries: Array<{ display: string; html_url: string; avatar_url: string }> = [];

  const linked = /<a href="([^"]+)"><img src="([^"]+)"[^>]*alt="([^"]+)"[^>]*>/g;
  for (const match of content.matchAll(linked)) {
    const [, href, src, alt] = match;
    if (!href || !src || !alt) {
      continue;
    }
    entries.push({
      html_url: decodeHtmlAttribute(href),
      avatar_url: decodeHtmlAttribute(src),
      display: decodeHtmlAttribute(alt),
    });
  }

  const standalone = /<img src="([^"]+)"[^>]*alt="([^"]+)"[^>]*>/g;
  for (const match of content.matchAll(standalone)) {
    const [, src, alt] = match;
    if (!src || !alt) {
      continue;
    }
    const decodedSrc = decodeHtmlAttribute(src);
    const decodedAlt = decodeHtmlAttribute(alt);
    if (entries.some((entry) => entry.display === decodedAlt && entry.avatar_url === decodedSrc)) {
      continue;
    }
    entries.push({
      html_url: fallbackHref(decodedAlt),
      avatar_url: decodedSrc,
      display: decodedAlt,
    });
  }

  if (entries.length > 0 || options.markdown === false) {
    return entries;
  }

  const markdown = /\[!\[((?:\\.|[^\]])+)\]\(((?:\\.|[^)])+)\)\]\(((?:\\.|[^)])+)\)/g;
  for (const match of content.matchAll(markdown)) {
    const [, alt, src, href] = match;
    if (!href || !src || !alt) {
      continue;
    }
    entries.push({
      html_url: href,
      avatar_url: src,
      display: unescapeMarkdownText(alt),
    });
  }

  return entries;
}

function assertRenderedClawtributorCount(
  block: string,
  entries: readonly RenderableClawtributorEntry[],
): void {
  const expectedByRendered = new Map<string, number>();
  for (const entry of entries) {
    const rendered = renderClawtributorEntry(entry);
    expectedByRendered.set(rendered, (expectedByRendered.get(rendered) ?? 0) + 1);
  }

  let actualEntries = 0;
  for (const [rendered, expected] of expectedByRendered) {
    const actual = block.split(rendered).length - 1;
    if (actual !== expected) {
      throw new Error(
        `Rendered clawtributors count mismatch: expected ${entries.length}, got ${actualEntries + actual}`,
      );
    }
    actualEntries += actual;
  }

  if (actualEntries !== entries.length) {
    throw new Error(
      `Rendered clawtributors count mismatch: expected ${entries.length}, got ${actualEntries}`,
    );
  }
}

function escapeMarkdownText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

function unescapeMarkdownText(value: string): string {
  return value.replace(/\\([\[\]])/g, "$1").replace(/\\\\/g, "\\");
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function fallbackHref(value: string): string {
  const encoded = encodeURIComponent(value.trim());
  return encoded ? `https://github.com/search?q=${encoded}` : "https://github.com";
}
