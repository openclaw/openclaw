/** Keeps public and private runtime projections on the same captured catalog. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ModelAuthAvailabilityEvaluation } from "./model-auth-availability.js";
import {
  projectModelCatalogEntryForRoute,
  resolveConfiguredModelCatalogOverrides,
  type ModelCatalogRouteProjection,
} from "./model-catalog-route.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import {
  openAIModelCatalogRoutePolicy,
  resolveModelCatalogIdentityKey,
} from "./openai-model-routes.js";

/** Indexes physical variants for paired logical catalog projection. */
export function createModelCatalogView(params: {
  cfg: OpenClawConfig;
  catalog: ModelCatalogEntry[];
  routeVariants?: readonly ModelCatalogEntry[];
}) {
  const variantsByKey = new Map<string, ModelCatalogEntry[]>();
  for (const entry of params.routeVariants ?? params.catalog) {
    const key = resolveModelCatalogIdentityKey(entry);
    const variants = variantsByKey.get(key) ?? [];
    variants.push(entry);
    variantsByKey.set(key, variants);
  }
  const variantsOf = (entry: Pick<ModelCatalogEntry, "provider" | "id">) =>
    variantsByKey.get(resolveModelCatalogIdentityKey(entry));
  const logicalEntries = new Map<string, ModelCatalogEntry>();
  for (const entry of params.catalog) {
    const key = resolveModelCatalogIdentityKey(entry);
    if (!logicalEntries.has(key)) {
      logicalEntries.set(key, entry);
    }
  }
  return {
    logicalEntries: [...logicalEntries.values()],
    variantsOf,
    project(entry: ModelCatalogEntry, evaluation: ModelAuthAvailabilityEvaluation) {
      const projection: ModelCatalogRouteProjection =
        evaluation.routeResolution === null
          ? { kind: "unmanaged" }
          : evaluation.selectedRoute
            ? {
                kind: "selected",
                route: evaluation.selectedRoute,
                policy: openAIModelCatalogRoutePolicy,
              }
            : { kind: "unresolved", policy: openAIModelCatalogRoutePolicy };
      const variants = variantsOf(entry);
      const overrides = resolveConfiguredModelCatalogOverrides({
        cfg: params.cfg,
        entry,
        policy: openAIModelCatalogRoutePolicy,
      });
      return projectModelCatalogEntryForRoute({
        entry,
        projection,
        ...(variants ? { catalog: variants } : {}),
        ...(overrides ? { overrides } : {}),
      });
    },
  };
}
