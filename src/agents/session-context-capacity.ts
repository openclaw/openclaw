import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ModelCatalogSnapshot, ModelCatalogEntry } from "./model-catalog.types.js";
import { modelTransportRoutesMatch } from "./model-compat-catalog.js";
import { resolveModelContextWindowProfile } from "./model-context-window.js";
import { normalizeProviderId } from "./model-selection.js";

/**
 * Current selected capacity for one session, answered only by the session's admitted
 * prepared owner. This is deliberately separate from the last run's persisted budget.
 */
export type SessionContextCapacity =
  | { state: "ready"; contextTokens: number; synthetic: boolean; contextTokensSource?: "resolved" }
  /** Owner-scoped negative state: this owner cannot answer; never another owner's value. */
  | { state: "unavailable" };

export type SessionContextCapacityOwner = {
  isCurrent: () => boolean;
  modelCatalog: Pick<ModelCatalogSnapshot, "entries" | "staticEntries" | "providerOutcomes"> &
    Partial<Pick<ModelCatalogSnapshot, "routeVariants" | "acceptedDiscoveryOrigins">>;
  readFullModelCatalog?: () =>
    | (Pick<ModelCatalogSnapshot, "entries" | "staticEntries" | "providerOutcomes"> &
        Partial<Pick<ModelCatalogSnapshot, "routeVariants" | "acceptedDiscoveryOrigins">>)
    | undefined;
};

export type SessionContextCapacityResolver = (
  provider: string | undefined,
  model: string | undefined,
  selection?: {
    profileId?: string | null;
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
    const modelId = normalizeOptionalString(model) ?? "";
    if (!providerId || !modelId) {
      return undefined;
    }
    let catalog:
      | (Pick<ModelCatalogSnapshot, "entries" | "staticEntries" | "providerOutcomes"> &
          Partial<Pick<ModelCatalogSnapshot, "routeVariants" | "acceptedDiscoveryOrigins">>)
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
      selection?.profileId !== undefined &&
      !catalog?.acceptedDiscoveryOrigins?.some(
        (origin) =>
          normalizeProviderId(origin.provider) === providerId &&
          origin.profileId === (selection.profileId ?? undefined),
      ) &&
      !catalog?.providerOutcomes?.some(
        (outcome) =>
          normalizeProviderId(outcome.provider) === providerId &&
          outcome.profileId === (selection.profileId ?? undefined) &&
          outcome.status === "ready",
      )
    ) {
      return { state: "unavailable" };
    }
    let reported: number | undefined;
    let estimate: number | undefined;
    let selectable = false;
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
        entry.id !== modelId
      ) {
        continue;
      }
      selectable ||= Boolean(entry.contextWindows?.length);
      const tokens = positive(entry.contextTokens);
      const profile = resolveModelContextWindowProfile({
        catalogEntry: entry,
        selected: selection?.contextWindow,
      });
      const window = positive(profile.contextTokens);
      // A real prompt limit is reported even beside an estimated native window.
      const value =
        entry.contextWindowSource === "synthetic" && profile.contextWindow === undefined
          ? tokens
          : tokens !== undefined && window !== undefined
            ? Math.min(tokens, window)
            : (tokens ?? window);
      if (value !== undefined) {
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
        ...(selectable ? { contextTokensSource: "resolved" as const } : {}),
      };
    }
    return estimate === undefined
      ? { state: "unavailable" }
      : { state: "ready", contextTokens: estimate, synthetic: true };
  };
}
