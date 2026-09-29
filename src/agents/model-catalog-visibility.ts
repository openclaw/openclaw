/**
 * Resolves model catalog entries visible to browse/UI surfaces. Visibility
 * combines explicit policy, configured models, defaults, and runtime
 * auth-backed availability.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { dedupeByKey } from "../shared/dedupe-by-key.js";
import type {
  ModelAuthAvailabilityEvaluation,
  ModelAuthAvailabilityRef,
} from "./model-auth-availability.js";
import { compareModelCatalogEntries, orderModelCatalogForPicker } from "./model-catalog-order.js";
import type {
  ModelCatalogRoutePolicy,
  ModelCatalogRouteProjection,
} from "./model-catalog-route.js";
import { createModelCatalogView } from "./model-catalog-view.js";
import type { ModelCatalogEntry } from "./model-catalog.js";
import type { ModelRef } from "./model-ref-shared.js";
import { dedupeModelCatalogEntries } from "./model-selection-shared.js";
import {
  RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
  createModelVisibilityPolicy,
  type ModelVisibilityPolicy,
} from "./model-visibility-policy.js";
import {
  createModelCatalogIdentityKeyResolver,
  resolveModelCatalogIdentityKey,
} from "./openai-model-routes.js";

type ModelCatalogVisibilityView = "default" | "configured" | "all";
export type ModelCatalogAuthChecker = (
  provider: string,
  ref?: ModelAuthAvailabilityRef,
) => boolean | Promise<boolean>;

type LogicalModelCatalogEntryState = {
  authBacked: boolean;
  compatible: boolean;
  routeManaged: boolean;
  routeProjection: ModelCatalogRouteProjection;
  nativeRuntime?: string;
};

/** Maps one shared auth evaluation into logical catalog selection state. */
export function resolveLogicalModelCatalogEntryState(params: {
  evaluation: ModelAuthAvailabilityEvaluation;
  authBacked?: boolean;
  routePolicy: ModelCatalogRoutePolicy;
}): LogicalModelCatalogEntryState {
  const routeManaged = params.evaluation.routeResolution !== null;
  const selectedRoute = params.evaluation.selectedRoute;
  const routeProjection: ModelCatalogRouteProjection = !routeManaged
    ? { kind: "unmanaged" }
    : selectedRoute
      ? { kind: "selected", route: selectedRoute, policy: params.routePolicy }
      : { kind: "unresolved", policy: params.routePolicy };
  return {
    authBacked: params.authBacked ?? params.evaluation.availability === true,
    compatible: params.evaluation.routeResolution?.kind !== "incompatible",
    routeManaged,
    routeProjection,
    ...(params.evaluation.runtimeAuth ? { nativeRuntime: params.evaluation.runtimeAuth.id } : {}),
  };
}

function sortModelCatalogEntries(entries: ModelCatalogEntry[]): ModelCatalogEntry[] {
  return entries.toSorted(compareModelCatalogEntries);
}

type LogicalModelCatalogParams = {
  cfg: OpenClawConfig;
  catalog: ModelCatalogEntry[];
  defaultProvider: string;
  defaultModel?: string | ModelRef;
  agentId?: string;
  workspaceDir?: string;
  view?: ModelCatalogVisibilityView;
  policy?: ModelVisibilityPolicy;
  routePolicy: ModelCatalogRoutePolicy;
  routeVariants?: readonly ModelCatalogEntry[];
  retainedModel?: ModelRef;
  selectedModel?: ModelRef;
  metadataSnapshot?: PluginMetadataSnapshot;
};

/** Resolves logical rows while keeping provider-owned physical route precedence. */
export async function resolveLogicalVisibleModelCatalog(
  params: LogicalModelCatalogParams & {
    evaluateEntry(
      entry: ModelCatalogEntry,
      routeVariants: readonly ModelCatalogEntry[],
    ): Promise<LogicalModelCatalogEntryState>;
  },
): Promise<ModelCatalogEntry[]> {
  const read = await prepareLogicalVisibleModelCatalog({
    ...params,
    prepareEntry: async (entry, variants) => {
      const state = await params.evaluateEntry(entry, variants);
      return () => state;
    },
  });
  return read();
}

/** Prepare host facts once; observe revocable state only in the synchronous publication. */
export async function prepareLogicalVisibleModelCatalog(
  params: LogicalModelCatalogParams & {
    prepareEntry(
      entry: ModelCatalogEntry,
      routeVariants: readonly ModelCatalogEntry[],
    ): Promise<() => LogicalModelCatalogEntryState>;
  },
): Promise<() => ModelCatalogEntry[]> {
  const policy =
    params.policy ??
    createModelVisibilityPolicy({
      cfg: params.cfg,
      catalog: params.catalog,
      defaultProvider: params.defaultProvider,
      defaultModel: params.defaultModel,
      agentId: params.agentId,
      ...RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
    });
  const keyOf = createModelCatalogIdentityKeyResolver();
  const catalogView = createModelCatalogView({
    cfg: params.cfg,
    catalog: params.catalog,
    routeVariants: params.routeVariants?.length ? params.routeVariants : params.catalog,
    routePolicy: params.routePolicy,
    keyOf,
  });
  const { configuredKeys, retainedKeys } = policy;
  const retainedKey = params.retainedModel
    ? keyOf({ provider: params.retainedModel.provider, id: params.retainedModel.model })
    : undefined;
  const retained = params.catalog.filter(
    (entry) => retainedKeys.has(keyOf(entry)) || keyOf(entry) === retainedKey,
  );
  const wildcard = policy.allowAny || policy.hasProviderWildcards;
  const configuredCatalog = wildcard ? sortModelCatalogEntries([...policy.configuredCatalog]) : [];
  const candidates =
    params.view === "all"
      ? params.catalog
      : [
          ...(wildcard ? params.catalog : []),
          ...configuredCatalog,
          ...policy.allowedCatalog,
          ...retained,
        ];
  const readers = new Map<string, () => LogicalModelCatalogEntryState>();
  for (const entry of candidates) {
    // Preparation can mutate later rows or replace the policy owner across each await.
    const key = resolveModelCatalogIdentityKey(entry);
    if (!readers.has(key)) {
      const variants = catalogView.variantsOf(entry, key) ?? [entry];
      readers.set(key, await params.prepareEntry(variants[0] ?? entry, variants));
    }
  }
  const { buildManifestBuiltInModelSuppressionResolver } =
    await import("../plugins/manifest-model-suppression.js");
  const suppression = buildManifestBuiltInModelSuppressionResolver({
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    metadataSnapshot: params.metadataSnapshot,
  });
  const catalogKeys = new Set(params.catalog.map(createModelCatalogIdentityKeyResolver()));
  return () => {
    // Membership and row availability consume this one observation after every await.
    const states = new Map([...readers].map(([key, read]) => [key, read()]));
    const publicationKeyOf = createModelCatalogIdentityKeyResolver();
    const getEntryState = (entry: ModelCatalogEntry) => {
      const state = states.get(publicationKeyOf(entry));
      if (!state) {
        throw new Error("Model catalog publication omitted prepared entry state");
      }
      return state;
    };
    const projectEntries = (entries: readonly ModelCatalogEntry[]) => {
      const projected = entries.flatMap((entry) => {
        const state = getEntryState(entry);
        const row = catalogView.readProjection(
          entry,
          state.routeProjection,
          publicationKeyOf(entry),
        ).entry;
        // A selected native runtime owns its opaque model; a donor label does not.
        if (
          !state.nativeRuntime &&
          suppression({ provider: row.provider, id: row.id, api: row.api, baseUrl: row.baseUrl })
            ?.retirement
        ) {
          return [];
        }
        return [row];
      });
      return orderModelCatalogForPicker(
        dedupeByKey(projected, publicationKeyOf),
        params.selectedModel ?? params.retainedModel,
      );
    };
    if (params.view === "all") {
      return projectEntries(params.catalog);
    }
    const defaultVisibleCatalog = wildcard
      ? sortModelCatalogEntries(
          dedupeModelCatalogEntries([
            ...configuredCatalog,
            ...params.catalog.filter((entry) => getEntryState(entry).authBacked),
          ]),
        )
      : [];
    const visible = sortModelCatalogEntries(
      dedupeModelCatalogEntries(
        policy.visibleCatalog({
          catalog: params.catalog,
          defaultVisibleCatalog,
          view: params.view,
        }),
      ),
    ).filter(
      (entry) =>
        catalogKeys.has(publicationKeyOf(entry)) || configuredKeys.has(publicationKeyOf(entry)),
    );
    const preferredKeys = new Set([...visible, ...retained].map(publicationKeyOf));
    const preferred: ModelCatalogEntry[] = [];
    const routeBacked = new Set<ModelCatalogEntry>();
    for (const entry of params.catalog) {
      const key = publicationKeyOf(entry);
      const preferredKey = preferredKeys.has(key);
      const wildcardRoute =
        policy.allowAny ||
        (policy.hasProviderWildcards &&
          policy.allowsByWildcard({ provider: entry.provider, model: entry.id }));
      if (!preferredKey && !wildcardRoute) {
        continue;
      }
      const state = getEntryState(entry);
      if (!state.compatible && !configuredKeys.has(key)) {
        continue;
      }
      if (
        preferredKey &&
        state.routeProjection.kind === "selected" &&
        params.routePolicy.matchesRoute(entry, state.routeProjection.route)
      ) {
        preferred.push(entry);
      }
      if (wildcardRoute && state.routeManaged && state.authBacked) {
        routeBacked.add(entry);
      }
    }
    const kept = visible.filter((entry) => {
      const state = getEntryState(entry);
      const configured = configuredKeys.has(publicationKeyOf(entry));
      return (
        (state.compatible || configured) &&
        (!state.routeManaged || configured || routeBacked.has(entry))
      );
    });
    // Selected physical routes must lead dedupe so sibling metadata cannot win.
    // Deprecated/disabled rows stay selectable; configured and current refs remain picker-visible.
    return projectEntries([...preferred, ...kept, ...retained, ...routeBacked]).filter(
      (entry) =>
        (params.view === "configured" ||
          policy.allows({ provider: entry.provider, model: entry.id })) &&
        (publicationKeyOf(entry) === retainedKey ||
          (entry.status !== "deprecated" && entry.status !== "disabled") ||
          configuredKeys.has(publicationKeyOf(entry))),
    );
  };
}
