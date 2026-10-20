/**
 * Strips GFM sentence punctuation and unmatched closing parentheses from bare
 * URLs, while preserving balanced parentheses and exact authored Markdown
 * destinations. `(see https://example.com/path).` must resolve to the URL
 * alone, but `[label](https://example.com/path.)` keeps its authored dot.
 *
 * The trim set is anchored to the end of the string, so an authored query is
 * never cut short: `https://example.com/search?q=a,b` ends on a word character
 * and is returned unchanged.
 */
export function trimUrlTrailingPunctuation(url: string, knownUrls?: ReadonlySet<string>): string {
  let open = 0;
  for (let index = 0; index < url.length; index++) {
    const ch = url[index];
    if (ch === "(") {
      open++;
    } else if (ch === ")") {
      if (open === 0) {
        const authoredUrl = url.slice(0, index);
        return knownUrls?.has(authoredUrl)
          ? authoredUrl
          : trimUrlTrailingPunctuation(authoredUrl, knownUrls);
      }
      open--;
    }
  }
  const trimmed = url.replace(/[?!.,:;*_~]+$/u, "");
  return knownUrls?.has(url) && !knownUrls.has(trimmed) ? url : trimmed;
}
