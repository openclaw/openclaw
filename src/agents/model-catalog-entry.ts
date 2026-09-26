import { MODEL_APIS } from "../config/types.models.js";
import { normalizeCatalogRouteBaseUrl } from "./model-catalog-metadata.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "./model-catalog.types.js";
import { createModelCatalogIdentityKeyResolver } from "./openai-model-routes.js";

function isCatalogModelApi(
  value: string | undefined,
): value is NonNullable<ModelCatalogEntry["api"]> {
  return value !== undefined && MODEL_APIS.some((api) => api === value);
}

/** Shared metadata projection; keep transport headers and authoring fields out of catalog entries. */
export function modelCatalogRowToEntry(
  row: Omit<ModelCatalogEntry, "api"> & { api?: string },
): ModelCatalogEntry {
  const contextWindow = row.contextWindow ?? row.contextTokens;
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    ...(isCatalogModelApi(row.api) ? { api: row.api } : {}),
    ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
    ...(row.inference ? { inference: row.inference } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(row.contextWindows
      ? { contextWindows: row.contextWindows.map((option) => ({ ...option })) }
      : {}),
    ...(row.contextWindowDefault ? { contextWindowDefault: row.contextWindowDefault } : {}),
    ...(row.contextTokens !== undefined ? { contextTokens: row.contextTokens } : {}),
    reasoning: row.reasoning,
    ...(row.thinkingLevelMap ? { thinkingLevelMap: { ...row.thinkingLevelMap } } : {}),
    ...(row.input ? { input: [...row.input] } : {}),
    ...(row.params ? { params: { ...row.params } } : {}),
    ...(row.compat ? { compat: row.compat } : {}),
    ...(row.mediaInput ? { mediaInput: row.mediaInput } : {}),
    status: row.status,
    ...(row.statusReason ? { statusReason: row.statusReason } : {}),
    ...(row.replaces ? { replaces: [...row.replaces] } : {}),
    ...(row.replacedBy ? { replacedBy: row.replacedBy } : {}),
  };
}

export function modelCatalogRouteVariantKey(entry: ModelCatalogEntry, identityKey: string): string {
  return JSON.stringify([
    identityKey,
    entry.nativeRuntime ?? "",
    entry.api ?? "",
    normalizeCatalogRouteBaseUrl(entry.baseUrl) ?? "",
  ]);
}

function mergeHarnessCompat(
  observed: ModelCatalogEntry["compat"],
  provider: ModelCatalogEntry["compat"],
): ModelCatalogEntry["compat"] {
  if (!observed && !provider) {
    return undefined;
  }
  const compat = { ...provider, ...observed };
  if (observed?.supportedReasoningEfforts?.length === 0) {
    return { ...compat, supportsReasoningEffort: false, supportedReasoningEfforts: [] };
  }
  const efforts = [
    ...new Set([
      ...(provider?.supportedReasoningEfforts ?? []),
      ...(observed?.supportedReasoningEfforts ?? []),
    ]),
  ];
  return efforts.length > 0
    ? { ...compat, supportsReasoningEffort: true, supportedReasoningEfforts: efforts }
    : compat;
}

export function enrichHarnessRows(
  rows: readonly ModelCatalogEntry[],
  snapshot: ModelCatalogSnapshot,
): ModelCatalogEntry[] {
  const keyOf = createModelCatalogIdentityKeyResolver();
  const routeDonors = new Map<string, ModelCatalogEntry>();
  const identityDonors = new Map<string, ModelCatalogEntry>();
  let donorsPrepared = false;
  return rows.map((entry) => {
    // Native discovery owns these capabilities; host donors cannot invent its transport.
    if (entry.nativeRuntime) {
      return entry;
    }
    if (!donorsPrepared) {
      // API variants remain donors when a native row is the primary display entry.
      // Native metadata must never give an untagged host row a native transport.
      for (const donor of [
        ...snapshot.entries,
        ...snapshot.routeVariants,
        ...(snapshot.staticEntries ?? []),
      ]) {
        if (donor.nativeRuntime) {
          continue;
        }
        const identityKey = keyOf(donor);
        const routeKey = modelCatalogRouteVariantKey(donor, identityKey);
        if (!routeDonors.has(routeKey)) {
          routeDonors.set(routeKey, donor);
        }
        if (!identityDonors.has(identityKey)) {
          identityDonors.set(identityKey, donor);
        }
      }
      donorsPrepared = true;
    }
    const identityKey = keyOf(entry);
    const donor =
      routeDonors.get(modelCatalogRouteVariantKey(entry, identityKey)) ??
      (entry.api === undefined && entry.baseUrl === undefined
        ? identityDonors.get(identityKey)
        : undefined);
    if (!donor) {
      return entry;
    }
    const compat = mergeHarnessCompat(entry.compat, donor.compat);
    const mergedParams =
      donor.params || entry.params ? { ...donor.params, ...entry.params } : undefined;
    return {
      ...donor,
      ...entry,
      ...(mergedParams ? { params: mergedParams } : {}),
      ...(compat ? { compat } : {}),
    };
  });
}
