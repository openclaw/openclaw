/**
 * Session history may store `thinkingSignature` (stream assembler) or a raw
 * `signature` field (some round-trips). If `thinkingSignature` is present but
 * empty or whitespace-only, fall back to `signature` (not only when undefined —
 * that keeps transport replay and stream conversion consistent).
 */
export function resolveAnthropicStoredThinkingSignature(block: {
  thinkingSignature?: string;
  signature?: string;
}): string | undefined {
  const fromPrimary =
    typeof block.thinkingSignature === "string" ? block.thinkingSignature.trim() : "";
  if (fromPrimary) {
    return fromPrimary;
  }
  const fromSecondary = typeof block.signature === "string" ? block.signature.trim() : "";
  if (fromSecondary) {
    return fromSecondary;
  }
  return undefined;
}
