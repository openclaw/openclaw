import { stableStringify } from "@openclaw/normalization-core";

/**
 * Builds a predicate for text blocks that only mirror an MCP result's structuredContent.
 * Servers serialize that mirror differently (pretty, compact, other key order), so a block
 * counts as the mirror when it is complete JSON for the same value. Any other text, including
 * JSON for a different value, is kept because it can carry recovery guidance.
 */
export function createMcpStructuredContentMirrorMatcher(
  structuredContent: Record<string, unknown>,
): (text: string) => boolean {
  let pretty: string | undefined;
  let canonical: string | undefined;
  return (text) => {
    if (text === (pretty ??= JSON.stringify(structuredContent, null, 2))) {
      return true;
    }
    if (!text.trimStart().startsWith("{")) {
      return false;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      return stableStringify(parsed) === (canonical ??= stableStringify(structuredContent));
    } catch {
      // Not JSON, or too deeply nested to compare: keep the block.
      return false;
    }
  };
}
