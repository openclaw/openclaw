/**
 * Guard for immutable thinking/redacted_thinking content blocks.
 *
 * The Anthropic API requires that thinking and redacted_thinking blocks
 * in assistant messages are returned byte-for-byte identical. Spreading,
 * deleting fields, or any other mutation causes the API to reject the
 * request with:
 *   "thinking or redacted_thinking blocks in the latest assistant message
 *    cannot be modified"
 *
 * Every function that maps/transforms content blocks must call this guard
 * and short-circuit (return the block as-is) when it returns true.
 */
export function isImmutableThinkingBlock(block: unknown): boolean {
  if (!block || typeof block !== "object") {
    return false;
  }
  const type = (block as { type?: unknown }).type;
  return type === "thinking" || type === "redacted_thinking";
}
