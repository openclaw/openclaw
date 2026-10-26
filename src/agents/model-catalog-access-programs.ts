import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { CyberAccessProgram } from "../../packages/gateway-protocol/src/schema/sessions-row.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ModelAuthAvailabilityEvaluation } from "./model-auth-availability.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "./model-catalog.types.js";
import { resolveConfiguredCyberAccessProgram } from "./model-extra-params.js";
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
      credential.source === "harness" ||
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
        (credential?.source === "profile"
          ? candidate.profileId === credential.profileId
          : credential?.source === "direct" && candidate.profileId === undefined)),
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

/** The application baseline and configured inheritance do not grant Daybreak entitlement. */
export function projectModelCatalogAccessPrograms(
  params: Parameters<typeof resolveModelCatalogAccessPrograms>[0] & {
    config: OpenClawConfig;
    agentId?: string;
  },
): {
  availableAccessPrograms?: { cyber: CyberAccessProgram[] };
  cyberAccessProgramDefault?: CyberAccessProgram;
} {
  const cyber = resolveModelCatalogAccessPrograms(params);
  const { entry, evaluation, runtimeId } = params;
  const route = evaluation.selectedRoute;
  const consumesAccessPrograms =
    normalizeProviderId(entry.provider) === "openai" &&
    (runtimeId === "codex" ||
      (runtimeId === "openclaw" &&
        route !== undefined &&
        (route.api === "openai-responses" || route.api === "openai-chatgpt-responses") &&
        modelMatchesProviderModelRoute({
          provider: entry.provider,
          api: route.api,
          baseUrl: route.baseUrl,
          route: {
            ...route,
            baseUrl:
              route.api === "openai-responses"
                ? "https://api.openai.com/v1"
                : "https://chatgpt.com/backend-api/codex",
          },
        })));
  const cyberAccessProgramDefault = consumesAccessPrograms
    ? (resolveConfiguredCyberAccessProgram({
        config: params.config,
        agentId: params.agentId,
        provider: entry.provider,
        modelId: entry.id,
      }) ?? "standard")
    : undefined;
  return {
    ...(cyber === undefined ? {} : { availableAccessPrograms: { cyber } }),
    ...(cyberAccessProgramDefault === undefined ? {} : { cyberAccessProgramDefault }),
  };
}
