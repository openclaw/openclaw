import type { Token } from "markdown-it";
import { isGitHubHost } from "./link-eligibility.js";
import {
  decodeGitHubPathSegment,
  parseGitHubItemPath,
  parseGitHubLinkTarget,
} from "./link-target.js";

// CSS paints the decorative mark outside the accessibility tree and copied text.
const GITHUB_LINK_CLASS = "markdown-github-link";
export const GITHUB_ITEM_LINK_SELECTOR = "a.markdown-github-item";
const CODE_SPAN_URL_BREAK_RE = /[\s\p{Cc}]/u;

export function isGitHubCodeSpanUrl(content: string, url: URL | null): boolean {
  return !CODE_SPAN_URL_BREAK_RE.test(content) && url !== null && isGitHubHost(url.hostname);
}

function formatGitHubLinkLabel(url: URL): string {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length === 2) {
    return segments.map((segment) => decodeGitHubPathSegment(segment) ?? segment).join("/");
  }
  if ((segments[2] === "blob" || segments[2] === "tree") && segments.length > 4) {
    const basename = decodeGitHubPathSegment(segments.at(-1) ?? "");
    if (basename) {
      // Tree URLs can contain slash-separated refs, not just folder paths.
      // Show the omission rather than presenting the suffix as a folder name.
      return segments[2] === "tree"
        ? `${segments
            .slice(0, 2)
            .map((segment) => decodeGitHubPathSegment(segment) ?? segment)
            .join("/")}/…/${basename}`
        : basename;
    }
  }
  const path = segments.map((segment) => decodeGitHubPathSegment(segment) ?? segment);
  return ["github.com", ...path].join("/");
}

export function decorateGitHubMarkdownLink(params: {
  open: Token;
  labelToken: Token | null;
  children: readonly Token[];
  index: number;
  url: URL;
  href: string;
  generatedUrlLabel: boolean;
}): boolean {
  const { open, labelToken, children, index, url, href, generatedUrlLabel } = params;
  if (!isGitHubHost(url.hostname)) {
    return false;
  }
  const githubPreview = parseGitHubLinkTarget(href);
  if (labelToken) {
    open.attrJoin("class", GITHUB_LINK_CLASS);
    const item = githubPreview ?? parseGitHubItemPath(url);
    const label =
      labelToken.type === "text" &&
      children[index + 1] === labelToken &&
      children[index + 2]?.type === "link_close"
        ? labelToken.content
        : null;
    const itemChip =
      item &&
      (generatedUrlLabel ||
        label === `#${item.number}` ||
        label === `${item.owner}/${item.repo}#${item.number}`);
    if (itemChip) {
      open.attrJoin("class", "markdown-github-item");
      open.attrSet("data-github-kind", item.kind);
    }
    if (generatedUrlLabel) {
      labelToken.content = item ? `#${item.number}` : formatGitHubLinkLabel(url);
    }
    if (!githubPreview && (generatedUrlLabel || itemChip)) {
      open.attrSet("title", href);
    }
  }
  return true;
}
