// Sliding-window chunker for log payloads. Token counts use a deterministic
// whitespace-tokenizer so behavior is stable across providers without pulling
// in a real tokenizer at this layer.

const DEFAULT_MAX_TOKENS = 400;
const DEFAULT_OVERLAP_TOKENS = 80;

function tokenize(text: string): string[] {
  return text.split(/\s+/u).filter((token) => token.length > 0);
}

export function approxTokenCount(text: string): number {
  return tokenize(text).length;
}

export function slidingWindowChunks(
  text: string,
  opts?: { maxTokens?: number; overlapTokens?: number },
): string[] {
  const maxTokens = Math.max(1, opts?.maxTokens ?? DEFAULT_MAX_TOKENS);
  const overlapTokens = Math.max(
    0,
    Math.min(opts?.overlapTokens ?? DEFAULT_OVERLAP_TOKENS, maxTokens - 1),
  );
  const tokens = tokenize(text);
  if (tokens.length <= maxTokens) {
    return [text.trim()];
  }
  const step = maxTokens - overlapTokens;
  const out: string[] = [];
  for (let start = 0; start < tokens.length; start += step) {
    const slice = tokens.slice(start, start + maxTokens);
    if (slice.length === 0) {
      break;
    }
    out.push(slice.join(" "));
    if (start + maxTokens >= tokens.length) {
      break;
    }
  }
  return out;
}
