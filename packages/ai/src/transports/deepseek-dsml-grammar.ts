// Keep the shipped single-bar forms and the doubled full-width form observed
// in provider output identical across tool recovery and visible-text filtering.
export const DEEPSEEK_DSML_MARKERS = ["|", "｜", "｜｜"].map((bar) => `${bar}DSML${bar}`);
export const DEEPSEEK_DSML_MARKER_PATTERN = `(${DEEPSEEK_DSML_MARKERS.map((marker) =>
  marker.replaceAll("|", "\\|"),
).join("|")})`;

export function findEarliestDsmlToken(text: string, tokens: readonly string[], fromIndex = 0) {
  let best: { index: number; token: string } | null = null;
  for (const token of tokens) {
    const index = text.indexOf(token, fromIndex);
    if (index !== -1 && (!best || index < best.index)) {
      best = { index, token };
    }
  }
  return best;
}

export function longestDsmlTokenPrefixSuffixLength(
  text: string,
  tokens: readonly string[],
  maxTokenLength: number,
): number {
  const maxLength = Math.min(text.length, maxTokenLength - 1);
  for (let length = maxLength; length > 0; length--) {
    const suffix = text.slice(text.length - length);
    if (tokens.some((token) => token.startsWith(suffix))) {
      return length;
    }
  }
  return 0;
}
