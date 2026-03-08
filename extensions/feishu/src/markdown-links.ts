const FENCED_CODE_BLOCK_RE = /(```[\s\S]*?```)/g;
const INLINE_CODE_RE = /(`[^`\n]*`)/g;
const URL_RE = /https?:\/\/[^\s<>"'`\]]+/g;
const TRAILING_PUNCT_RE = /[.,;!?\u3002\uff0c\uff1b\uff01\uff1f\u3001]/u;
const AUTO_LINK_RE = /<\s*(https?:\/\/[^>\s]+)\s*>/g;

// Feishu markdown can mis-handle some URL characters in edge cases.
// Encode a minimal safe subset while preserving URL semantics.
function normalizeUrlForFeishu(url: string): string {
  return url.replace(/_/g, "%5F").replace(/\(/g, "%28").replace(/\)/g, "%29");
}

// We intentionally convert raw/autolink URLs into explicit markdown links.
// Why: in Feishu message rendering, plain URLs (including "<...>" autolinks)
// can be re-tokenized and visually split/truncated on characters like "_"
// or around long query strings. The explicit "[label](url)" form is more stable
// in post/card markdown parsing and keeps the link clickable end-to-end.
function buildMarkdownLink(url: string): string {
  const label = url.replace(/[\[\]]/g, "\\$&");
  return `[${label}](${url})`;
}

// We only need balance info to detect whether a trailing ")" belongs to the URL.
function countParens(text: string): { open: number; close: number } {
  let open = 0;
  let close = 0;
  for (const c of text) {
    if (c === "(") {
      open += 1;
    } else if (c === ")") {
      close += 1;
    }
  }
  return { open, close };
}

function splitTrailingPunctuation(rawUrl: string): { url: string; trailing: string } {
  let url = rawUrl;
  let trailing = "";
  let { open, close } = countParens(rawUrl);

  while (url.length > 0) {
    const tail = url.slice(-1);
    // Many links appear as ".../path),". Strip punctuation that is not part of the URL.
    const closeParenOverflow = tail === ")" && close > open;
    if (!TRAILING_PUNCT_RE.test(tail) && !closeParenOverflow) {
      break;
    }
    if (tail === ")") {
      close -= 1;
    }
    trailing = tail + trailing;
    url = url.slice(0, -1);
  }

  return { url, trailing };
}

// Scan backwards from `offset` to detect if the position is inside a markdown
// link label [...]. Returns true if an unmatched "[" is found before "]" or
// newline, meaning this URL sits somewhere inside a label (not necessarily
// starting right after "[").
function isInsideMarkdownLinkLabel(offset: number, input: string): boolean {
  for (let i = offset - 1; i >= 0; i--) {
    const ch = input[i];
    if (ch === "[") return true;
    if (ch === "]" || ch === "\n") return false;
  }
  return false;
}

function wrapBareUrls(text: string): string {
  // Normalize "<https://...>" to explicit markdown links for better Feishu stability.
  // Skip autolinks that appear inside a markdown destination: ](<https://...>).
  const convertedAutoLinks = text.replace(
    AUTO_LINK_RE,
    (_full, rawUrl: string, offset: number, input: string) => {
      // ](<https://...>) — angle-bracket destination form; leave as-is.
      if (offset >= 2 && input.slice(offset - 2, offset) === "](") {
        return _full;
      }
      const { url, trailing } = splitTrailingPunctuation(rawUrl);
      if (!url) {
        return _full;
      }
      return `${buildMarkdownLink(normalizeUrlForFeishu(url))}${trailing}`;
    },
  );

  return convertedAutoLinks.replace(URL_RE, (raw, offset, input) => {
    const { url, trailing } = splitTrailingPunctuation(raw);
    if (!url) {
      return raw;
    }

    // Skip URLs inside a markdown link label (anywhere in [...], not just at start).
    if (isInsideMarkdownLinkLabel(offset, input)) {
      return raw;
    }

    // Destination: preceded by "](" → normalize chars in-place, no re-wrap.
    const isMarkdownDestination = offset >= 2 && input.slice(offset - 2, offset) === "](";
    // Angle-bracket destination: ](<https://...>) — leave completely untouched.
    const isAngleBracketDest =
      offset >= 1 &&
      input[offset - 1] === "<" &&
      offset >= 3 &&
      input.slice(offset - 3, offset - 1) === "](";
    const normalizedUrl = normalizeUrlForFeishu(url);
    if (isMarkdownDestination) {
      return `${normalizedUrl}${trailing}`;
    }
    if (isAngleBracketDest) {
      return raw;
    }

    return `${buildMarkdownLink(normalizedUrl)}${trailing}`;
  });
}

function normalizeNonCodeSegments(text: string): string {
  // Keep inline code untouched, normalize only plain markdown text.
  return text
    .split(INLINE_CODE_RE)
    .map((segment, idx) =>
      idx % 2 === 1 && segment.startsWith("`") ? segment : wrapBareUrls(segment),
    )
    .join("");
}

export function normalizeFeishuMarkdownLinks(text: string): string {
  if (!text || (!text.includes("http://") && !text.includes("https://"))) {
    return text;
  }

  return (
    text
      // Keep fenced code blocks untouched to avoid changing examples/snippets.
      .split(FENCED_CODE_BLOCK_RE)
      .map((block, idx) =>
        idx % 2 === 1 && block.startsWith("```") ? block : normalizeNonCodeSegments(block),
      )
      .join("")
  );
}
