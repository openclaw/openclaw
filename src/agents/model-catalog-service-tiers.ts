import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { ModelAuthAvailabilityEvaluation } from "./model-auth-availability.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "./model-catalog.types.js";
import { modelMatchesProviderModelRoute } from "./provider-model-route.js";

/** Account observations are never model metadata donors or native-login readiness. */
export function resolveModelCatalogServiceTiers(params: {
  snapshot: ModelCatalogSnapshot;
  entry: Pick<ModelCatalogEntry, "provider" | "id">;
  evaluation: ModelAuthAvailabilityEvaluation;
  runtimeId?: string;
  isCurrent: () => boolean;
}): string[] | undefined {
  const { snapshot, entry, evaluation, runtimeId } = params;
  const route = evaluation.selectedRoute;
  if (
    !params.isCurrent() ||
    snapshot.refreshFailed ||
    evaluation.availability !== true ||
    !evaluation.selectedProfileId ||
    !route ||
    route.requestTransportOverrides === "present" ||
    !runtimeId ||
    snapshot.pendingProviders?.some(
      (provider) => normalizeProviderId(provider) === normalizeProviderId(entry.provider),
    )
  ) {
    return undefined;
  }
  const outcome = snapshot.providerOutcomes?.find(
    (candidate) =>
      normalizeProviderId(candidate.provider) === normalizeProviderId(entry.provider) &&
      candidate.profileId === evaluation.selectedProfileId,
  );
  if (outcome?.status !== "ready") {
    return undefined;
  }
  const observation = outcome.modelServiceTiers?.find(
    (candidate) =>
      candidate.modelId === entry.id &&
      candidate.runtimeId === runtimeId &&
      modelMatchesProviderModelRoute({
        provider: entry.provider,
        api: candidate.api,
        baseUrl: candidate.baseUrl,
        route,
      }),
  );
  return observation ? [...observation.serviceTiers] : undefined;
}
