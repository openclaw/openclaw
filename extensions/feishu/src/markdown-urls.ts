const SENTINEL_OPEN = "\u0001";
const SENTINEL_CLOSE = "\u0002";
const MASK_PREFIX = `${SENTINEL_OPEN}MDURL`;
const MASK_RESTORE_RE = new RegExp(`${MASK_PREFIX}(\\d+)${SENTINEL_CLOSE}`, "g");

const FENCED_CODE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`+[^`\n]+?`+/g;
const MARKDOWN_LINK_RE = /!?\[[^\]\n]*\]\([^)\n]*\)/g;
const ANGLE_AUTOLINK_RE = /<https?:\/\/[^\s>]+>/g;

// RFC 3986 URL chars plus `%`. Whitespace, `<`, `>`, quotes, backticks, and
// non-ASCII (e.g. Chinese) terminate the match naturally.
const BARE_URL_RE = /\bhttps?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/g;

const TRAILING_SENTENCE_PUNCT_RE = /[.,;:!?'"]+$/;

function encodeDestinationParens(url: string): string {
  return url.replace(/\(/g, "%28").replace(/\)/g, "%29");
}

function countUnbalancedTrailingParens(url: string): number {
  let opens = 0;
  let closes = 0;
  for (let i = 0; i < url.length; i++) {
    const ch = url[i];
    if (ch === "(") {
      opens++;
    } else if (ch === ")") {
      closes++;
    }
  }
  const unbalanced = closes - opens;
  if (unbalanced <= 0) {
    return 0;
  }
  let trailing = 0;
  for (let i = url.length - 1; i >= 0 && url[i] === ")" && trailing < unbalanced; i--) {
    trailing++;
  }
  return trailing;
}

function maskRegions(input: string, stash: string[]): string {
  const replacer = (match: string): string => {
    const index = stash.length;
    stash.push(match);
    return `${MASK_PREFIX}${index}${SENTINEL_CLOSE}`;
  };
  // Order matters: fenced code first so its body is frozen before inline
  // code or link regexes can peek inside it.
  return input
    .replace(FENCED_CODE_RE, replacer)
    .replace(INLINE_CODE_RE, replacer)
    .replace(MARKDOWN_LINK_RE, replacer)
    .replace(ANGLE_AUTOLINK_RE, replacer);
}

function restoreRegions(input: string, stash: string[]): string {
  return input.replace(MASK_RESTORE_RE, (_, id: string) => stash[Number(id)] ?? "");
}

function stripSentinels(text: string): string {
  return text.split(SENTINEL_OPEN).join("").split(SENTINEL_CLOSE).join("");
}

function wrapOneBareUrl(match: string): string {
  const puncMatch = match.match(TRAILING_SENTENCE_PUNCT_RE);
  const puncTail = puncMatch ? puncMatch[0] : "";
  const withoutPunc = puncTail ? match.slice(0, -puncTail.length) : match;

  const parenCount = countUnbalancedTrailingParens(withoutPunc);
  const url = parenCount > 0 ? withoutPunc.slice(0, -parenCount) : withoutPunc;
  const trailing = `${")".repeat(parenCount)}${puncTail}`;

  if (!url) {
    return match;
  }
  // Percent-encode `(` and `)` on the destination side so a markdown parser
  // never closes the destination at a mid-URL `)`. The display side keeps
  // the literal URL so recipients still see the exact address.
  return `[${url}](${encodeDestinationParens(url)})${trailing}`;
}

/**
 * Wrap bare http(s) URLs as `[url](url)` so Feishu's post `md` tag does not
 * have to infer link boundaries. Feishu's markdown parser treats `_` as an
 * italic marker, which breaks autolinks on URLs such as
 * `https://host/path?flow_id=...&user_code=...`.
 *
 * Regions that already carry link semantics — markdown links, image syntax,
 * angle-bracket autolinks, inline code, and fenced code blocks — are masked
 * out before matching, so they are never double-wrapped or mutated.
 *
 * Trailing sentence punctuation (`.,;:!?'"`) and unbalanced `)` are pushed
 * back outside the wrapped link so prose punctuation stays intact.
 *
 * Sentinel control characters used internally for masking are stripped from
 * the input to prevent forged tokens from substituting stashed content.
 */
export function wrapBareUrlsForFeishuMarkdown(text: string): string {
  if (!text) {
    return text;
  }
  const safe =
    text.includes(SENTINEL_OPEN) || text.includes(SENTINEL_CLOSE) ? stripSentinels(text) : text;
  if (!safe.includes("http")) {
    return safe;
  }
  const stash: string[] = [];
  const masked = maskRegions(safe, stash);
  const wrapped = masked.replace(BARE_URL_RE, wrapOneBareUrl);
  return restoreRegions(wrapped, stash);
}
