import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { supportsOpenAIResponsesFastMode } from "../llm/providers/openai-fast-mode.js";
import type { ModelAuthAvailabilityEvaluation } from "./model-auth-availability.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "./model-catalog.types.js";
import { modelMatchesProviderModelRoute } from "./provider-model-route.js";

/** Account observations are never model metadata donors or native-login readiness. */
export function resolveModelCatalogServiceTiers(params: {
  snapshot: ModelCatalogSnapshot;
  entry: Pick<ModelCatalogEntry, "provider" | "id">;
  evaluation: ModelAuthAvailabilityEvaluation;
  runtimeId?: string;
  modelServiceTiers?: readonly string[];
  isCurrent: () => boolean;
}): string[] | undefined {
  const { snapshot, entry, evaluation, runtimeId } = params;
  const route = evaluation.selectedRoute;
  const credential = evaluation.selectedCredential;
  if (
    !params.isCurrent() ||
    evaluation.availability !== true ||
    !credential ||
    credential.source === "harness" ||
    !route ||
    !runtimeId
  ) {
    return undefined;
  }
  // API-key Responses tiers are a route contract; the ChatGPT catalog cannot describe them.
  if (
    runtimeId === "openclaw" &&
    normalizeProviderId(entry.provider) === "openai" &&
    credential.requirement === "api-key" &&
    route.authRequirement === "api-key" &&
    route.api === "openai-responses" &&
    supportsOpenAIResponsesFastMode({ provider: "openai", ...route })
  ) {
    return [...(params.modelServiceTiers ?? ["priority", "ultrafast"])];
  }
  if (
    credential.source !== "profile" ||
    route.requestTransportOverrides === "present" ||
    snapshot.refreshFailed ||
    snapshot.pendingProviders?.some(
      (provider) => normalizeProviderId(provider) === normalizeProviderId(entry.provider),
    )
  ) {
    return undefined;
  }
  const outcome = snapshot.providerOutcomes?.find(
    (candidate) =>
      normalizeProviderId(candidate.provider) === normalizeProviderId(entry.provider) &&
      candidate.profileId === credential.profileId,
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
