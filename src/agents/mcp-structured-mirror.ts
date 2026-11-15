import { stableStringify } from "@openclaw/normalization-core";

/**
 * Builds a predicate for text blocks that only mirror an MCP result's structuredContent.
 * Servers serialize that mirror differently (pretty, compact, other key order), and the spec
 * requires structuredContent to be an object, so servers returning an array or scalar wrap it
 * under one key ({"items": [...]}, FastMCP's {"result": ...}) while the text carries the bare
 * value. A block counts as the mirror when it is complete JSON for structuredContent or for the
 * only value of a single-key structuredContent; a plain-text block counts when it equals that
 * only value when it is a string. Any other text, including JSON for a different value, is kept
 * because it can carry recovery guidance.
 */
export function createMcpStructuredContentMirrorMatcher(
  structuredContent: Record<string, unknown>,
): (text: string) => boolean {
  const [onlyKey, ...otherKeys] = Object.keys(structuredContent);
  const wrapped =
    onlyKey !== undefined && otherKeys.length === 0 ? structuredContent[onlyKey] : undefined;
  let canonical: string | undefined;
  let canonicalWrapped: string | undefined;
  return (text) => {
    if (typeof wrapped === "string" && text === wrapped) {
      return true;
    }
    try {
      const parsed = stableStringify(JSON.parse(text));
      return (
        parsed === (canonical ??= stableStringify(structuredContent)) ||
        (wrapped !== undefined && parsed === (canonicalWrapped ??= stableStringify(wrapped)))
      );
    } catch {
      // Not JSON, or too deeply nested to compare: keep the block.
      return false;
    }
  };
}
