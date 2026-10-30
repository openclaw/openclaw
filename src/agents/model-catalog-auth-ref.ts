import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { ModelAuthAvailabilityRef } from "./model-auth-availability.types.js";
import { listModelCatalogObservedRoutes } from "./model-catalog-view.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { openAIModelCatalogRoutePolicy } from "./openai-model-routes.js";

type AuthEntry = Pick<ModelCatalogEntry, "provider" | "id" | "api" | "baseUrl">;

/** Account decisions use every observed route, not whichever physical row donated the display label. */
export function resolveModelCatalogAuthRef(
  entry: AuthEntry,
  variants: readonly Pick<ModelCatalogEntry, "api" | "baseUrl">[] = [entry],
): Pick<ModelAuthAvailabilityRef, "modelId" | "api" | "baseUrl" | "observedRoutes"> {
  return {
    modelId: openAIModelCatalogRoutePolicy.resolveIdentity(entry)?.id ?? entry.id,
    // OpenAI's logical model can use Platform or subscription transport; its route owner chooses.
    ...(normalizeProviderId(entry.provider) === "openai"
      ? {}
      : { api: entry.api, baseUrl: entry.baseUrl }),
    observedRoutes: listModelCatalogObservedRoutes(variants),
  };
}
