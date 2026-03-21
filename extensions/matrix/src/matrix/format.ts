import MarkdownIt from "markdown-it";

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
});

md.enable("strikethrough");

const { escapeHtml } = md.utils;

/**
 * Keep bare file references like README.md from becoming external http:// links.
 * Telegram already hardens this path; Matrix should not turn common code/docs
 * filenames into clickable registrar-style URLs either.
 */
const FILE_EXTENSIONS_WITH_TLD = new Set(["md", "go", "py", "pl", "sh", "am", "at", "be", "cc"]);

function isAutoLinkedFileRef(href: string, label: string): boolean {
  const stripped = href.replace(/^https?:\/\//i, "");
  if (stripped !== label) {
    return false;
  }
  const dotIndex = label.lastIndexOf(".");
  if (dotIndex < 1) {
    return false;
  }
  const ext = label.slice(dotIndex + 1).toLowerCase();
  if (!FILE_EXTENSIONS_WITH_TLD.has(ext)) {
    return false;
  }
  const segments = label.split("/");
  if (segments.length > 1) {
    for (let i = 0; i < segments.length - 1; i += 1) {
      if (segments[i]?.includes(".")) {
        return false;
      }
    }
  }
  return true;
}

function shouldSuppressAutoLink(
  tokens: Parameters<NonNullable<typeof md.renderer.rules.link_open>>[0],
  idx: number,
): boolean {
  const token = tokens[idx];
  if (token?.type !== "link_open" || token.info !== "auto") {
    return false;
  }
  const href = token.attrGet("href") ?? "";
  const label = tokens[idx + 1]?.type === "text" ? (tokens[idx + 1]?.content ?? "") : "";
  return Boolean(href && label && isAutoLinkedFileRef(href, label));
}

md.renderer.rules.image = (tokens, idx) => escapeHtml(tokens[idx]?.content ?? "");

md.renderer.rules.html_block = (tokens, idx) => escapeHtml(tokens[idx]?.content ?? "");
md.renderer.rules.html_inline = (tokens, idx) => escapeHtml(tokens[idx]?.content ?? "");
md.renderer.rules.link_open = (tokens, idx, _options, _env, self) =>
  shouldSuppressAutoLink(tokens, idx) ? "" : self.renderToken(tokens, idx, _options);
md.renderer.rules.link_close = (tokens, idx, _options, _env, self) => {
  const openIdx = idx - 2;
  if (openIdx >= 0 && shouldSuppressAutoLink(tokens, openIdx)) {
    return "";
  }
  return self.renderToken(tokens, idx, _options);
};

export function markdownToMatrixHtml(markdown: string): string {
  const rendered = md.render(markdown ?? "");
  return rendered.trimEnd();
}
