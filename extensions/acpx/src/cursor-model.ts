/**
 * Cursor ACP advertises bracketed model ids; CLI --list-models uses cursor-grok-*.
 * Prefer Carlos order: medium no-fast → high no-fast → high fast.
 */

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
  "grok-4.5": CURSOR_ACP_GROK_ADVERTISED_PREFERENCE,
};

export function isCursorAcpAdvertisedModelId(modelId: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*\[[^\]]+\]$/i.test(modelId.trim());
}

/** Expand CLI/alias ids to ordered ACP-advertised candidates. */
export function expandCursorAcpGrokModelCandidates(model: string | undefined): string[] {
  const normalized = model?.trim() ?? "";
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
  return [normalized];
}

/** Map a requested Cursor model to the best first ACP-advertised candidate. */
export function mapCursorAcpRequestedModel(model: string | undefined): string | undefined {
  const candidates = expandCursorAcpGrokModelCandidates(model);
  return candidates[0];
}
