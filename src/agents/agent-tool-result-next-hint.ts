/**
 * next_hint inference for common tool output patterns.
 *
 * Provides contextual follow-up suggestions so the model knows what to do
 * after receiving a tool result — e.g. after a search, fetch the records;
 * after a create, use the returned ID.
 *
 * Rules:
 * - Pure function, zero imports, never throws.
 * - Only infers from the tool name; does not parse output text.
 * - Returns undefined when no useful hint can be inferred (most tools).
 * - Callers may always override the hint by passing it explicitly to
 *   buildToolResultEnvelope({ nextHint: "..." }).
 *
 * Phase 10 of: docs/reference/agent-architecture-upgrade.md
 */

/**
 * Infer a contextual next_hint string from a tool name.
 *
 * Returns undefined for tools where no generic hint adds value (read, exec,
 * update, delete, send, etc.) so callers receive no spurious guidance.
 */
export function inferNextHint(toolName: string): string | undefined {
  if (!toolName) {
    return undefined;
  }
  const name = toolName.toLowerCase();

  // search / list / find / query / lookup → results may contain IDs or tokens
  // that need a follow-up get/read call to retrieve full content.
  if (/search|list|find|query|lookup/.test(name)) {
    return "Use the returned IDs or tokens to fetch full record content with the corresponding get or read tool.";
  }

  // create / insert / new → result carries a new resource ID or token that
  // downstream operations (update, share, reference) will need.
  if (/create|insert/.test(name) || name.endsWith("_new") || name.startsWith("new_")) {
    return "Use the returned ID or token to update, reference, or share this new resource.";
  }

  return undefined;
}
