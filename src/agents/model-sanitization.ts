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
  ambiguous: string[];
  unknown: string[];
};

export type ModelSanitizationRemovalReason = "ambiguous" | "unknown";

type RepairAttempt = { kind: "repaired"; to: string } | { kind: "ambiguous" } | { kind: "unknown" };

export function sanitizeConfiguredModelIds(
  configuredIds: string[],
  catalogModelIds: Set<string>,
): SanitizeResult {
  const configured: string[] = [];
  const removed: string[] = [];
  const repaired: Array<{ from: string; to: string }> = [];
  const ambiguous: string[] = [];
  const unknown: string[] = [];

  for (const id of configuredIds) {
    const trimmed = id.trim();
    if (!trimmed) {
      continue;
    }

    if (catalogModelIds.has(trimmed)) {
      configured.push(trimmed);
      continue;
    }

    const repairAttempt = attemptDeterministicRepair(trimmed, catalogModelIds);
    if (repairAttempt.kind === "repaired") {
      configured.push(repairAttempt.to);
      repaired.push({ from: trimmed, to: repairAttempt.to });
      continue;
    }

    removed.push(trimmed);
    if (repairAttempt.kind === "ambiguous") {
      ambiguous.push(trimmed);
    } else {
      unknown.push(trimmed);
    }
  }

  return { configured, removed, repaired, ambiguous, unknown };
}

function attemptDeterministicRepair(id: string, catalogModelIds: Set<string>): RepairAttempt {
  const slash = id.indexOf("/");
  if (slash === -1) {
    return { kind: "unknown" };
  }

  const provider = id.slice(0, slash);
  const modelPart = id.slice(slash + 1);

  if (!provider || !modelPart) {
    return { kind: "unknown" };
  }

  const candidates = findCandidates(id, catalogModelIds);
  if (candidates.length === 0) {
    return { kind: "unknown" };
  }
  if (candidates.length === 1) {
    return { kind: "repaired", to: candidates[0] ?? id };
  }
  return { kind: "ambiguous" };
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
): {
  id: string | null;
  repaired?: { from: string; to: string };
  reason?: ModelSanitizationRemovalReason;
} {
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

  const reason: ModelSanitizationRemovalReason =
    result.ambiguous.length > 0 ? "ambiguous" : "unknown";
  return { id: null, reason };
}

export function buildCatalogKeySet(catalog: Array<{ provider: string; id: string }>): Set<string> {
  return new Set(catalog.map((entry) => entry.provider + "/" + entry.id));
}
