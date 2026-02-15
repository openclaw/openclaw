/**
 * Model ID Sanitization
 *
 * Deterministic validation and sanitization of configured model IDs.
 * Ensures stale/nonexistent IDs are never persisted back to config.
 */

export type SanitizeResult = {
  configured: string[];
  removed: string[];
  repaired: Array<{ from: string; to: string }>;
};

export function sanitizeConfiguredModelIds(
  configuredIds: string[],
  catalogModelIds: Set<string>,
): SanitizeResult {
  const configured: string[] = [];
  const removed: string[] = [];
  const repaired: Array<{ from: string; to: string }> = [];

  for (const id of configuredIds) {
    const trimmed = id.trim();
    if (!trimmed) {
      continue;
    }

    if (catalogModelIds.has(trimmed)) {
      configured.push(trimmed);
      continue;
    }

    const repairCandidate = attemptDeterministicRepair(trimmed, catalogModelIds);
    if (repairCandidate) {
      configured.push(repairCandidate);
      repaired.push({ from: trimmed, to: repairCandidate });
      continue;
    }

    removed.push(trimmed);
  }

  return { configured, removed, repaired };
}

function attemptDeterministicRepair(id: string, catalogModelIds: Set<string>): string | null {
  const slash = id.indexOf("/");
  if (slash === -1) {
    return null;
  }

  const provider = id.slice(0, slash);
  const modelPart = id.slice(slash + 1);

  if (!provider || !modelPart) {
    return null;
  }

  const thinkingVariant = provider + "/" + modelPart + "-thinking";
  if (catalogModelIds.has(thinkingVariant)) {
    const candidates = findCandidates(id, catalogModelIds);
    if (candidates.length === 1 && candidates[0] === thinkingVariant) {
      return thinkingVariant;
    }
    return null;
  }

  return null;
}

function findCandidates(baseId: string, catalogModelIds: Set<string>): string[] {
  const slash = baseId.indexOf("/");
  if (slash === -1) {
    return [];
  }

  const provider = baseId.slice(0, slash);
  const modelPart = baseId.slice(slash + 1);

  if (!provider || !modelPart) {
    return [];
  }

  const candidates: string[] = [];
  for (const catalogId of catalogModelIds) {
    if (!catalogId.startsWith(provider + "/")) {
      continue;
    }
    const catalogModel = catalogId.slice(provider.length + 1);
    if (catalogModel.startsWith(modelPart) && catalogModel !== modelPart) {
      candidates.push(catalogId);
    }
  }

  return candidates.toSorted();
}

export function sanitizeSingleModelId(
  modelId: string | undefined,
  catalogModelIds: Set<string>,
): { id: string | null; repaired?: { from: string; to: string } } {
  if (!modelId?.trim()) {
    return { id: null };
  }

  const result = sanitizeConfiguredModelIds([modelId], catalogModelIds);

  if (result.configured.length > 0) {
    const repairedEntry = result.repaired.find((r) => r.to === result.configured[0]);
    return {
      id: result.configured[0] ?? null,
      repaired: repairedEntry,
    };
  }

  return { id: null };
}

export function buildCatalogKeySet(catalog: Array<{ provider: string; id: string }>): Set<string> {
  return new Set(catalog.map((entry) => entry.provider + "/" + entry.id));
}
