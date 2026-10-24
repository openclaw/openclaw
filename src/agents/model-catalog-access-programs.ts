import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { CyberAccessProgram } from "../../packages/gateway-protocol/src/schema/sessions-row.js";
import type { ModelAuthAvailabilityEvaluation } from "./model-auth-availability.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "./model-catalog.types.js";
import { modelMatchesProviderModelRoute } from "./provider-model-route.js";

/** Missing metadata is unknown. Neither model presence nor auth type grants a program. */
export function resolveModelCatalogAccessPrograms(params: {
  snapshot: ModelCatalogSnapshot;
  entry: Pick<ModelCatalogEntry, "provider" | "id">;
  evaluation: ModelAuthAvailabilityEvaluation;
  runtimeId: string;
  isCurrent: () => boolean;
}): CyberAccessProgram[] | undefined {
  const { snapshot, entry, evaluation, runtimeId } = params;
  if (
    !params.isCurrent() ||
    evaluation.availability !== true ||
    snapshot.refreshFailed ||
    snapshot.pendingProviders?.some(
      (provider) => normalizeProviderId(provider) === normalizeProviderId(entry.provider),
    )
  ) {
    return undefined;
  }
  const native =
    evaluation.runtimeAuth?.id === runtimeId && evaluation.runtimeAuth.source === "native";
  const credential = evaluation.selectedCredential;
  const route = evaluation.selectedRoute;
  if (
    !native &&
    (!credential ||
      credential.source !== "profile" ||
      !route ||
      route.requestTransportOverrides === "present")
  ) {
    return undefined;
  }
  const outcomes = native
    ? snapshot.nativeProviderOutcomes?.[runtimeId]
    : snapshot.providerOutcomes;
  const outcome = outcomes?.find(
    (candidate) =>
      normalizeProviderId(candidate.provider) === normalizeProviderId(entry.provider) &&
      (native ||
        (credential?.source === "profile" && candidate.profileId === credential.profileId)),
  );
  if (outcome?.status !== "ready") {
    return undefined;
  }
  const observation = outcome.modelAccessPrograms?.find(
    (candidate) =>
      candidate.modelId === entry.id &&
      candidate.runtimeId === runtimeId &&
      (native ||
        (route &&
          candidate.api !== undefined &&
          candidate.baseUrl !== undefined &&
          modelMatchesProviderModelRoute({
            provider: entry.provider,
            api: candidate.api,
            baseUrl: candidate.baseUrl,
            route,
          }))),
  );
  return observation ? [...observation.cyber] : undefined;
}

/** Row projection keeps unknown access absent instead of advertising an empty program list. */
export function projectModelCatalogAccessPrograms(
  params: Parameters<typeof resolveModelCatalogAccessPrograms>[0],
): { availableAccessPrograms?: { cyber: CyberAccessProgram[] } } {
  const cyber = resolveModelCatalogAccessPrograms(params);
  return cyber === undefined ? {} : { availableAccessPrograms: { cyber } };
}
