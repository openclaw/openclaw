// Sticky `\s*` keeps whitespace skipping identical to the character class used by
// the pattern this scanner replaced, without rescanning the string.
const SVG_PROLOGUE_WHITESPACE_RE = /\s*/y;

function skipSvgPrologueWhitespace(text: string, index: number): number {
  SVG_PROLOGUE_WHITESPACE_RE.lastIndex = index;
  SVG_PROLOGUE_WHITESPACE_RE.exec(text);
  return SVG_PROLOGUE_WHITESPACE_RE.lastIndex;
}

function startsWithToken(text: string, index: number, token: string): boolean {
  return text.slice(index, index + token.length).toLowerCase() === token;
}

/**
 * Recognizes an SVG root element after an optional XML declaration and comments.
 *
 * An index scan rather than a regex on purpose: the equivalent
 * `(?:<!--[\s\S]*?-->\s*)*<svg` backtracks exponentially on comment-like bytes that
 * never reach a root element, and these bytes arrive from remote icon and
 * link-favicon responses on the Gateway's single event loop, so one crafted
 * response would stall every session. A comment ends at its first `-->`, so text
 * between a closed comment and the root element is rejected, not absorbed.
 */
export function startsWithSvgRootElement(text: string): boolean {
  let index = skipSvgPrologueWhitespace(text, 0);
  if (startsWithToken(text, index, "<?xml")) {
    const declarationEnd = text.indexOf(">", index);
    if (declarationEnd < 0) {
      return false;
    }
    index = skipSvgPrologueWhitespace(text, declarationEnd + 1);
  }
  while (startsWithToken(text, index, "<!--")) {
    const commentEnd = text.indexOf("-->", index + "<!--".length);
    if (commentEnd < 0) {
      return false;
    }
    index = skipSvgPrologueWhitespace(text, commentEnd + "-->".length);
  }
  if (!startsWithToken(text, index, "<svg")) {
    return false;
  }
  const delimiter = text[index + "<svg".length];
  return (
    delimiter === ">" ||
    (delimiter === "/" && text[index + "<svg/".length] === ">") ||
    (delimiter !== undefined && /\s/u.test(delimiter))
  );
}

/**
 * SVG images stay self-contained: no script, document expansion, embedded
 * documents, or outbound fetches can reach the browser through an image route.
 */
export function isSelfContainedSvg(text: string): boolean {
  return (
    !text.includes("\0") &&
    !/<!doctype|<!entity/iu.test(text) &&
    !/<\s*(?:script|foreignObject|image|use|iframe)\b/iu.test(text) &&
    !/\b(?:href|xlink:href|src)\s*=/iu.test(text) &&
    startsWithSvgRootElement(text)
  );
}
