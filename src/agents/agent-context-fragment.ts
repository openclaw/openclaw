/**
 * Phase 9: Source-tagged context fragments for system prompt contributions.
 *
 * A `ContextFragment` carries a `source` provenance label, a semantic `type`
 * (fact / inference / preference), and the rendered `content` string.  Helpers
 * here convert fragments to prompt text without altering how the content reads —
 * the source tag is emitted as a parenthetical suffix that the model can use for
 * confidence calibration but that blends into normal prose when ignored.
 *
 * All helpers are pure and never throw.
 */

/** Semantic classification of a context fragment. */
export type ContextFragmentType = "fact" | "inference" | "preference";

/**
 * A single tagged unit of context that can be contributed to a system prompt.
 *
 * - `source`  — where this information comes from (e.g. "user-profile",
 *               "workspace-scan", "prior-session", "plugin:lark-base").
 * - `type`    — epistemological class: `"fact"` (directly observed),
 *               `"inference"` (derived/estimated), `"preference"` (user wish).
 * - `content` — the prose text that will appear in the prompt.
 */
export type ContextFragment = {
  source: string;
  type: ContextFragmentType;
  content: string;
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_FRAGMENT_TYPES: ReadonlySet<string> = new Set(["fact", "inference", "preference"]);

/**
 * Returns true when `value` is a structurally valid `ContextFragment`.
 *
 * Does NOT throw — safe to call on arbitrary unknown inputs.
 */
export function isContextFragment(value: unknown): value is ContextFragment {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v["source"] === "string" &&
    v["source"].length > 0 &&
    typeof v["type"] === "string" &&
    VALID_FRAGMENT_TYPES.has(v["type"]) &&
    typeof v["content"] === "string"
  );
}

/**
 * Narrows a `ContextFragmentType` string.  Returns `undefined` for unknown values.
 * Never throws.
 */
export function parseFragmentType(raw: string): ContextFragmentType | undefined {
  if (VALID_FRAGMENT_TYPES.has(raw)) {
    return raw as ContextFragmentType;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Renders a single `ContextFragment` to a prompt-ready string.
 *
 * Format: `<content> *(source: <source>, type: <type>)*`
 *
 * - The source annotation is appended as an italicised parenthetical that fits
 *   within normal Markdown and is visually skippable when reading the prompt.
 * - Empty `content` renders as an empty string (no annotation emitted).
 * - Never throws.
 */
export function renderContextFragment(fragment: ContextFragment): string {
  const { source, type, content } = fragment;
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return "";
  }
  return `${trimmed} *(source: ${source}, type: ${type})*`;
}

/**
 * Renders an array of `ContextFragment` values to a single block of text.
 *
 * Each non-empty fragment occupies its own line.  Fragments whose rendered
 * result is empty (empty `content`) are silently omitted.
 *
 * Returns `""` when the array is empty or all fragments render to empty strings.
 * Never throws.
 */
export function renderContextFragments(fragments: readonly ContextFragment[]): string {
  const lines: string[] = [];
  for (const f of fragments) {
    try {
      const rendered = renderContextFragment(f);
      if (rendered.length > 0) {
        lines.push(rendered);
      }
    } catch {
      // Never surface internal errors — fragment is silently skipped.
    }
  }
  return lines.join("\n");
}

/**
 * Safe wrapper: renders fragments only when `fragments` is a non-empty array.
 *
 * Returns `undefined` (not `""`) when there is nothing to render so callers
 * can use `??` / optional chaining without checking for empty strings.
 * Never throws.
 */
export function renderContextFragmentsSafe(
  fragments: readonly ContextFragment[] | undefined,
): string | undefined {
  if (!fragments || fragments.length === 0) {
    return undefined;
  }
  const rendered = renderContextFragments(fragments);
  return rendered.length > 0 ? rendered : undefined;
}
