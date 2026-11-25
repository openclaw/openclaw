import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  MODEL_APIS,
  type ModelDefinitionConfig,
  type ModelProviderConfig,
} from "../config/types.models.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "./model-catalog.types.js";
import {
  isVllmQwenThinkingCompat,
  modelTransportRoutesMatch,
  normalizeCatalogRouteBaseUrl,
} from "./model-compat-catalog.js";
import {
  readModelServingContextWindow,
  type ModelServingContextLimit,
} from "./model-serving-context.js";
import { createModelCatalogIdentityKeyResolver } from "./openai-model-routes.js";

function isCatalogModelApi(
  value: string | undefined,
): value is NonNullable<ModelCatalogEntry["api"]> {
  return value !== undefined && MODEL_APIS.some((api) => api === value);
}

/** Shared metadata projection; keep transport headers and authoring fields out of catalog entries. */
export function modelCatalogRowToEntry(
  row: Omit<ModelCatalogEntry, "api"> & {
    api?: string;
    servingContextLimit?: ModelServingContextLimit;
  },
): ModelCatalogEntry {
  const contextWindow = row.contextWindow ?? row.contextTokens;
  const servingWindow = readModelServingContextWindow(row);
  const contextTokens =
    servingWindow === undefined
      ? row.contextTokens
      : Math.min(servingWindow, row.contextTokens ?? contextWindow ?? Infinity);
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    ...(isCatalogModelApi(row.api) ? { api: row.api } : {}),
    ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
    ...(row.inference ? { inference: row.inference } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(row.contextWindowSource ? { contextWindowSource: row.contextWindowSource } : {}),
    ...(row.contextCapacitySource ? { contextCapacitySource: row.contextCapacitySource } : {}),
    ...(row.contextWindows
      ? { contextWindows: row.contextWindows.map((option) => ({ ...option })) }
      : {}),
    ...(row.contextWindowDefault ? { contextWindowDefault: row.contextWindowDefault } : {}),
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...(row.parameterCount !== undefined ? { parameterCount: row.parameterCount } : {}),
    ...(row.family ? { family: row.family } : {}),
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
    if (entry.nativeRuntime && entry.name !== entry.id) {
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
    if (entry.nativeRuntime) {
      return { ...entry, name: donor.name };
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

/** Projects authored fields while retaining discovery capabilities only for their exact route. */
export function configuredModelCatalogEntry(params: {
  provider: string;
  id: string;
  model: ModelDefinitionConfig;
  providerConfig: ModelProviderConfig;
  accepted?: ModelCatalogEntry;
}): ModelCatalogEntry {
  const { provider: providerId, id, model, providerConfig: provider, accepted } = params;
  const api = model.api ?? accepted?.api ?? provider.api;
  const baseUrl = model.baseUrl ?? accepted?.baseUrl ?? provider.baseUrl;
  const routed =
    accepted && modelTransportRoutesMatch(accepted, { api, baseUrl }) ? accepted : undefined;
  const parameterCount = model.parameterCount ?? routed?.parameterCount;
  const family = model.family ?? routed?.family;
  const name = normalizeOptionalString(model?.name) || id;
  const contextWindow =
    typeof model?.contextWindow === "number" && model.contextWindow > 0
      ? model.contextWindow
      : undefined;
  const contextTokens =
    typeof model?.contextTokens === "number" && model.contextTokens > 0
      ? model.contextTokens
      : undefined;
  const input = model.input;
  const reasoning =
    model.reasoning ?? (isVllmQwenThinkingCompat(providerId, model.compat) ? true : undefined);
  return {
    provider: providerId,
    id,
    name,
    api,
    ...(baseUrl ? { baseUrl } : {}),
    contextWindow,
    contextTokens,
    ...(parameterCount !== undefined ? { parameterCount } : {}),
    ...(family ? { family } : {}),
    ...((model.inference ?? routed?.inference)
      ? { inference: model.inference ?? routed?.inference }
      : {}),
    reasoning,
    ...(typeof model?.reasoning === "boolean" ? { configuredReasoning: model.reasoning } : {}),
    ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    input,
    ...(model.params ? { params: model.params } : {}),
    compat: model.compat,
  };
}
