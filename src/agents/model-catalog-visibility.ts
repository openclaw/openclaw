/**
 * Resolves model catalog entries visible to browse/UI surfaces. Visibility
 * combines explicit policy, configured models, defaults, and runtime
 * auth-backed availability.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { ModelAllowList } from "../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { dedupeByKey } from "../shared/dedupe-by-key.js";
import type { ModelAuthAvailabilityEvaluation } from "./model-auth-availability.js";
import { compareModelCatalogEntries } from "./model-catalog-order.js";
import {
  type ModelCatalogRoutePolicy,
  type ModelCatalogRouteProjection,
  projectModelCatalogEntryForRoute,
  createConfiguredModelCatalogOverridesResolver,
} from "./model-catalog-route.js";
import type { ModelCatalogEntry } from "./model-catalog.js";
import {
  RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
  createModelVisibilityPolicy,
  type ModelVisibilityPolicy,
} from "./model-visibility-policy.js";
import { resolveModelCatalogIdentityKey } from "./openai-model-routes.js";

type ModelCatalogVisibilityView = "default" | "configured" | "all";
export type VisibleModelCatalog = { entries: ModelCatalogEntry[]; allowList?: ModelAllowList };

/** Apply selection policy after provider eligibility and route projection, never before counting. */
function applyModelCatalogAllowList(params: {
  policy: ModelVisibilityPolicy;
  catalog: ModelCatalogEntry[];
  agentId?: string;
  selectedModel?: { provider: string; model: string };
}): VisibleModelCatalog {
  if (params.policy.allowAny) {
    return { entries: params.catalog };
  }
  const entries = params.catalog.filter((entry) =>
    params.policy.allows({ provider: entry.provider, model: entry.id }),
  );
  return {
    entries,
    allowList: {
      hiddenCount: params.catalog.length - entries.length,
      settingsPath: params.policy.allowRepairConfigPath.replace(
        "entries.*",
        `entries.${params.agentId}`,
      ),
      ...(params.selectedModel
        ? { selectedModelBlocked: !params.policy.allows(params.selectedModel) }
        : {}),
    },
  };
}

type LogicalModelCatalogEntryState = {
  authBacked: boolean;
  authAuthoritative: boolean;
  compatible: boolean;
  routeProjection: ModelCatalogRouteProjection;
};

/** Maps one shared auth evaluation into logical catalog selection state. */
export function resolveLogicalModelCatalogEntryState(params: {
  evaluation: ModelAuthAvailabilityEvaluation;
  provider?: string;
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
    authAuthoritative: params.evaluation.availabilityAuthoritative === true,
    authBacked:
      params.authBacked ??
      (params.evaluation.availability === true ||
        (!routeManaged &&
          params.evaluation.availabilityAuthoritative !== true &&
          params.provider !== undefined &&
          normalizeProviderId(params.provider) !== "openai" &&
          params.evaluation.availability === undefined &&
          params.evaluation.evidence === "synthetic")),
    compatible: params.evaluation.routeResolution?.kind !== "incompatible",
    routeProjection,
  };
}

function sortModelCatalogEntries(entries: ModelCatalogEntry[]): ModelCatalogEntry[] {
  return entries.toSorted(compareModelCatalogEntries);
}

function isPickerVisibleCatalogEntry(
  entry: ModelCatalogEntry,
  configuredKeys: ReadonlySet<string>,
): boolean {
  // Deprecated and disabled rows stay selectable but are picker-hidden.
  // Exact configured refs always remain visible so pinned models never disappear.
  return (
    (entry.status !== "deprecated" && entry.status !== "disabled") ||
    configuredKeys.has(resolveModelCatalogIdentityKey(entry))
  );
}

type LogicalModelCatalogParams = {
  cfg: OpenClawConfig;
  catalog: ModelCatalogEntry[];
  defaultProvider: string;
  defaultModel?: string;
  agentId?: string;
  workspaceDir?: string;
  sessionKey?: string;
  view?: ModelCatalogVisibilityView;
  includeProvider?: (provider: string) => boolean;
  policy?: ModelVisibilityPolicy;
  routePolicy: ModelCatalogRoutePolicy;
  routeVariants?: readonly ModelCatalogEntry[];
  selectedModel?: { provider: string; model: string };
};

/** Resolves logical rows while keeping provider-owned physical route precedence. */
export async function resolveLogicalVisibleModelCatalog(
  params: LogicalModelCatalogParams & {
    evaluateEntry(
      entry: ModelCatalogEntry,
      routeVariants: readonly ModelCatalogEntry[],
    ): Promise<LogicalModelCatalogEntryState>;
  },
): Promise<VisibleModelCatalog> {
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
): Promise<() => VisibleModelCatalog> {
  const policy =
    params.policy ??
    createModelVisibilityPolicy({
      cfg: params.cfg,
      catalog: params.catalog,
      defaultProvider: params.defaultProvider,
      defaultModel: params.defaultModel,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      ...RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
    });
  const keyOf = resolveModelCatalogIdentityKey;
  const catalog = [...params.catalog, ...policy.configuredCatalog];
  const projectionCatalog = params.routeVariants?.length ? params.routeVariants : params.catalog;
  const routeVariantsByKey = new Map<string, ModelCatalogEntry[]>();
  for (const entry of projectionCatalog) {
    const key = keyOf(entry);
    const variants = routeVariantsByKey.get(key) ?? [];
    variants.push(entry);
    routeVariantsByKey.set(key, variants);
  }
  const variantsOf = (entry: ModelCatalogEntry) => routeVariantsByKey.get(keyOf(entry)) ?? [entry];
  const { configuredKeys, retainedKeys } = policy;
  const readers = new Map<string, () => LogicalModelCatalogEntryState>();
  for (const entry of catalog) {
    const key = keyOf(entry);
    if (!readers.has(key)) {
      const variants = variantsOf(entry);
      readers.set(key, await params.prepareEntry(variants[0] ?? entry, variants));
    }
  }
  const resolveOverrides = createConfiguredModelCatalogOverridesResolver({
    cfg: params.cfg,
    policy: params.routePolicy,
  });
  const projections = new Map<
    ModelCatalogEntry,
    {
      overrides: ReturnType<typeof resolveOverrides>;
      rows: Map<
        | ModelCatalogRouteProjection["kind"]
        | Extract<ModelCatalogRouteProjection, { kind: "selected" }>["route"],
        ModelCatalogEntry
      >;
    }
  >();
  return () => {
    // Membership and row availability consume this one observation after every await.
    const states = new Map([...readers].map(([key, read]) => [key, read()]));
    const getEntryState = (entry: ModelCatalogEntry) => {
      const state = states.get(keyOf(entry));
      if (!state) {
        throw new Error("Model catalog publication omitted prepared entry state");
      }
      return state;
    };
    const projectEntries = (entries: readonly ModelCatalogEntry[]) => {
      const projected = entries.map((entry) => {
        const projection = getEntryState(entry).routeProjection;
        let cached = projections.get(entry);
        if (!cached) {
          cached = {
            overrides: resolveOverrides(entry),
            rows: new Map(),
          };
          projections.set(entry, cached);
        }
        const route = projection.kind === "selected" ? projection.route : projection.kind;
        let row = cached.rows.get(route);
        if (!row) {
          row = projectModelCatalogEntryForRoute({
            entry,
            projection,
            catalog: variantsOf(entry),
            ...(cached.overrides ? { overrides: cached.overrides } : {}),
          }).entry;
          cached.rows.set(route, row);
        }
        return row;
      });
      return sortModelCatalogEntries(dedupeByKey(projected, resolveModelCatalogIdentityKey));
    };
    if (params.view === "all") {
      return {
        entries: projectEntries(params.catalog).filter(
          (entry) => !params.includeProvider || params.includeProvider(entry.provider),
        ),
      };
    }
    const preferred: ModelCatalogEntry[] = [];
    const eligible: ModelCatalogEntry[] = [];
    for (const entry of catalog) {
      const key = keyOf(entry);
      const state = getEntryState(entry);
      const configured =
        retainedKeys.has(key) || (configuredKeys.has(key) && !state.authAuthoritative);
      if ((!state.compatible && !configured) || (!state.authBacked && !configured)) {
        continue;
      }
      eligible.push(entry);
      if (
        state.routeProjection.kind === "selected" &&
        params.routePolicy.matchesRoute(entry, state.routeProjection.route)
      ) {
        preferred.push(entry);
      }
    }
    // Selected physical routes must lead dedupe so sibling metadata cannot win.
    return applyModelCatalogAllowList({
      policy,
      catalog: projectEntries([...preferred, ...eligible]).filter(
        (entry) =>
          isPickerVisibleCatalogEntry(entry, configuredKeys) &&
          (!params.includeProvider || params.includeProvider(entry.provider)),
      ),
      agentId: params.agentId,
      selectedModel: params.selectedModel,
    });
  };
}
