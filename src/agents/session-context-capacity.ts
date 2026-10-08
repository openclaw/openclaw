import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveConfiguredContextTokenLimits } from "./context-resolution.js";
import type { ModelCatalogSnapshot, ModelCatalogEntry } from "./model-catalog.types.js";
import { modelTransportRoutesMatch } from "./model-compat-catalog.js";
import { resolveModelContextWindowProfile } from "./model-context-window.js";
import { normalizeProviderId } from "./model-selection.js";

/**
 * Current selected capacity for one session, answered only by the session's admitted
 * prepared owner. This is deliberately separate from the last run's persisted budget.
 */
export type SessionContextCapacity =
  | { state: "ready"; contextTokens: number; synthetic: boolean; contextTokenLimit?: number }
  /** Owner-scoped negative state: this owner cannot answer; never another owner's value. */
  | { state: "unavailable" };

export type SessionContextCapacityOwner = {
  config?: OpenClawConfig;
  isCurrent: () => boolean;
  modelCatalog: Pick<ModelCatalogSnapshot, "entries" | "staticEntries" | "providerOutcomes"> &
    Partial<Pick<ModelCatalogSnapshot, "routeVariants">>;
  readFullModelCatalog?: () =>
    | (Pick<ModelCatalogSnapshot, "entries" | "staticEntries" | "providerOutcomes"> &
        Partial<Pick<ModelCatalogSnapshot, "routeVariants">>)
    | undefined;
};

export type SessionContextCapacityResolver = (
  provider: string | undefined,
  model: string | undefined,
  selection?: {
    profileId?: string;
    route?: Pick<ModelCatalogEntry, "api" | "baseUrl">;
    nativeRuntime?: string;
    contextWindow?: string;
  },
) => SessionContextCapacity | undefined;

function positive(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Binds capacity lookups to one prepared owner; the owner must stay current per read. */
export function createSessionContextCapacityResolver(
  owner: SessionContextCapacityOwner | undefined,
): SessionContextCapacityResolver {
  return (provider, model, selection) => {
    const providerId = provider ? normalizeProviderId(provider) : "";
    const modelId = normalizeLowercaseStringOrEmpty(model);
    if (!providerId || !modelId) {
      return undefined;
    }
    let catalog:
      | (Pick<ModelCatalogSnapshot, "entries" | "staticEntries" | "providerOutcomes"> &
          Partial<Pick<ModelCatalogSnapshot, "routeVariants">>)
      | undefined;
    try {
      // Failed, cancelled, retired or unbound preparation settles here as unavailable.
      if (!owner?.isCurrent()) {
        return { state: "unavailable" };
      }
      // Accepted inventory only; this passive read never starts or renews discovery.
      catalog = owner.readFullModelCatalog?.() ?? owner.modelCatalog;
      if (!owner.isCurrent()) {
        return { state: "unavailable" };
      }
    } catch {
      return { state: "unavailable" };
    }
    if (
      selection?.profileId &&
      !catalog?.providerOutcomes?.some(
        (outcome) =>
          normalizeProviderId(outcome.provider) === providerId &&
          outcome.profileId === selection.profileId &&
          outcome.status === "ready",
      )
    ) {
      return { state: "unavailable" };
    }
    const { fixedContextWindow } = resolveConfiguredContextTokenLimits({
      cfg: owner?.config,
      provider: providerId,
      model: modelId,
      nativeRuntime: selection?.nativeRuntime,
    });
    let reported: number | undefined;
    let estimate: number | undefined;
    let contextTokenLimit: number | undefined;
    let nativeRoute: ModelCatalogEntry | undefined;
    for (const entry of [
      ...(catalog?.routeVariants ?? []),
      ...(catalog?.entries ?? []),
      ...(catalog?.staticEntries ?? []),
    ]) {
      if (
        (selection?.route && !modelTransportRoutesMatch(entry, selection.route)) ||
        (selection?.nativeRuntime && entry.nativeRuntime !== selection.nativeRuntime) ||
        (!selection?.nativeRuntime && Boolean(entry.nativeRuntime)) ||
        normalizeProviderId(entry.provider) !== providerId ||
        normalizeLowercaseStringOrEmpty(entry.id) !== modelId
      ) {
        continue;
      }
      if (selection?.nativeRuntime && !selection.route) {
        if (
          nativeRoute &&
          (!modelTransportRoutesMatch(nativeRoute, entry) ||
            !modelTransportRoutesMatch(entry, nativeRoute))
        ) {
          return { state: "unavailable" };
        }
        nativeRoute ??= entry;
      }
      const tokens = positive(entry.contextTokens);
      const profile = resolveModelContextWindowProfile({
        catalogEntry: entry,
        selected: selection?.contextWindow,
      });
      const window = positive(
        profile.contextWindow
          ? profile.contextTokens
          : (fixedContextWindow ?? profile.contextTokens),
      );
      // A real prompt limit is reported even beside an estimated native window.
      const value =
        entry.contextWindowSource === "synthetic" &&
        profile.contextWindow === undefined &&
        fixedContextWindow === undefined
          ? tokens
          : tokens !== undefined && window !== undefined
            ? Math.min(tokens, window)
            : (tokens ?? window);
      if (value !== undefined) {
        if (tokens !== undefined || profile.contextWindow !== undefined) {
          contextTokenLimit =
            contextTokenLimit === undefined ? value : Math.min(contextTokenLimit, value);
        }
        reported = reported === undefined ? value : Math.min(reported, value);
      } else if (window !== undefined) {
        estimate = estimate === undefined ? window : Math.min(estimate, window);
      }
    }
    if (reported !== undefined) {
      return {
        state: "ready",
        contextTokens: reported,
        synthetic: false,
        ...(contextTokenLimit !== undefined ? { contextTokenLimit } : {}),
      };
    }
    return estimate === undefined
      ? { state: "unavailable" }
      : { state: "ready", contextTokens: estimate, synthetic: true };
  };
}
