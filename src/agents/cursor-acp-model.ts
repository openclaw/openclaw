/**
 * Cursor ACP advertises bracketed model ids (e.g. grok-4.5[effort=high,fast=true]),
 * while Cursor CLI --list-models uses catalog ids (cursor-grok-4.5-medium).
 * acpx validates sessionOptions.model against the ACP advertisement, so OpenClaw
 * must request advertised ids (or aliases that expand to them).
 */

/** Carlos preference: medium no-fast → high no-fast → high fast. */
export const CURSOR_ACP_GROK_ADVERTISED_PREFERENCE = [
  "grok-4.5[effort=medium,fast=false]",
  "grok-4.5[effort=high,fast=false]",
  "grok-4.5[effort=high,fast=true]",
] as const;

const CURSOR_GROK_ALIAS_TO_ADVERTISED: Record<string, readonly string[]> = {
  "cursor-grok-4.5-medium": CURSOR_ACP_GROK_ADVERTISED_PREFERENCE,
  "cursor-grok-4.5-medium-fast": [
    "grok-4.5[effort=medium,fast=true]",
    "grok-4.5[effort=high,fast=true]",
  ],
  "cursor-grok-4.5-high": ["grok-4.5[effort=high,fast=false]", "grok-4.5[effort=high,fast=true]"],
  "cursor-grok-4.5-high-fast": ["grok-4.5[effort=high,fast=true]"],
  "cursor-grok-4.5-low": [
    "grok-4.5[effort=low,fast=false]",
    "grok-4.5[effort=medium,fast=false]",
    ...CURSOR_ACP_GROK_ADVERTISED_PREFERENCE,
  ],
  "cursor-grok-4.5-low-fast": ["grok-4.5[effort=low,fast=true]", "grok-4.5[effort=high,fast=true]"],
  // Bare family name must never be passed to set_config_option (ACP -32602).
  "grok-4.5": CURSOR_ACP_GROK_ADVERTISED_PREFERENCE,
};

function normalizeModelId(raw: string): string {
  return raw.trim();
}

/** True when the id looks like a Cursor ACP advertised bracketed model. */
export function isCursorAcpAdvertisedModelId(modelId: string): boolean {
  const normalized = normalizeModelId(modelId);
  return /^[a-z0-9][a-z0-9._-]*\[[^\]]+\]$/i.test(normalized);
}

/**
 * Expand a requested Cursor/Grok model (CLI catalog alias or advertised id)
 * into an ordered list of ACP-advertised candidates to try.
 */
export function expandCursorAcpGrokModelCandidates(model: string | undefined): string[] {
  const normalized = normalizeModelId(model ?? "");
  if (!normalized) {
    return [...CURSOR_ACP_GROK_ADVERTISED_PREFERENCE];
  }
  if (isCursorAcpAdvertisedModelId(normalized)) {
    return [normalized];
  }
  const aliased = CURSOR_GROK_ALIAS_TO_ADVERTISED[normalized.toLowerCase()];
  if (aliased) {
    return [...aliased];
  }
  // Unknown id: keep as-is so callers still see a clear advertise error.
  return [normalized];
}

/**
 * Default harness candidate chain for Cursor ACP coding (Carlos preference order).
 * Uses advertised forms so acpx session/set_config_option can succeed.
 */
export function resolveCursorAcpGrokHarnessCandidates(): string[] {
  return [...CURSOR_ACP_GROK_ADVERTISED_PREFERENCE];
}
