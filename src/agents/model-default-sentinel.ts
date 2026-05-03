import { normalizeModelSelection } from "./model-selection-shared.js";

/**
 * Reserved string that, when stored in a model-override field, instructs
 * the dispatcher to resolve `defaults.primary` at execution time instead of
 * pinning to a frozen value. The `@` prefix prevents collision with real
 * model identifiers.
 */
export const MODEL_DEFAULT_SENTINEL = "@default";

export function isModelDefaultSentinel(value: unknown): boolean {
  return typeof value === "string" && value.trim() === MODEL_DEFAULT_SENTINEL;
}

/**
 * Wrapper around `normalizeModelSelection` that returns `undefined` for the
 * default sentinel as well as for empty/whitespace strings. Use this at every
 * site that reads a stored model override (cron payload, session override,
 * subagent spawn override, agent-config subagent override) so the existing
 * precedence chain falls through to the live default.
 *
 * Sentinel detection runs both before AND after the underlying normalize
 * step, so object-shaped inputs like `{ primary: "@default" }` also fall
 * through (the bare-string check happens first; the post-normalize check
 * catches anything `normalizeModelSelection` extracts).
 *
 * Do NOT use this when reading `defaults.primary` itself — operators do not
 * write sentinels into the actual default.
 */
export function normalizeStoredModelOverride(value: unknown): string | undefined {
  if (isModelDefaultSentinel(value)) {
    return undefined;
  }
  const normalized = normalizeModelSelection(value);
  if (isModelDefaultSentinel(normalized)) {
    return undefined;
  }
  return normalized;
}
